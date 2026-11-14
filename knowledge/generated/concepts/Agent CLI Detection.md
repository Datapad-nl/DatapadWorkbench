---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Agent CLI Detection

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Before a chat can run, the Workbench has to find the agent CLIs installed on the machine. It locates the Grok CLI and checks its version, channel, models and sign-in status. It also locates the Claude Code CLI and its ACP adapter and checks whether the user is signed in. Claude Code plan usage limits are fetched and cached, and the status bar shows them with a countdown to the next reset. The settings modal shows sign-in state for each agent.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Session Import.md|Session Import]]
- [[generated/concepts/Slash Commands.md|Slash Commands]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `grokCli.ts`: Locates the Grok CLI and probes its version, channel, models and status.
  - `claudeCli.ts`: Locates the Claude Code CLI, its ACP adapter, and probes sign-in status.
  - `claudeUsage.ts`: Fetches and parses Claude Code plan usage limits, with caching and retry.
  - `sessions.ts`: Lists and reads Grok sessions on disk, plans and sign-in state.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `Modals.tsx`: New project, settings (agent sign-in, voice language and speed), and usage modals.
  - `StatusBar.tsx`: Status bar showing usage percent with reset countdown and index state.
