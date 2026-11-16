---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Agent Questions

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

An agent can stop in the middle of a turn to ask the user a question. The main process parses the question out of the agent's output and sends a prompt event to the renderer. The chat shows the question and its options. When the user answers or the question is dropped, a settle event closes it and the turn continues.

## Works with

- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Project Intake.md|Project Intake]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `questions.ts`: Parses agent questions to the user and emits prompt and settle events.
  - `ipc.ts`: Registers IPC handlers, sends turns, and raises notices for chats and bots.
- `src/renderer/src/components/`
  - `ChatPane.tsx`
