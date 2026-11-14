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

Chats started outside the Workbench show up in the sidebar for their project. The main process lists Grok sessions under ~/.grok/sessions and Claude Code JSONL transcripts that belong to the project folder. Large JSONL files are read row by row in chunks, so a long transcript doesn't have to be loaded at once. The imported sessions appear as chats that can be read and continued. Sessions the user hides are recorded in the store.

## Works with

- [[generated/concepts/Projects.md|Projects]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Persistence Store.md|Persistence Store]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `sessions.ts`: Lists and reads Grok sessions on disk, plans and sign-in state.
  - `claudeSessions.ts`: Lists and reads Claude Code JSONL session transcripts for project folders.
  - `jsonl.ts`: Streams rows from large JSONL files chunk by chunk.
  - `store.ts`: Persistent store: projects, handoffs, MCP servers, theme and hidden sessions.
