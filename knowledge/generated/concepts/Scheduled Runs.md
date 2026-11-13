---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/shared
workbench_generated: true
---

# Scheduled Runs

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Runs can be scheduled with five-field cron expressions. The shared cron code parses an expression and finds the next local time it matches. The sidebar shows when the next scheduled run is due, and the menu bar icon lists each bot with its next run.

## Works with

- [[generated/concepts/Background Attention.md|Background Attention]]
- [[generated/concepts/Projects.md|Projects]]

## Where it lives

- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `cron.ts`: Parses five-field cron expressions and finds the next matching local time.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `Sidebar.tsx`: Resizable sidebar listing projects, worktrees and chats, with project icons and scheduled-run times.
