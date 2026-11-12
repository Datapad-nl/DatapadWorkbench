# Agent tools: what chats still miss

Chats inside Datapad Workbench can read and edit code, run commands and open pages in the
BrowserPane. These are the tools agents still lack, in the order to build them. Each one
is exposed to the agent as an MCP tool, the same way the `browser` server is.

## 1. See and drive the BrowserPane (`browser` MCP)

The agent can open a page and read its URL and title, but cannot see it or use it, so it
cannot check its own UI work.

- [x] `screenshot`: PNG of the visible page, returned as an image.
- [x] `snapshot`: page text plus a numbered list of links, buttons and fields.
- [x] `click`: click an element by snapshot number, CSS selector or visible text.
- [x] `type`: type into a field, optionally clearing it first.
- [x] `press`: press a key (Enter, Escape, Tab, arrows), with optional modifiers.
- [x] `wait_for`: wait until a selector or text shows up.
- [x] `evaluate`: run a JavaScript expression in the page and return the result.
- [x] `console`: the page's recent console messages and errors.

The tools in sections 2 to 6 live on a second MCP server, `workbench`, which knows the
calling chat.

## 2. Show a visual in the chat

- [x] A tool that takes HTML (a chart, a diagram, a mock-up) and renders it inline in the
      chat transcript, sandboxed, without starting a server (`show_visual`).

## 3. Hand work to another agent

- [x] `delegate`: start a child chat on Grok Build or Claude Code with a brief, wait for
      it, and return its final answer.
- [x] Optional separate git worktree for the child, removed when it is unchanged.
- [x] `delegate` takes a `model` for the child, so a small, fast model can do a simple job.
      Settings can fix one model for every child ("Subagent model").
- [x] Settings caps how many children of one chat run at the same time ("Most subagents at
      once", 4 unless changed). `delegate` refuses the next one until a child reports back.
- [x] `nudge`: send a child back to its task with a follow-up message and wait again.
- [x] `/conduct <job>`: the chat becomes the conductor. It plans, gives each task to its own
      child, checks what comes back, and runs on the "Orchestrator model" from Settings.
      Models are per chat on Claude Code only; Grok Build takes its model per process.

## 4. Other chats

- [x] `list_chats` and `read_chat`: let an agent look up another chat in the same project.
- [x] `start_chat`: open a new chat in the sidebar when the user asks for one.
- [x] `handoff`: continue the work in a new chat with a fresh context. The agent writes a
      handoff, saved under `userData/workbench/handoffs`, and the new chat starts from it in
      the same folder, on the same agent, model and mode, with the PR link moved over.
      `/handoff`, or the offer above the composer once the context passes 60% or 120k tokens.

## 5. Scheduled tasks

- [x] Run a prompt in a project on a schedule (once, or on a cron), shown in the sidebar
      (`schedule_task`, `cancel_schedule`; the sidebar shows the time to the next run and
      a button to stop it).

## 6. Pull requests

- [x] Link a PR to the chat and show its checks and review state (`link_pr`, `pr_status`,
      `unlink_pr`; a chip in the chat header, click to open the PR in the BrowserPane).
- [x] Watch a PR and wake the chat when checks finish, a review comes in or it closes.
      Uses the GitHub CLI (`gh`), checked every minute.
