---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Agent Replies

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

An agent's reply is shown as Markdown, with GitHub-style formatting, local media and embedded visuals. The reply is split at its step breaks, and earlier steps are folded away so the latest one is easy to see. The Markdown renderer is memoized, so a reply that keeps growing does not make the whole message redraw.

## Works with

- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/Chat Media and Visuals.md|Chat Media and Visuals]]
- [[generated/concepts/Activity Feed.md|Activity Feed]]

## Where it lives

- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `AgentReply.tsx`: Renders an agent reply, folding earlier steps away and showing visual blocks.
  - `Markdown.tsx`: Memoized Markdown renderer with GFM, local media and embedded visual frames.
  - `ChatPane.tsx`: The chat view: messages, live streaming reply, composer with images, PR chip and pane toggles.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `steps.ts`: Splits a reply at its step breaks and returns it as plain markdown.
