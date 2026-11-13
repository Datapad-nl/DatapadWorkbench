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

The renderer has no direct access to Electron or the file system. Instead, the preload script builds an API object and exposes it on `window`, and a type declaration describes that API to the UI code. Each method on the object calls an IPC handler that the main process registers. Events go the other way: the main process pushes them to the renderer over IPC, for example chat streams and notices.

## Works with

- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/Persistence Store.md|Persistence Store]]
- [[generated/concepts/Workspace State.md|Workspace State]]

## Where it lives

- `src/preload/`: The bridge between the UI and the main process.
  - `index.ts`: Builds the API object exposed to the renderer and exports its type.
  - `index.d.ts`: Declares the Workbench API on the global `Window` type.
- `src/main/`: The Electron main process.
  - `ipc.ts`: Registers IPC handlers, sends turns, forwards chat and index events and notifications.
  - `index.ts`: App entry: creates the window, tray behavior, single instance, startup and clean quitting.
