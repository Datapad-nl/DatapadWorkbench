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

Before an agent's tool changes a file, the main process takes a snapshot of that file. At the end of each turn, the snapshots are saved as a checkpoint for that turn. This keeps a record of what the files looked like before the turn, so its changes can be reviewed or undone.

## Works with

- [[generated/concepts/Permission Modes.md|Permission Modes]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Git Worktrees.md|Git Worktrees]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `checkpoints.ts`: Snapshots files before tools change them and saves per-turn checkpoints.
  - `grok.ts`: Runs chat turns and streams: start, stop, wait, live events and commands.
