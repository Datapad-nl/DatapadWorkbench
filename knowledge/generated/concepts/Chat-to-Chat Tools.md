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

An agent can work with the other chats in its project. Through tools on the Workbench MCP server, it can list those chats, read one, start a new one, or send one a message. The calls arrive at the main process, which runs them against the store and the turn runner. Chats in a project can use this to hand work to each other.

## Works with

- [[generated/concepts/Browser MCP Server.md|Browser MCP Server]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Persistence Store.md|Persistence Store]]

## Where it lives

- `src/main/`: The Electron main process.
  - `chatTools.ts`: Chat tools for agents: sending to chats, asking bots, listing and reading project chats.
  - `browser-mcp.mjs`: Stdio MCP server exposing BrowserPane tools and workbench chat tools to agents.
  - `browserAgent.ts`: Local HTTP server backing the browser MCP, plus MCP server and hook configs per chat.
  - `grok.ts`: Runs chat turns on agents: streaming state, stopping, slash commands and live chat events.
