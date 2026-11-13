---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Permission Modes

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Each agent session has a permission mode that decides which tool calls the agent may run without asking. When the agent asks permission for a tool, the main process records the request and sends it to the renderer, where it waits in that chat's queue. The user's answer is sent back to the agent through ACP. Permission events also show up in the Activity feed.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Agent Questions.md|Agent Questions]]
- [[generated/concepts/Workspace State.md|Workspace State]]
- [[generated/concepts/Activity Feed.md|Activity Feed]]
- [[generated/concepts/Background Attention.md|Background Attention]]

## Where it lives

- `src/main/`: The Electron main process.
  - `permissions.ts`: Permission types, per-session modes and clash detection for edits to files other chats hold.
  - `acp.ts`: ACP session update types, agent process keys and waiting for a previous turn.
  - `activity.ts`: Tracks running turns, notices and permission events as an activity snapshot for the UI.
- `src/renderer/src/`: The React UI of the Workbench.
  - `workspace.tsx`: Workspace context provider holding chats, pending requests, streams and stream statuses.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `types.ts`: Core shared types: projects, messages, attachments, file hits, permission modes, plans.
