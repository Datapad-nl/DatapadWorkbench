---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Projects

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

A project is a folder on disk that the user adds to the sidebar, and each project holds its own chats. When a project is added, the main process saves it to the store and finds the project's own icon to show as a small image. Each project gets a color from a fixed palette, and the user can change it. The sidebar lists projects with their worktrees and chats, and the user can drag them into a new order. A project's name and icon can also be blurred for screen recordings.

## Works with

- [[generated/concepts/Persistence Store.md|Persistence Store]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Session Import.md|Session Import]]
- [[generated/concepts/Project Intake.md|Project Intake]]
- [[generated/concepts/Git Worktrees.md|Git Worktrees]]

## Where it lives

- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `Sidebar.tsx`: Resizable sidebar listing projects, worktrees and chats, with project icons and scheduled-run times.
  - `ReorderGrip.tsx`: A drag handle that reorders items by pointer movement.
  - `Modals.tsx`: New project, settings and usage modals, including voice options and agent sign-in status.
- `src/main/`: The Electron main process.
  - `store.ts`: Persistent store for projects, chats, handoffs, MCP servers, theme and related settings.
  - `projectIcon.ts`: Finds a project's own icon or logo and returns it as a small data URL.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `projectColor.ts`: Project color palette, hex normalizing, and picking or resolving a project's color.
  - `types.ts`: Core shared types: projects, messages, attachments, file hits, permission modes, plans.
