---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# MCP Server Configuration

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Users can add their own MCP servers so agents get extra tools. In the settings view they list, edit and rename servers as text, or search the official MCP Registry and add a server it lists. The editor text is parsed into server definitions and saved in the store. When a session starts, the definitions are converted to ACP form and passed to the agent together with the Workbench's own browser server.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Browser MCP Server.md|Browser MCP Server]]
- [[generated/concepts/Persistence Store.md|Persistence Store]]

## Where it lives

- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `mcp.ts`: MCP server types, parsing of the editor text, and conversion to ACP form.
  - `mcpRegistry.ts`: Types for MCP Registry servers and the ways to install them.
- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `mcpRegistry.ts`: Searches the official MCP Registry for servers the Workbench can run.
  - `store.ts`: Persistent store: projects, handoffs, MCP servers, theme and hidden sessions.
  - `browserAgent.ts`: Local HTTP server behind the browser MCP; builds MCP server configs and agent hooks.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `McpSettings.tsx`: Settings view to list, edit, rename and browse-registry-add MCP servers.
