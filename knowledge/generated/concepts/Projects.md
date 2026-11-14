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

A project is a folder on disk that the user adds to the sidebar so they can run chats against it. Adding one through the new project modal saves it in the persistent store with a color and an icon. The icon is found by looking for the project's app icon, favicon or logo. The sidebar lists each project with its worktrees and chats, and a drag grip lets the user reorder them. Picking a project scopes new chats, the git pane, the code index and the knowledge vault to that folder.

## Works with

- [[generated/concepts/Persistence Store.md|Persistence Store]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Session Import.md|Session Import]]
- [[generated/concepts/Git Worktrees.md|Git Worktrees]]
- [[generated/concepts/Project Intake.md|Project Intake]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `store.ts`: Persistent store: projects, handoffs, MCP servers, theme and hidden sessions.
  - `projectIcon.ts`: Finds a project's app icon, favicon or logo as a small data URL.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `Sidebar.tsx`: Resizable sidebar of projects, worktrees, chats, bots and their schedules.
  - `Modals.tsx`: New project, settings (agent sign-in, voice language and speed), and usage modals.
  - `ReorderGrip.tsx`: Drag grip that reorders items by swapping as the pointer moves.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `projectColor.ts`: Project color palette, hex normalizing, and picking or resolving a project's color.
  - `types.ts`: Core shared types: projects, messages, attachments, file hits, permission modes, plans.
