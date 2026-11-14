---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/preload
workbench_generated: true
---

# IPC Bridge

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The React UI never touches Electron directly. The preload script builds one API object, exposes it on `window`, and declares its type for the renderer. Each call on that object becomes an IPC message that a handler registered in the main process answers. The main process also pushes events back to the renderer, such as stream updates and notices, and the UI contexts subscribe to them.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/Persistence Store.md|Persistence Store]]

## Where it lives

- `src/preload/`: The bridge between the UI and the main process.
  - `index.ts`: Builds the API object exposed to the renderer and exports its type.
  - `index.d.ts`: Declares the Workbench API on the global `Window` type.
- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `ipc.ts`: Registers IPC handlers, sends turns, and raises notices for chats and bots.
  - `index.ts`: App entry: window lifecycle, tray-hiding, single instance and clean quit.
- `src/renderer/src/`: The React UI root: it mounts the app, lays out the sidebar, chat and resizable right panes, and provides workspace and bot contexts to the components.
  - `workspace.tsx`: Workspace context: pending requests, right pane, bot tabs and streams.
