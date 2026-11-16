---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Progress Cues

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

While a long turn runs, the Workbench gives short progress updates so the user knows what the agent is doing. The renderer tracks each chat's running activity and decides when a progress update should be spoken. For a running shell task, the main process finds the latest output line to report. The speech queue lets these status lines jump ahead of reply sentences that are waiting to be read.

## Works with

- [[generated/concepts/Voice.md|Voice]]
- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/Activity Feed.md|Activity Feed]]

## Where it lives

- `src/renderer/src/`
  - `progress.ts`
- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `taskProgress.ts`: Finds the latest output line of a running shell task.
- `src/renderer/src/voice/`
  - `asideTts.worker.ts`
