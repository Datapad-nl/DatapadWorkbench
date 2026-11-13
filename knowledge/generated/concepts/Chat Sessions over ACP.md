---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Chat Sessions over ACP

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Every chat runs as a session of an agent CLI, either Grok Build or Claude Code, which the app talks to over the Agent Client Protocol (ACP) on stdio. When the user sends a prompt, the main process starts or reuses the agent session for that chat and passes it the prompt, along with the project's MCP servers and rules. The ACP layer handles session updates, modes and plan-exit prompts, and keeps turns in order. Several chats can run at once, each in its own session. A new chat's title comes from its first prompt.

## Works with

- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/Agent CLI Detection.md|Agent CLI Detection]]
- [[generated/concepts/Permission Modes.md|Permission Modes]]
- [[generated/concepts/MCP Server Configuration.md|MCP Server Configuration]]
- [[generated/concepts/IPC Bridge.md|IPC Bridge]]

## Where it lives

- `src/main/`: The Electron main process.
  - `acp.ts`: ACP session update types, agent process keys and waiting for a previous turn.
  - `grok.ts`: Runs chat turns on agents: streaming state, stopping, slash commands and live chat events.
  - `ipc.ts`: Registers IPC handlers, sends turns, forwards chat and index events and notifications.
  - `ids.ts`: Generates ids, timestamps and chat titles from prompts.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `mcp.ts`: MCP server types, parsing of the editor text, and conversion to ACP form.
  - `types.ts`: Core shared types: projects, messages, attachments, file hits, permission modes, plans.
