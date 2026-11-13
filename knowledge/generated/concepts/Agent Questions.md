---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Agent Questions

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

An agent can stop in the middle of a turn to ask the user something, including asking for approval before it leaves plan mode. The main process parses these questions and announces both when one is asked and when it is settled. The renderer queues each open question with the chat it belongs to, and the user's answer goes back to the agent. A chat with an open question counts as waiting for the user.

## Works with

- [[generated/concepts/Permission Modes.md|Permission Modes]]
- [[generated/concepts/Workspace State.md|Workspace State]]
- [[generated/concepts/Background Attention.md|Background Attention]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]

## Where it lives

- `src/main/`: The Electron main process.
  - `questions.ts`: Parses agent questions to the user and emits prompt and settled events.
  - `acp.ts`: ACP session update types, agent process keys and waiting for a previous turn.
- `src/renderer/src/`: The React UI of the Workbench.
  - `workspace.tsx`: Workspace context provider holding chats, pending requests, streams and stream statuses.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `ChatPane.tsx`: The chat view: messages, live streaming reply, composer with images, PR chip and pane toggles.
