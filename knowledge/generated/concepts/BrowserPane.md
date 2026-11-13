---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# BrowserPane

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The BrowserPane is a web browser built into the Workbench window. Web pages are opened here instead of in an external browser. The main process owns the page: it keeps its state and console log, checks the URLs it is sent to, and attaches the page to the window. The renderer shows the pane among the right-hand panes. Both the user and the agents can drive it.

## Works with

- [[generated/concepts/Browser MCP Server.md|Browser MCP Server]]
- [[generated/concepts/Page Annotation.md|Page Annotation]]
- [[generated/concepts/Chat Media and Visuals.md|Chat Media and Visuals]]

## Where it lives

- `src/main/`: The Electron main process.
  - `browser.ts`: Manages the BrowserPane web contents, URL sanitizing, console log and browser state.
  - `browserDrive.ts`: Serialized browser actions: navigate, back, forward, reload, screenshot, snapshot and element targeting.
  - `contextMenu.ts`: Native right-click menu with spelling, links, editing, search and quoting selection into composer.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `BrowserPane.tsx`: The built-in browser pane, with page annotation and a queue of notes to send.
