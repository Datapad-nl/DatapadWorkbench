---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Live Turn Streaming

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

While an agent works, its output reaches the UI as a stream of live events. The main process forwards each event from the ACP session to the renderer. The workspace context collects these events per chat. Stream status is worked out from them separately from the reply text, so the UI knows whether a chat is running, finished or failed. The chat pane draws the live reply, and the agent reply component folds earlier tool steps and splits the reply at its step breaks.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/IPC Bridge.md|IPC Bridge]]
- [[generated/concepts/Activity Feed.md|Activity Feed]]
- [[generated/concepts/Progress Cues.md|Progress Cues]]
- [[generated/concepts/Chat Media and Visuals.md|Chat Media and Visuals]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `grok.ts`: Runs chat turns and streams: start, stop, wait, live events and commands.
  - `taskProgress.ts`: Finds the latest output line of a running shell task.
- `src/renderer/src/`: The React UI root: it mounts the app, lays out the sidebar, chat and resizable right panes, and provides workspace and bot contexts to the components.
  - `workspace.tsx`: Workspace context: pending requests, right pane, bot tabs and streams.
  - `streamStatus.ts`: Derives each chat's stream status and error without reply text.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `ChatPane.tsx`: Chat view with messages, live reply, context, schedule, handoff, PR and clash bars.
  - `AgentReply.tsx`: Renders an agent reply, folding earlier tool steps and showing visual blocks.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `steps.ts`: Splits a reply at its step breaks and returns it as plain markdown.
