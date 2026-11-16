---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Git Pane

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The git pane is a right-side pane showing the repository state for the current project or worktree. The main process collects a git snapshot: changed and uncommitted files, branches and commits. The pane draws the changed files and a branch graph with a colored lane for each branch, plus a status line. It refreshes as chats change files.

## Works with

- [[generated/concepts/Git Worktrees.md|Git Worktrees]]
- [[generated/concepts/Pull Request Watching.md|Pull Request Watching]]
- [[generated/concepts/Projects.md|Projects]]

## Where it lives

- `src/renderer/src/components/`
  - `GitPane.tsx`
- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `git.ts`: Chat worktrees, isolation decisions, uncommitted paths and git snapshots for the UI.
  - `gitLock.ts`: Serializes the app's git writes per repository via a shared lock.
