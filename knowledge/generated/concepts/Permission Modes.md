---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Permission Modes

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Each chat session has a permission mode that sets what the agent may do without asking. When the agent requests a tool permission, the main process checks it against the session's mode. It also checks whether another chat is editing the same files and reports that as an edit clash. The chat pane shows a clash bar so the user can see the conflict, and permission activity is recorded for the activity feed.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Checkpoints.md|Checkpoints]]
- [[generated/concepts/Git Worktrees.md|Git Worktrees]]
- [[generated/concepts/Activity Feed.md|Activity Feed]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `permissions.ts`: Permission modes per session and edit-clash checks against other chats.
  - `activity.ts`: Tracks running turns, notices and permission activity per chat for the activity feed.
- `src/renderer/src/components/`
  - `ChatPane.tsx`
- `src/shared/`
  - `types.ts`
