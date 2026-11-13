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

The user can annotate a web page to give an agent feedback about it. Starting an annotation injects scripts into the browser page that let the user pick an element. The user can cancel the pick, and the scripts are removed afterwards. Each finished note goes into a queue in the BrowserPane, and the queued notes are sent to the chat together.

## Works with

- [[generated/concepts/BrowserPane.md|BrowserPane]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]

## Where it lives

- `src/main/`: The Electron main process.
  - `annotatePicker.ts`: Scripts injected into the browser page to pick, cancel and clean up element annotations.
  - `browser.ts`: Manages the BrowserPane web contents, URL sanitizing, console log and browser state.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `BrowserPane.tsx`: The built-in browser pane, with page annotation and a queue of notes to send.
