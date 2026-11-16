---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Git Worktrees

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

A chat can work in its own git worktree, so concurrent chats don't edit the same checkout. When a chat starts, the main process decides whether it needs isolation and, if so, creates a worktree for it. All of the app's git writes are serialized per repository by a shared lock. When a worktree is no longer used, processes still running from it are found and killed. The sidebar lists worktrees under their project.

## Works with

- [[generated/concepts/Projects.md|Projects]]
- [[generated/concepts/Git Pane.md|Git Pane]]
- [[generated/concepts/Permission Modes.md|Permission Modes]]
- [[generated/concepts/Checkpoints.md|Checkpoints]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `git.ts`: Chat worktrees, isolation decisions, uncommitted paths and git snapshots for the UI.
  - `gitLock.ts`: Serializes the app's git writes per repository via a shared lock.
  - `worktreeProcs.ts`: Finds and kills leftover processes running from chat worktrees.
- `src/renderer/src/components/`
  - `Sidebar.tsx`
