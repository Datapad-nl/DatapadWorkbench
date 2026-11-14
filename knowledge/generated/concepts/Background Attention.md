---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Background Attention

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

The Workbench keeps running when its window is closed, and it tells the user when a chat needs them. The main process handles the window lifecycle, keeps a single instance and hides the app to the menu bar tray. When a chat finishes while the app is unfocused, the dock badge updates and a system notification appears. The tray menu lists bots, their next runs and chats that are waiting.

## Works with

- [[generated/concepts/Activity Feed.md|Activity Feed]]
- [[generated/concepts/Bots.md|Bots]]
- [[generated/concepts/Scheduled Runs.md|Scheduled Runs]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `attention.ts`: Dock badge and system notifications for chats that finish while the app is unfocused.
  - `trayMenu.ts`: Builds menu bar labels for bots, their next runs and waiting chats.
  - `index.ts`: App entry: window lifecycle, tray-hiding, single instance and clean quit.
- `resources/`: Holds the app's icon artwork, which the packaging step and the main process use.
  - `trayTemplate.png`: Menu bar tray icon template image at standard resolution.
  - `trayTemplate@2x.png`: Retina (2x) version of the menu bar tray icon template.
