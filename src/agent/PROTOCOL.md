# Workbench agent protocol

The agent in `src/agent` is an ACP agent. The app talks to it as it talks to Grok Build and Claude Code.
This file says exactly what it takes and what it sends.

## Process and transport

- Entry `src/agent/main.ts`, built to `out/main/workbenchAgent.js` (CommonJS, no `electron` import).
- Newline-delimited JSON-RPC 2.0, one message per line.
- Input: with `process.parentPort` (Electron utility process) the messages `{ data: string | null }` on the
  parent port, where `data` is a chunk of text and `null` ends the input; otherwise `process.stdin`.
- Output: `process.stdout`. Logs: `process.stderr` only. Keys and environment values are never logged.
- End of input closes every session (MCP servers and running commands are stopped) and the process exits.
- Env `WB_AGENT_HOME`: the folder for transcripts, `<WB_AGENT_HOME>/<sessionId>.jsonl`. Without it nothing is
  persisted and `session/load` fails.
- Many sessions run side by side in one process; each has its own model, mode, MCP servers and turn.

## Methods the app calls

| Method | Params | Result |
|---|---|---|
| `initialize` | any | `{ protocolVersion: 1, agentInfo: { name: 'workbench-agent', title: 'Datapad Workbench agent', version }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true, sse: true } }, authMethods: [] }` |
| `session/new` | `{ cwd, mcpServers, _meta }` | `{ sessionId, modes }` |
| `session/load` | `{ sessionId, cwd, mcpServers, _meta }` | `{ modes }`, after the replay (below) |
| `session/prompt` | `{ sessionId, prompt: [{ type: 'text', text } \| { type: 'image', mimeType, data }] }` (a `resource` block's text and a `resource_link`'s uri are taken as text; a prompt with none of these is error -32602) | `{ stopReason: 'end_turn' \| 'max_tokens' \| 'cancelled' }` |
| `session/cancel` (notification) | `{ sessionId }` | none; the running prompt resolves with `stopReason: 'cancelled'`. Sent with an id it answers `{}` |
| `session/set_mode` | `{ sessionId, modeId }` | `{}`; unknown mode id is error -32602 |
| `session/set_config_option` | `{ sessionId, configId: 'model', value: <model key> }` or `{ sessionId, configId: 'reasoning_effort', value: <string> }` (`{ value: { value } }` is also taken; `''` clears the effort) | `{}`; another `configId` is error -32602 |
| `session/close` | `{ sessionId }` | `{}`; the transcript stays on disk and can be loaded again |
| `_workbench/providers` (notification) | `{ providers }`, see below | none |

There is no `authenticate`. Any other method with an id answers `{ code: -32601, message: 'Method not found: <method>' }`.
A request for a session id the process does not hold answers `{ code: -32602, message: 'Unknown session: <id>' }`.
A second `session/prompt` while one runs on the same session answers `{ code: -32000, message: 'A turn is already running in this session' }`.
A prompt while no provider has a model answers `{ code: -32000, message: 'No model is set up. Add a provider with a model in Settings.' }`.

`modes` is always
`{ currentModeId, availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] }`.
A new or loaded session starts in `_meta.workbench.mode` when that is given, else in `default`.

### `_workbench/providers`

```
{ providers: [{ id, name, backend: 'chat_completions' | 'responses' | 'messages', baseUrl, apiKey,
    headers?: Record<string, string>,
    models: [{ key, id, name, contextWindow?: number, efforts?: string[], images?: boolean }] }] }
```

Replaces the whole list. Held in memory only. Sent after `initialize` and whenever providers change; a running
turn keeps the provider it started its current model call with, the next call uses the new list.
`images: false` on a model is an addition to the contract: the agent then sends that model no image content
(a prompt image or an image a tool returns becomes a line of text saying an image was left out). Without the
field images are sent.

- `chat_completions` and `responses`: `POST <baseUrl>/chat/completions`, `Authorization: Bearer <apiKey>` when
  there is a key. Effort goes as `reasoning_effort` (`max` is sent as `xhigh`). The Responses API itself is
  not spoken: a `responses` provider must also serve Chat Completions (OpenAI does).
- An effort is sent only to a model whose `efforts` lists it; for any other model the session's effort is
  left out of the request, so a model without reasoning is not refused by its API.
- `messages`: `POST <baseUrl>/messages`, `anthropic-version: 2023-06-01`; the key in `x-api-key` when the host
  is `api.anthropic.com`, else as a bearer token. Effort goes as `thinking: { type: 'adaptive', display:
  'summarized' }` with `output_config: { effort }`; without an effort neither field is sent.
- A model that refuses the effort: when a call with an effort fails with HTTP 400 and the provider's message
  names `thinking`, `output_config` or `effort` (Messages) or `reasoning` (Chat Completions, which covers
  `reasoning_effort`), that call is sent once more without the effort fields, and the model (its endpoint
  and id) gets no effort for the rest of the process. Any other 400 fails the call as before.
- `headers` are added to every request of the provider.
- 429 and 5xx are tried again up to 3 times, after `Retry-After` when given (at most 30 s), else 1 s, 2 s, 4 s.

### `session/new` and `session/load` params

- `cwd`: the project folder. Relative tool paths resolve against it and the shell starts in it.
- `mcpServers`: ACP shape, as `toAcpMcpServers` makes it:
  `{ type: 'stdio', name, command, args, env: [{ name, value }] }` (a missing `type` is stdio) and
  `{ type: 'http' | 'sse', name, url, headers: [{ name, value }] }`.
  A server that fails to start is reported on stderr and left out; the session still starts.
- `_meta.rules`: string, goes into the system prompt as session rules.
- `_meta.workbench`:
  - `model?`: model key. Without it, or with a key no provider has, the first model of the first provider is used.
  - `effort?`: reasoning effort, sent when the model's `efforts` lists it (see above).
  - `env?`: extra environment for the shell tool. Held in memory, not stored and not logged (but see the
    transcript's note on command output).
  - `skillsDir?`: a folder of `<name>/SKILL.md`. Name and description (from the frontmatter) are listed in
    the system prompt with the file's path; the model reads the file with `read_file` when a skill applies.
  - `ephemeral?`: `true` writes no transcript.
  - `tools?`: `false` gives the model no tools and connects no MCP server.
  - `mode?`: `'default'` or `'plan'`, the mode the session starts in, on new and on load; any other value
    is ignored. It is the same as a `session/set_mode` right after, without the `current_mode_update`.

`session/load` reads `<WB_AGENT_HOME>/<sessionId>.jsonl` (error `-32602 Unknown session` when it is missing,
or when the id holds anything but letters, digits, `_` and `-`), closes a live session of the same id first,
and replays every stored message in order as `session/update`
notifications before it resolves:

- a user text: `{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }`
- an assistant text: `agent_message_chunk`; assistant reasoning: `agent_thought_chunk`. As in the live turn
  (see Text of a turn), the first text of a later assistant message of the same turn starts with `\n\n`,
  and so does its first reasoning; a user text starts a new turn.
- a tool call: one `tool_call` (shape below) with its final `status` (`completed` or `failed`), `content`
  and `rawOutput`. No `tool_call_update` is replayed. A replayed `write_file` diff has `oldText: null`: the
  file as it was is not kept.
- a `todo_write` call: the `plan` update it sent.

Images are not replayed. A turn that was cut off (the process died) left tool calls without a result: they
replay as `failed` with "Interrupted", and that result is added to the transcript so the history is valid.

Model, effort and mode are not stored: the app sets them again on load (`_meta.workbench` takes all three).

## Notifications the agent sends

All are `session/update` with params `{ sessionId, update }`. `update` is one of:

```
{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }
{ sessionUpdate: 'user_message_chunk',  content: { type: 'text', text } }            // load replay only

{ sessionUpdate: 'tool_call', toolCallId, name, title, kind, status: 'pending',
  rawInput, locations: [{ path }], _meta: { 'x.ai/tool': { name } } }

{ sessionUpdate: 'tool_call_update', toolCallId, name, title, kind,
  status: 'in_progress' }
{ sessionUpdate: 'tool_call_update', toolCallId, name, title, kind,
  status: 'completed' | 'failed', content: [...], rawOutput: { output: string } }

{ sessionUpdate: 'plan', entries: [{ content, status: 'pending' | 'in_progress' | 'completed', priority: 'medium' }] }

{ sessionUpdate: 'usage_update', used, size }
{ sessionUpdate: 'auto_compact_started', tokens_used, context_window }
{ sessionUpdate: 'auto_compact_completed', tokens_after }
{ sessionUpdate: 'current_mode_update', currentModeId }
{ sessionUpdate: 'turn_completed', stopReason }
{ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description, input: { hint } }] }
```

### Text of a turn

The app joins a turn's chunks into one text. So within one turn, the first `agent_thought_chunk` of a model
call that follows reasoning of an earlier model call starts with `\n\n`, and the same for the first
`agent_message_chunk` after text of an earlier call (text before and after tool calls). The first chunk of a
turn has no such start. The model's history and the transcript keep each call's text without it.

### Slash commands

`available_commands_update` is sent after the result of every `session/new` and `session/load` (after the
replay), with the one command the agent has: `compact` (`/compact`).

A prompt whose text, trimmed, is `/compact` or `/compact <instructions>` (text blocks only) is not sent to
the model. The context is compacted at once as in Usage and context, whatever `used` is, with the
instructions added to the summary request. The turn sends `auto_compact_started`, `auto_compact_completed`,
a `usage_update` with the new `used`, one `agent_message_chunk` line (`Compacted the conversation from <n> to
<m> tokens.`, or that the model wrote no summary), then `turn_completed` with `end_turn`. With nothing in the
context yet it sends only the line `There is nothing to compact yet.` and `turn_completed`. The command and
its line are not stored; the `compact` line is. A failed summary call fails the prompt like any model call;
a cancel ends it with `cancelled`.

### Tool calls

`toolCallId` is `call-<n>`, unique in the session (a load numbers the replayed calls again from 1).
`name` is the tool's name as the model calls it, also in
`_meta['x.ai/tool'].name`, which is where the app's `toolCallName` reads it (so a bot's allowed-tools list
works unchanged; an MCP tool is already `mcp__<server>__<tool>` there).
`content` items are `{ type: 'content', content: { type: 'text', text } }`,
`{ type: 'content', content: { type: 'image', mimeType, data } }` or, for `write_file` and `edit_file`,
`{ type: 'diff', path, oldText, newText }`. For `write_file` the diff is the whole file (`oldText: null` for
a new one); for `edit_file` it is `old_string` and `new_string`, not the whole file.
Every path in `rawInput` (`file_path`, `path`) and in `locations` is absolute.

| Tool (`name`) | `kind` | `title` | `rawInput` | Asks permission |
|---|---|---|---|---|
| `read_file` | `read` | `Read <path>` | `{ file_path, offset?, limit? }` | no |
| `write_file` | `edit` | `Write <path>` | `{ file_path, content }` | yes |
| `edit_file` | `edit` | `Edit <path>` | `{ file_path, old_string, new_string, replace_all? }` | yes |
| `list_files` | `search` | `List <pattern or path>` | `{ path, pattern? }` | no |
| `grep` | `search` | `Grep <pattern>` | `{ pattern, path, glob? }` | no |
| `run_command` | `execute` | the command's first line | `{ command, timeout_ms? }` | yes |
| `fetch_url` | `fetch` | `Fetch <url>` | `{ url }` | no |
| `mcp__<server>__<tool>` | `other` | `<server>: <tool>` | the tool's arguments | yes, unless the server marks the tool `readOnlyHint` |
| `todo_write` | (no tool call is shown) | | | no; it sends a `plan` update with the whole list |
| `task` | `think` | `Task: <description>` | `{ description, prompt }` | no; the calls it makes ask as usual |

Titles show a path relative to `cwd` when it is inside it. A tool the model names that does not exist (or
that the mode hides), or arguments that are not valid JSON, show as a `tool_call` of kind `other` that
fails at once (pending, then failed); the model is told why and goes on.

`run_command` runs through the system shell in `cwd` with the agent's environment plus
`_meta.workbench.env`, in its own process group, without stdin. Default timeout 120 s, at most 600 s; the
last 30000 characters of output are kept. A non-zero exit, a timeout or a cancel is `failed`.
`grep` uses `rg` when it is on PATH and a JavaScript search otherwise.

Order for one call: `tool_call` (pending) → `session/request_permission` when the tool asks →
`tool_call_update` (in_progress) → `tool_call_update` (completed | failed). A refused call goes straight to
`failed`.

Calls of one model reply: those that ask no permission and change nothing (`read_file`, `list_files`,
`grep`, `fetch_url`, an MCP tool marked `readOnlyHint`, `task`, and a call that fails at once) run at the
same time when they follow each other. Every other call (`write_file`, `edit_file`, `run_command`,
`todo_write`, any other MCP tool) waits for all calls before it, and the calls after it wait for it; so
changes run one after another in the model's order, and a read the model put after a write sees it. The
`tool_call` (pending) updates come in the model's order; the updates of calls that run together interleave.
The results go back to the model in the model's order. A cancel still gives every call a result.

### `task`

A `task` call runs a subagent: a model loop of its own on a fresh context whose only message is `prompt`,
with the session's model, effort, cwd, mode, `env`, rules, skills and tools, minus `task` and `todo_write`,
and a system prompt that tells it its last reply is its report. Its tool calls are ordinary `tool_call`
updates of the same session (same `call-<n>` numbering), between the `task` call's `in_progress` and its
end, and ask permission like any other call. Its text and reasoning are not streamed, and it sends no
`usage_update`. The `task` call completes with the subagent's last text as its result
(`(The subagent gave no answer.)` when there is none); a failed model call of the subagent fails the `task`
call with that error, not the prompt. A cancel stops it (`failed`, "Cancelled"). Only the `task` call and
its result go into the history and the transcript, so a load replays the `task` call and none of the
subagent's calls. A subagent is not compacted: when its context gets too long, its model call fails.

### Permission requests

A request from the agent to the app:

```
method: 'session/request_permission'
params: { sessionId,
  toolCall: { toolCallId, name, title, kind, rawInput, locations, _meta },   // as in the tool_call update
  options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
            { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' }] }
result: { outcome: { outcome: 'selected', optionId } } | { outcome: { outcome: 'cancelled' } }
```

Only `allow_once` runs the tool. `reject_once`, `cancelled`, another option id or an error answer are a
refusal: the tool does not run and the model gets "The user refused this tool call." as its result.
The agent keeps no allow rules, so it asks for every call; the app's permission mode decides.
The app is asked before the file is touched, so `snapshotBeforeTool` sees `kind`, `locations` and `rawInput`
of the edit first.

### Modes

- `default`: every tool.
- `plan`: the model is not given `write_file`, `edit_file` and `run_command`, and is told to plan only.
  MCP tools stay; they still ask permission, so the app refuses the mutating ones. `task` stays, and its
  subagent works in plan mode too.

`session/set_mode` changes the mode for the next model call and sends `current_mode_update`. The agent never
changes mode by itself and has no exit-plan tool or request.

### Usage and context

After every model call: `usage_update` with `used` = the tokens that call held in context (input, cached
input and output, from the provider's own usage numbers) and `size` = the model's `contextWindow`
(128000 when the provider gave none). `turn_completed` carries no usage, so it does not replace this with
an estimate.

When `used` reaches 80% of `size` (or on `/compact`, see Slash commands), before the next model call the agent sends `auto_compact_started`
(`tokens_used`, `context_window`), has the same model write a summary, replaces the model's context with
that summary, and sends `auto_compact_completed` (`tokens_after`, the summary's size in tokens, estimated
at four characters a token). The transcript on disk keeps every message; a `compact` line marks where the
context starts again. This happens at the start of a prompt or between two model calls of a turn. When the
model writes no summary the context stays as it was (`tokens_after` is then the old `used`) and a line goes
to stderr. When a provider reports no usage, `used` is the same estimate over the context.

### End of a turn

`turn_completed` (`stopReason` as in the prompt result) is sent as the last update of every prompt that
ends without an error, just before the `session/prompt` result. So the app's wait for it ends at once.

`session/cancel` aborts the model stream, kills the running command (its whole process group) and cancels
a running MCP call, and stops a running `task` subagent. Tool calls that did not finish become `failed`
with "Cancelled" as their result, also in the model's history. The text and reasoning a reply had streamed
when it was cut off are kept as an assistant message (a `text` block and a `thinking` block without `raw`)
in the history and the transcript, so the next model call and a later `session/load` see what the user saw;
the tool calls it had begun are not kept. The prompt resolves, it is not an error.

## Errors

A failed model call fails `session/prompt` with
`{ code: -32000, message: '<the provider's own message> (HTTP <status>)', data: { status } }`, after the
retries above. A connection that fails gives the network error's text. Nothing is ever "Internal error":
an unexpected exception answers `{ code: -32603, message: <its message> }`.

A tool that fails is not an error of the prompt: its text goes back to the model as the tool's result.

## Transcript file

`<WB_AGENT_HOME>/<sessionId>.jsonl`, appended as the turn goes. Lines:

```
{ "type": "meta", "sessionId", "cwd", "createdAt" }
{ "type": "message", "message": { "role": "user" | "assistant", "content": [block] } }
{ "type": "compact", "summary": string }
```

A block is `{ type: 'text', text }`, `{ type: 'image', mimeType, data }`, `{ type: 'thinking', text, raw? }`,
`{ type: 'tool_call', id, name, input, error? }` or
`{ type: 'tool_result', id, content: [text | image], isError? }`. Tool results sit in a user message.
No key or header is ever written here, and `env` is not stored. What a command prints is stored as its
result, so a command that prints a secret puts it in the transcript and in what the model reads.
