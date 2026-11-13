---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Pull Request Watching

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

A GitHub pull request can be linked to a chat. The main process reads the pull request's status and keeps watching it for changes. The chat pane shows a PR chip with the current state.

## Works with

- [[generated/concepts/Git Worktrees.md|Git Worktrees]]
- [[generated/concepts/Background Attention.md|Background Attention]]

## Where it lives

- `src/main/`: The Electron main process.
  - `pullRequests.ts`: Links GitHub PRs to chats, reads their status and watches them for changes.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `ChatPane.tsx`: The chat view: messages, live streaming reply, composer with images, PR chip and pane toggles.
