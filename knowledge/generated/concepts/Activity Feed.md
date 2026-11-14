---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Activity Feed

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The activity feed is a separate window showing what every chat's agent is doing. The main process tracks running turns, notices and permission activity for each chat. The feed groups tool events into turns per chat, with timings. Selecting a file edit opens a side-by-side code diff computed line by line.

## Works with

- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/Permission Modes.md|Permission Modes]]
- [[generated/concepts/Background Attention.md|Background Attention]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `activity.ts`: Tracks running turns, notices and permission activity per chat for the activity feed.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `ActivityApp.tsx`: Activity feed window grouping tool events into turns per chat, with timings.
  - `CodeDiff.tsx`: Side-by-side code diff view for an activity diff.
- `src/renderer/src/`: The React UI root: it mounts the app, lays out the sidebar, chat and resizable right panes, and provides workspace and bot contexts to the components.
  - `lineDiff.ts`: Computes side-by-side line diffs between two texts.
