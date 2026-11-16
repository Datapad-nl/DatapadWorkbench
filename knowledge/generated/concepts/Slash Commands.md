---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/shared
workbench_generated: true
---

# Slash Commands

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Typing a slash in the composer opens a list of commands. Each agent has its own command definitions, and the list is filtered as the user types. On send, the input is parsed as a command and handled either by the Workbench or by the agent session.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Agent CLI Detection.md|Agent CLI Detection]]

## Where it lives

- `src/shared/`
  - `slash.ts`
- `src/renderer/src/components/`
  - `ChatPane.tsx`
- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `grok.ts`: Runs chat turns and streams: start, stop, wait, live events and commands.
