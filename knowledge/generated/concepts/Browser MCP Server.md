---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Browser MCP Server

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Agents use the BrowserPane through an MCP server that runs over stdio. The app adds this server to every chat's list of MCP servers. When an agent calls a tool such as navigate, screenshot or snapshot, the stdio server passes the call on to a local HTTP server in the main process. That server runs page actions one at a time, so two agents cannot act on the page at the same moment. The same MCP server also gives agents the Workbench's chat tools.

## Works with

- [[generated/concepts/BrowserPane.md|BrowserPane]]
- [[generated/concepts/Chat-to-Chat Tools.md|Chat-to-Chat Tools]]
- [[generated/concepts/MCP Server Configuration.md|MCP Server Configuration]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]

## Where it lives

- `src/main/`: The Electron main process.
  - `browser-mcp.mjs`: Stdio MCP server exposing BrowserPane tools and workbench chat tools to agents.
  - `browserAgent.ts`: Local HTTP server backing the browser MCP, plus MCP server and hook configs per chat.
  - `browserDrive.ts`: Serialized browser actions: navigate, back, forward, reload, screenshot, snapshot and element targeting.
  - `browser.ts`: Manages the BrowserPane web contents, URL sanitizing, console log and browser state.
