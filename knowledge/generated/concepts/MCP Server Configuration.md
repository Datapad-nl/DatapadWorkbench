---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/shared
workbench_generated: true
---

# MCP Server Configuration

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The user can add MCP servers for the agents to use, and edit or rename them in settings. Servers are typed in as text in an editor, which is parsed and saved in the store. Servers can also be found by searching the official MCP Registry, which lists the ways each one can be installed. When a chat starts, the configured servers are converted to ACP form and passed to the agent session.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Persistence Store.md|Persistence Store]]
- [[generated/concepts/Browser MCP Server.md|Browser MCP Server]]

## Where it lives

- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `McpSettings.tsx`: Settings view to add, edit, rename and browse MCP servers from the registry.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `mcp.ts`: MCP server types, parsing of the editor text, and conversion to ACP form.
  - `mcpRegistry.ts`: Types for MCP Registry servers and the ways to install them.
- `src/main/`: The Electron main process.
  - `mcpRegistry.ts`: Searches the official MCP Registry for servers the Workbench can run.
  - `store.ts`: Persistent store for projects, chats, handoffs, MCP servers, theme and related settings.
