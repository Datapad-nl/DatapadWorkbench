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

The BrowserPane is a web view built into the Workbench, so pages open inside the app instead of an external browser. The main process manages its web contents, cleans up URLs, keeps the page's console log and tracks its state. Actions such as navigate, back, forward, reload, screenshot, snapshot, click and type run one at a time through a serialized driver. The renderer component shows the page next to the chat.

## Works with

- [[generated/concepts/Browser MCP Server.md|Browser MCP Server]]
- [[generated/concepts/Page Annotation.md|Page Annotation]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `browser.ts`: Manages the BrowserPane web contents, URL sanitizing, console log and state.
  - `browserDrive.ts`: Serialized browser actions: navigate, back, forward, reload, screenshot, snapshot, click, type.
  - `contextMenu.ts`: Native right-click menu with spelling, links, editing and quote-to-composer actions.
- `src/renderer/src/components/`
  - `BrowserPane.tsx`
