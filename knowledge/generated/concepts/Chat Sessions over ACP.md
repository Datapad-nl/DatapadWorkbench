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

Every chat runs as an agent session over the Agent Client Protocol (ACP), on either `grok agent stdio` or the Claude Code ACP adapter. When the user sends a message, the renderer calls the IPC bridge and the main process starts or resumes the session for that chat. The turn's prompt goes to the agent process, and the main process streams events back and waits for the turn to end. Several chats can run at the same time, each in its own session, and each can be stopped or waited on separately.

## Works with

- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/IPC Bridge.md|IPC Bridge]]
- [[generated/concepts/Agent CLI Detection.md|Agent CLI Detection]]
- [[generated/concepts/Permission Modes.md|Permission Modes]]
- [[generated/concepts/MCP Server Configuration.md|MCP Server Configuration]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `grok.ts`: Runs chat turns and streams: start, stop, wait, live events and commands.
  - `acp.ts`: ACP session types, which agent process a session runs on, and turn-end waits.
  - `ipc.ts`: Registers IPC handlers, sends turns, and raises notices for chats and bots.
  - `grokCli.ts`: Locates the Grok CLI and probes its version, channel, models and status.
  - `claudeCli.ts`: Locates the Claude Code CLI, its ACP adapter, and probes sign-in status.
  - `ids.ts`: Generates ids, timestamps and chat titles from prompts.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `types.ts`: Core shared types: projects, messages, attachments, file hits, permission modes, plans.
