---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Persistence Store

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Projects, chats, MCP servers and the theme choice are saved as JSON files in the app's userData/workbench folder. Writes go through a keyed lock and are atomic, so two writes to one file cannot interleave and a crash cannot leave a half-written file. If a JSON file cannot be read, it is moved aside instead of breaking the app, and on startup the app warns about projects it could not read. The window's size and position are saved separately, so it reopens where it was.

## Works with

- [[generated/concepts/Projects.md|Projects]]
- [[generated/concepts/IPC Bridge.md|IPC Bridge]]
- [[generated/concepts/MCP Server Configuration.md|MCP Server Configuration]]

## Where it lives

- `src/main/`: The Electron main process.
  - `store.ts`: Persistent store for projects, chats, handoffs, MCP servers, theme and related settings.
  - `storeIo.ts`: Keyed locks, atomic file writes and JSON reads that move corrupt files aside.
  - `windowState.ts`: Loads and saves the window's size and position.
  - `index.ts`: App entry: creates the window, tray behavior, single instance, startup and clean quitting.
  - `jsonl.ts`: Streams rows of large JSONL files chunk by chunk.
