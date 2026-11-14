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

A chat can be linked to a GitHub pull request. The main process links the PR to the chat, then watches it and reports status changes. The chat pane shows a PR bar with the current status.

## Works with

- [[generated/concepts/Git Pane.md|Git Pane]]
- [[generated/concepts/Git Worktrees.md|Git Worktrees]]
- [[generated/concepts/Background Attention.md|Background Attention]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `pullRequests.ts`: Links GitHub PRs to chats, reports status, and watches them for changes.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `ChatPane.tsx`: Chat view with messages, live reply, context, schedule, handoff, PR and clash bars.
