---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Workspace State

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

In the renderer, a React context called the workspace holds the state that components share. It keeps the list of chats, the live reply stream of each chat, each stream's status, and the requests that are waiting for the user in each chat. Components read this state through hooks, and the context updates it as events arrive from the main process. The root App component lays out the sidebar, the chat and the right-hand panes, and remembers how wide each pane is.

## Works with

- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/IPC Bridge.md|IPC Bridge]]
- [[generated/concepts/Permission Modes.md|Permission Modes]]
- [[generated/concepts/Agent Questions.md|Agent Questions]]

## Where it lives

- `src/renderer/src/`: The React UI of the Workbench.
  - `workspace.tsx`: Workspace context provider holding chats, pending requests, streams and stream statuses.
  - `App.tsx`: Root component laying out the workspace with resizable activity, browser, git and knowledge panes.
  - `main.tsx`: Mounts the App in React StrictMode.
  - `streamStatus.ts`: Gets each chat's streaming status and error without its reply text.
