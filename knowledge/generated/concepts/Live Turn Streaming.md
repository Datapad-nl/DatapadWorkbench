---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Live Turn Streaming

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

While a turn runs, the agent's output reaches the UI piece by piece as it is produced. The main process tracks each running turn and emits live chat events, and the IPC layer forwards them to the renderer. The workspace context keeps a stream per chat, which the chat pane draws as a reply that grows as it arrives. A separate reducer works out only each stream's status and errors, so the parts of the UI that need just that do not handle the reply text. When the app quits, turns still in progress are saved.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/IPC Bridge.md|IPC Bridge]]
- [[generated/concepts/Workspace State.md|Workspace State]]
- [[generated/concepts/Agent Replies.md|Agent Replies]]
- [[generated/concepts/Progress Cues.md|Progress Cues]]

## Where it lives

- `src/main/`: The Electron main process.
  - `grok.ts`: Runs chat turns on agents: streaming state, stopping, slash commands and live chat events.
  - `ipc.ts`: Registers IPC handlers, sends turns, forwards chat and index events and notifications.
  - `index.ts`: App entry: creates the window, tray behavior, single instance, startup and clean quitting.
- `src/renderer/src/`: The React UI of the Workbench.
  - `workspace.tsx`: Workspace context provider holding chats, pending requests, streams and stream statuses.
  - `streamStatus.ts`: Gets each chat's streaming status and error without its reply text.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `ChatPane.tsx`: The chat view: messages, live streaming reply, composer with images, PR chip and pane toggles.
