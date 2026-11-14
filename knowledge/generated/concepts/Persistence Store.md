---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Persistence Store

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The main process keeps all state on disk under Electron's userData/workbench folder: projects, handoffs, MCP servers, the theme, hidden sessions and bots. Writes go through keyed locks and atomic file replacement, so concurrent updates can't interleave and a crash can't leave a half-written file. Reads are safe against corruption and recover from a bad JSON file. The window's size and position are saved separately.

## Works with

- [[generated/concepts/Projects.md|Projects]]
- [[generated/concepts/Bots.md|Bots]]
- [[generated/concepts/IPC Bridge.md|IPC Bridge]]
- [[generated/concepts/MCP Server Configuration.md|MCP Server Configuration]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `store.ts`: Persistent store: projects, handoffs, MCP servers, theme and hidden sessions.
  - `storeIo.ts`: Keyed locks, atomic file writes and corruption-safe JSON reads.
  - `windowState.ts`: Loads and saves the main window's size and position.
  - `bots.ts`: Creates, lists and updates bots, their folders, avatars and session rules.
  - `ids.ts`: Generates ids, timestamps and chat titles from prompts.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `types.ts`: Core shared types: projects, messages, attachments, file hits, permission modes, plans.
