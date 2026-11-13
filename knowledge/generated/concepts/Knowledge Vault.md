---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Knowledge Vault

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Each project can have a knowledge vault: a folder of Markdown notes that describes how the project works. The main process builds the vault from a scan of the project and from summaries of its modules, which are made from file outlines and signatures sent off in batches, and it keeps the vault up to date. The vault can be read in the app or opened outside it. The Graph pane draws the notes as a force-directed graph and shows the content of the note the user picks.

## Works with

- [[generated/concepts/CodeGraph Index.md|CodeGraph Index]]
- [[generated/concepts/Project Intake.md|Project Intake]]
- [[generated/concepts/Projects.md|Projects]]

## Where it lives

- `src/main/`: The Electron main process.
  - `knowledge.ts`: Maintains, rebuilds, reads and opens a project's knowledge vault folder.
  - `moduleSummaries.ts`: Outlines source files, signs modules and batches module briefs for vault summaries.
  - `projectScan.ts`: Scans a project folder for its stack, dependencies and other findings.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `GraphPane.tsx`: Draws the knowledge vault as a force-directed graph of notes and shows their content.
