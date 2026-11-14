---
tags:
  - datapad-workbench
  - generated
  - architecture
workbench_generated: true
---

# Architecture

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

How **Datapad Workbench** is laid out: its folders and what each is for. How it works is in the concepts [[Overview]] lists.

## Areas

- `design/`: Holds design references for the Workbench user interface: HTML mockups and written instructions for turning the current UI into the redesigned layout.
- `docs/`: Project documentation outside the code: a note on the tools that chats inside the Workbench still lack, in the order to build them, and the app screenshot shown in the README.
- `preview/`: Groups preview material for the app.
- `resources/`: Holds the app's icon artwork, which the packaging step and the main process use.
- `scripts/`: Development helper scripts.
- `src/`: The whole application source, split along Electron's process boundaries.
- `themes/`: The built-in appearance themes that ship with the app, one JSON file each.

## Modules

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC. It also covers permissions, checkpoints, git worktrees, the BrowserPane and its MCP tools, code indexing, the knowledge vault, notifications, the tray menu, themes, voice and auto-updates. Everything the UI shows or does goes through this layer.
- `src/preload/`: The bridge between the UI and the main process. It defines the API object the renderer calls on `window`, and its type, so UI code reaches main-process features without direct access to Electron.
- `src/renderer/`: Holds the renderer side of the app, the React UI shown in the window. Its code lives in the `src` folder.
- `src/renderer/src/`: The React UI root: it mounts the app, lays out the sidebar, chat and resizable right panes, and provides workspace and bot contexts to the components. It also holds small UI helpers for diffs, note links, chat width, progress cues and stream status.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents. They also cover the modals for new projects, settings, usage and MCP servers, plus bot pages, toasts, the theme editor and shared controls like icons and toggles. The renderer app puts its windows together from these components and reaches main-process data through the preload bridge.
- `src/renderer/src/theme/`: Applies a theme file to the running interface and syncs the font stylesheet links it needs. A React provider holds the current theme state and exposes it through the useTheme hook, which components such as the theme editor use to read and change the theme.
- `src/renderer/src/voice/`: Gives the app voice input and output that run locally: Whisper speech recognition and Supertonic text-to-speech on onnxruntime-web, each in a web worker. A React provider tracks the voice status and exposes listening and speaking to the interface through useVoice, while helper functions turn Markdown replies into speakable text, pick the speech language and drop echoes of the user's request. The settings modal and chat components use it to read replies aloud and take dictation.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI. It defines the data shapes for projects, chats, themes and MCP servers, and logic such as slash command parsing, cron schedules, media and YouTube URL handling, and project colors.

## Root files

- `CLAUDE.md`
- `CONTRIBUTING.md`
- `datapad-workbench-assets.zip`
- `electron-builder.yml`
- `electron.vite.config.ts`
- `eslint.config.mjs`
- `LICENSE`
- `package-lock.json`
- `package.json`
- `README.md`
- `SECURITY.md`
- `tsconfig.json`
- `tsconfig.node.json`
- `tsconfig.node.tsbuildinfo`
- `tsconfig.web.json`
- `tsconfig.web.tsbuildinfo`

## Tree

```
├── .github
│   └── workflows
├── preview
│   └── subagents
├── scripts
│   └── register-mac-app.mjs
├── src
│   ├── main
│   ├── preload
│   ├── renderer
│   └── shared
├── electron-builder.yml
├── electron.vite.config.ts
└── eslint.config.mjs
```


- [[Overview]]
- [[Home]]
