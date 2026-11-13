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

CodeGraph builds an index of the symbols in a project's code. The app finds the CodeGraph program, then reads and syncs each project's index. The orientation card shows whether a project is indexed, gives an orientation to the project, and offers a button to start indexing. The status bar also shows the index status.

## Works with

- [[generated/concepts/Knowledge Vault.md|Knowledge Vault]]
- [[generated/concepts/Projects.md|Projects]]

## Where it lives

- `src/main/`: The Electron main process.
  - `codegraph.ts`: Locates the codegraph binary, reads and syncs project indexes and reports index changes.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `OrientationCard.tsx`: Shows a project's index status and orientation, with an action to start indexing.
  - `StatusBar.tsx`: Bottom bar showing usage percentage, time until reset and index status.
