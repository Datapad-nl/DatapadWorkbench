---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Knowledge Vault

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Each project can have a knowledge vault of Markdown notes describing its modules and concepts. The main process maintains and rebuilds the vault. It outlines files, signs modules so it can tell which have changed, and sends batched briefs to an agent to write the summaries. Wiki-links in notes resolve to note links when shown in chat Markdown. The graph pane draws the vault as a rotating graph, with nodes sized by link count and colored by project area.

## Works with

- [[generated/concepts/CodeGraph Index.md|CodeGraph Index]]
- [[generated/concepts/Chat Media and Visuals.md|Chat Media and Visuals]]
- [[generated/concepts/Projects.md|Projects]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `knowledge.ts`: Maintains, rebuilds, reads and opens a project's knowledge vault.
  - `moduleSummaries.ts`: Outlines files, signs modules and batches briefs for vault module summaries.
- `src/renderer/src/components/`
  - `GraphPane.tsx`
  - `Markdown.tsx`
- `src/renderer/src/`
  - `noteLinks.ts`
