# Datapad Workbench

Unofficial desktop for [Grok Build](https://grok.com/build) and [Claude Code](https://claude.com/claude-code). Projects in a sidebar, multiple chats at once.
Thought process window, Browser window, Git Window. Talk to your agent with local voice.

Not affiliated with, endorsed by, or sponsored by SpaceXAI / xAI or Anthropic. “Grok” and “Grok Build” are their marks, as are “Claude” and “Claude Code”.

![Datapad Workbench](docs/screenshot.png)

## Run

Installers are on [GitHub Releases](https://github.com/Datapad-nl/DatapadWorkbench/releases): a `.dmg` for Apple silicon Macs, an `.exe` for Windows (x64) and an `.AppImage` for Linux (x64). Installed builds check for a new release on start, download it in the background and install it when you quit. The Windows installer is not signed, so SmartScreen asks before it runs. You still need an agent installed and signed in (step 3 below).

To run from source, `npm run dev` opens a development window:

1. Clone this repository.
2. Install [Node.js 22](https://nodejs.org/).
3. Install at least one agent and sign in:
   - the [Grok Build CLI](https://x.ai/news/grok-build-cli): `grok login` (SuperGrok)
   - [Claude Code](https://claude.com/claude-code): `claude auth login` (Claude Pro or Max)
4. `npm install`
5. `npm run dev`

Optional: copy `.env.example` to `.env` and set `XAI_API_KEY` if you want an API key instead of `grok login`.

Electron 44 does not download its binary during `npm install`. `npm install` and `npm run dev` run `node_modules/electron/install.js` first, which writes `path.txt` and downloads the binary for this platform. That step exits immediately when the binary is already present. On macOS the same script then registers a signed Electron shell at `~/Applications/Datapad Workbench.app` (and tries `/Applications`) so the microphone permission prompt uses this app’s name. That is not a standalone Workbench build — start the app with `npm run dev`. If an installed release is already in `/Applications`, the script leaves it alone.

If `npm run dev` still fails with `Electron uninstall`, the binary is missing. Download it, then start again.

Windows (PowerShell):

```powershell
node node_modules\electron\install.js
npm run dev
```

macOS / Linux:

```sh
node node_modules/electron/install.js
npm run dev
```

Chats are real Grok Build or Claude Code sessions. Sessions already on disk for a folder (`~/.grok/sessions`, `~/.claude/projects`) show up in that project.

`npm run typecheck` is the compile gate, `npm run lint` runs ESLint, and `npm test` runs the unit tests. CI runs all three. `npm run build` emits the Electron bundle to `out/`. `npm run dist` builds installers for the current platform into `dist/`.

### Release

1. Set `version` in `package.json` and commit.
2. Push a matching tag, like `git tag v0.2.0 && git push origin v0.2.0`.
3. The Release workflow builds on macOS, Windows and Linux and uploads everything to one draft release. Publish the draft; installed apps pick it up from then on.

Each platform is built on its own runner because the bundled Claude Code binary is platform-specific. The Mac build is signed and notarized when these repository secrets are set:

| Secret | Value |
| --- | --- |
| `MAC_CERT_P12_BASE64` | The Developer ID Application certificate and key, exported as `.p12`, then base64 |
| `MAC_CERT_PASSWORD` | The `.p12` password |
| `APPLE_ID` | The Apple ID that notarizes |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | The team id, like `3FZVG3KWR3` |

Without them the Mac build is unsigned, and macOS will not install its updates.

## Index your code

Workbench uses the [Codegraph](https://github.com/colbymchenry/codegraph) CLI to index a project folder (file count, symbols, orientation card). Install it once on your machine.

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1 | iex
```

Or, if you already have Node: `npm i -g @colbymchenry/codegraph`

Open a new terminal after install so `codegraph` is on your PATH, then restart Workbench. If the binary is not on PATH, set `CODEGRAPH_BIN` in `.env` to its full path.

You do not need `codegraph install` — that wires other agents. Attach a folder to a project; Workbench runs `codegraph init` itself. If the CLI is missing, it will try the install script, then the npm package.

## What works now

**Desktop**

- Native window; size and pane layout persist
- Projects in a sidebar, each with an optional local folder, color, and rename

**Voice**

- Talk to your agent on this machine. Listening uses a local Whisper model; replies use [Supertonic 3](https://huggingface.co/supertone-oss-archive/supertonic-3), a local neural voice downloaded on first use. Audio never leaves the computer
- Conversation mode: a live loop — listen, send as you talk, speak replies, interrupt
- Speak replies, send when you stop talking, and keep listening after replies
- Mic, voice, speed, and language in Settings. Language is the one replies are spoken in, or Auto to pick one per reply. Turn on Voice, then use the Conversation button in the chat

**Chats**

- Multiple chats per project, each on Grok or Claude
- Concurrent streams: switch tabs without cancelling
- Real Grok Build and Claude Code sessions — sessions already on disk for a folder show up in that project
- Search the sidebar by project name, chat title, or anything said in a chat
- A notification and Dock badge when a chat finishes or needs your approval while Workbench is in the background
- Ask / Auto / Plan permission modes, including plan cards you can approve, revise, or abandon
- Isolated git worktrees so concurrent chats on the same repo do not clobber each other
- Checkpoints and rewind of files plus later messages
- First-run project briefing, Codegraph index status, and an orientation card

**Panes**

- Thought process: live tool and activity stream
- Browser: in-app webview the agent can drive; pick and annotate a page element; screenshots; YouTube captions; clear cookies
- Git: branch, ahead/behind, commit graph, diffs, stage / unstage / discard, commit, checkout, new branch, merge a chat’s worktree branch back into the project
- Knowledge: Obsidian-compatible `knowledge/` vault with a graph pane and generated maps

**Composer**

- Markdown replies, `@file` / folder mentions, pasted screenshots and attachments
- Slash-command palette: `/new`, `/rewind`, `/plan`, `/ask`, `/always-approve`, `/commit`, `/review`, `/model`, `/settings`, `/usage`, `/transcribe`, `/btw`, `/export` (save the chat as Markdown), and more
- The agent’s own commands and skills show in the same palette, such as `/compact` and `/context`. Grok chats also get `/imagine`
- MCP servers for every chat: Settings → MCP (or `/mcps`) takes the usual `mcpServers` JSON, local commands or `http`/`sse` URLs. They load next to the built-in browser server and each agent’s own MCP config
- Steer a running task, or `/btw` a side question without dropping it

**Settings**

- Default agent for new chats: Grok or Claude
- Grok signs in with `grok login` (SuperGrok), with an optional API-key fallback. Claude uses your `claude auth login`
- Model and effort picker: Grok 4.6 by default; Claude chats list the models and effort levels Claude Code offers
- Appearance: built-in themes plus import and export of custom themes
- Usage snapshot in the status bar

## License

[MIT](LICENSE)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).
