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
