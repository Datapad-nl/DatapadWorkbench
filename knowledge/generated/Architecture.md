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

- `design/`: Holds the planned redesign of the Workbench UI: a mockup and written instructions for turning the current interface into it.
- `docs/`: Project documentation outside the code: a note on the tools that chats inside the Workbench still lack, in the order to build them, and the app screenshot shown in the README.
- `preview/`: Groups preview material for the app.
- `resources/`: Holds the app's icon artwork, which the packaging step and the main process use.
- `scripts/`: Development helper scripts.
- `src/`: The whole application source, split along Electron's process boundaries.
- `themes/`: The built-in appearance themes that ship with the app, one JSON file each.

## Modules

- `src/main/`: The Electron main process. It runs chats through Grok and Claude Code agents over ACP, handling permissions, questions, checkpoints, git worktrees and activity tracking. It also stores projects, chats, themes and settings, and runs the BrowserPane with its MCP tools, the knowledge vault, bot skills, updates and notifications. The renderer reaches all of this through IPC handlers registered here.
- `src/preload/`: The bridge between the UI and the main process. It defines the API object the renderer calls on `window`, and its type, so UI code reaches main-process features without direct access to Electron.
- `src/renderer/`: Holds the renderer side of the app, the React UI shown in the window. Its code lives in the `src` folder.
- `src/renderer/src/`: The React UI of the Workbench. It lays out the sidebar, chats and resizable right panes (git, browser, activity, knowledge), and keeps chat and stream state in a shared workspace context. Small helpers handle diffs, vault note links and spoken progress cues.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity. It also holds the modals for new projects, settings, usage and MCP servers, the theme editor, and shared pieces such as icons, the Markdown renderer and the toggle. The renderer app composes these into the full interface, drawing on shared types, the theme and the voice module.
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
- `shot.png`
- `tsconfig.json`
- `tsconfig.node.json`
- `tsconfig.node.tsbuildinfo`
- `tsconfig.web.json`
- `tsconfig.web.tsbuildinfo`

## Tree

```
├── .github
│   └── workflows
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
