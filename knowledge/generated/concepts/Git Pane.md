---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Git Pane

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The Git pane shows the state of the project's repository. The main process takes a git snapshot and summary of the project, and the renderer draws it: the list of changed files and a commit graph with colored branches. Changes can be shown as side-by-side diffs, which are built line by line from the old and new text.

## Works with

- [[generated/concepts/Git Worktrees.md|Git Worktrees]]
- [[generated/concepts/Activity Feed.md|Activity Feed]]

## Where it lives

- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `GitPane.tsx`: Shows the project's git state: changed files and a colored commit graph.
  - `CodeDiff.tsx`: Renders a side-by-side code diff from an activity event.
- `src/main/`: The Electron main process.
  - `git.ts`: Chat worktrees, isolation decisions, uncommitted path checks and git snapshots for the git pane.
- `src/renderer/src/`: The React UI of the Workbench.
  - `lineDiff.ts`: Computes a side-by-side line diff between two texts.
