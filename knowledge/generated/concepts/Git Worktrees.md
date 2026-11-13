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

A chat can run in its own git worktree, so its changes stay apart from the project's main checkout and from other chats. The main process creates these worktrees and works out the folder each chat should run in. All of the app's git writes go through a lock, one at a time per repository, so they cannot collide. When a worktree is removed, processes still running from its folder are found and stopped.

## Works with

- [[generated/concepts/Git Pane.md|Git Pane]]
- [[generated/concepts/Checkpoints.md|Checkpoints]]
- [[generated/concepts/Projects.md|Projects]]
- [[generated/concepts/Pull Request Watching.md|Pull Request Watching]]

## Where it lives

- `src/main/`: The Electron main process.
  - `git.ts`: Chat worktrees, isolation decisions, uncommitted path checks and git snapshots for the git pane.
  - `gitLock.ts`: Serializes the app's git writes per repository using the shared .git directory.
  - `worktreeProcs.ts`: Finds and kills processes left running inside chat worktrees, on a periodic reaper.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `Sidebar.tsx`: Resizable sidebar listing projects, worktrees and chats, with project icons and scheduled-run times.
