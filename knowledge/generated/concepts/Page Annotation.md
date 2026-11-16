---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Page Annotation

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The user can point at parts of a page in the BrowserPane and attach notes to them. Starting annotation injects picker scripts into the page, which let the user select an element and can be cancelled or cleaned up. Each pick becomes a note in a queue in the pane. The user then sends the queued notes to the chat as context for the agent.

## Works with

- [[generated/concepts/BrowserPane.md|BrowserPane]]
- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `annotatePicker.ts`: Scripts injected into the browser page to pick, cancel and clean up annotations.
  - `browser.ts`: Manages the BrowserPane web contents, URL sanitizing, console log and state.
- `src/renderer/src/components/`
  - `BrowserPane.tsx`
