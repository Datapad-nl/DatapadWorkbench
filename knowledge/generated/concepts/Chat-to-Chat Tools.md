---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Chat-to-Chat Tools

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Agents can talk to other chats and to bots through tools on the Workbench MCP server. An agent can send a message to another chat, ask a bot a question, or post a message to a bot's chat. The main process routes the message to the target session and starts a turn there. It returns the reply where needed and raises a notice. This lets one chat hand work to another, or coordinate several chats, as the subagents panel shows.

## Works with

- [[generated/concepts/Browser MCP Server.md|Browser MCP Server]]
- [[generated/concepts/Bots.md|Bots]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `chatTools.ts`: Chat tools for agents: send to chats, ask bots, and bot chat messages.
  - `browserAgent.ts`: Local HTTP server behind the browser MCP; builds MCP server configs and agent hooks.
  - `ipc.ts`: Registers IPC handlers, sends turns, and raises notices for chats and bots.
