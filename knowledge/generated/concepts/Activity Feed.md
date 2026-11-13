---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Activity Feed

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The main process records each chat's turns, notices and permission events as activity. The Activity pane shows this feed grouped by turn. Tool names are cleaned up and tool output is formatted for reading. File edits can be shown as side-by-side code diffs, and for a shell task that is still running, the latest line of its output is shown.

## Works with

- [[generated/concepts/Permission Modes.md|Permission Modes]]
- [[generated/concepts/Git Pane.md|Git Pane]]
- [[generated/concepts/Agent Replies.md|Agent Replies]]
- [[generated/concepts/Checkpoints.md|Checkpoints]]

## Where it lives

- `src/main/`: The Electron main process.
  - `activity.ts`: Tracks running turns, notices and permission events as an activity snapshot for the UI.
  - `taskProgress.ts`: Finds the latest output line a running shell task wrote, for progress display.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `ActivityApp.tsx`: Shows the agent activity feed grouped into turns, with cleaned tool names and formatted output.
  - `CodeDiff.tsx`: Renders a side-by-side code diff from an activity event.
- `src/renderer/src/`: The React UI of the Workbench.
  - `lineDiff.ts`: Computes a side-by-side line diff between two texts.
