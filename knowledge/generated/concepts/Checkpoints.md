---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Checkpoints

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Before an agent's tool changes a file, the app copies the file as it was. These copies make up checkpoints in the chat's history. Rewinding to a checkpoint puts the saved copies back, which undoes the agent's file changes after that point.

## Works with

- [[generated/concepts/Git Worktrees.md|Git Worktrees]]
- [[generated/concepts/Activity Feed.md|Activity Feed]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]

## Where it lives

- `src/main/`: The Electron main process.
  - `checkpoints.ts`: Copies files before tools change them and saves per-turn checkpoints for restoring.
  - `acp.ts`: ACP session update types, agent process keys and waiting for a previous turn.
  - `git.ts`: Chat worktrees, isolation decisions, uncommitted path checks and git snapshots for the git pane.
