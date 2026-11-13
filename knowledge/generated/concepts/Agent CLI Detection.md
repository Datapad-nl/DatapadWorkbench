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

Before it can run chats, the app has to find the agent programs. For Grok, it looks for the Grok CLI and checks its version, release channel and the models it offers. For Claude, it looks for the Claude CLI and its ACP adapter and checks whether the user is signed in. Sign-in itself happens outside the app, through `grok login` or the Claude CLI. The settings modal shows the result for each agent.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Session Import.md|Session Import]]

## Where it lives

- `src/main/`: The Electron main process.
  - `grokCli.ts`: Finds the grok binary and probes its version, channel, models and status, cached.
  - `claudeCli.ts`: Finds the Claude CLI, its ACP adapter command and probes sign-in and subscription.
  - `sessions.ts`: Reads Grok sessions from disk: listing, history, plans and plan approval state.
  - `env.ts`: Loads environment variables from a .env file.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `Modals.tsx`: New project, settings and usage modals, including voice options and agent sign-in status.
