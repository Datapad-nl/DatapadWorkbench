# Datapad Workbench

Electron + Vite + React desktop app. Unofficial desktop for Grok Build. Projects in the sidebar, concurrent chats.

- Main process: `src/main` (persistence, xAI streaming, IPC)
- Preload: `src/preload`
- UI: `src/renderer/src`
- Shared types: `src/shared/types.ts`
- Data lives in Electron `userData/workbench`
- Chats run through `grok agent stdio` (ACP). Auth is `grok login` / SuperGrok.
- Existing `~/.grok/sessions` for a project folder are imported into the sidebar.
- Open every web page in the Workbench BrowserPane via the `browser` MCP (`navigate`). Do not launch an external browser. After UI changes, navigate to the local URL, then `screenshot` and `snapshot` it (and `click` / `type` through it) so you can verify your own work.
