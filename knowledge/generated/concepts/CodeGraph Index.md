---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# CodeGraph Index

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

A project can have a CodeGraph index of its symbols that agents query. The main process reads the project's index, syncs it and caches the result, then reports when it changes. A parent folder's index doesn't count as the project's own. The orientation card shows whether the project is indexed and has a button to start indexing, and the status bar shows the index state.

## Works with

- [[generated/concepts/Projects.md|Projects]]
- [[generated/concepts/Knowledge Vault.md|Knowledge Vault]]
- [[generated/concepts/Project Intake.md|Project Intake]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `codegraph.ts`: Reads, syncs and caches CodeGraph indexes for projects and reports changes.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `OrientationCard.tsx`: Shows a project's code index status and a button to start indexing.
  - `StatusBar.tsx`: Status bar showing usage percent with reset countdown and index state.
