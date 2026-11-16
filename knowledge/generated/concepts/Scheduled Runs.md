---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Scheduled Runs

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

A bot can run a prompt on a schedule written as a five-field cron expression. The cron parser finds the next matching local time, and when that time comes, the prompt is sent to the schedule's chat as a new turn. Each schedule's chat is listed indented under its bot in the sidebar, with the time until its next run. Above the messages, a scheduled chat shows how it repeats, its next and last run, its prompt and a Stop button. The tray menu shows the next runs as well.

## Works with

- [[generated/concepts/Bots.md|Bots]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Background Attention.md|Background Attention]]

## Where it lives

- `src/shared/`
  - `cron.ts`
- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `ipc.ts`: Registers IPC handlers, sends turns, and raises notices for chats and bots.
  - `trayMenu.ts`: Builds menu bar labels for bots, their next runs and waiting chats.
  - `bots.ts`: Creates, lists and updates bots, their folders, avatars and session rules.
- `src/renderer/src/components/`
  - `Sidebar.tsx`
  - `ChatPane.tsx`
