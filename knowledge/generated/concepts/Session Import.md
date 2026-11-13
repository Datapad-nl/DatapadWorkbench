---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Session Import

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Sessions that already exist on disk for a project's folder are imported into the sidebar. For Grok, the app lists the sessions under ~/.grok/sessions and reads their history, plans and sign-in state. For Claude Code, it lists the sessions for the project's folders and reads their transcripts as messages. The JSONL transcript files are read row by row in chunks, so large histories do not have to be loaded all at once.

## Works with

- [[generated/concepts/Projects.md|Projects]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Agent CLI Detection.md|Agent CLI Detection]]

## Where it lives

- `src/main/`: The Electron main process.
  - `sessions.ts`: Reads Grok sessions from disk: listing, history, plans and plan approval state.
  - `claudeSessions.ts`: Lists Claude Code JSONL sessions for project folders and reads their message history.
  - `jsonl.ts`: Streams rows of large JSONL files chunk by chunk.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `types.ts`: Core shared types: projects, messages, attachments, file hits, permission modes, plans.
