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

Agents control the BrowserPane through a stdio MCP server that the Workbench adds to each chat session. The agent calls a tool such as navigate or screenshot. The MCP script forwards the call to a local HTTP server in the main process, which runs it through the browser driver and returns the result. The same server also carries the Workbench's chat tools. The main process builds the MCP config and agent hooks that wire this server into each session.

## Works with

- [[generated/concepts/BrowserPane.md|BrowserPane]]
- [[generated/concepts/Chat-to-Chat Tools.md|Chat-to-Chat Tools]]
- [[generated/concepts/MCP Server Configuration.md|MCP Server Configuration]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `browserAgent.ts`: Local HTTP server behind the browser MCP; builds MCP server configs and agent hooks.
  - `browserDrive.ts`: Serialized browser actions: navigate, back, forward, reload, screenshot, snapshot, click, type.
  - `browser.ts`: Manages the BrowserPane web contents, URL sanitizing, console log and state.
