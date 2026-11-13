---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/shared
workbench_generated: true
---

# Slash Commands

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Typing / in the composer starts a slash command. Each agent has its own list of commands defined in shared code. As the user types, the list is filtered to the commands that match. When the prompt is sent, it is parsed into the command and its arguments.

## Works with

- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]
- [[generated/concepts/Chat Media and Visuals.md|Chat Media and Visuals]]

## Where it lives

- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `slash.ts`: Slash command definitions, per-agent lists, parsing and filtering as the user types.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `ChatPane.tsx`: The chat view: messages, live streaming reply, composer with images, PR chip and pane toggles.
