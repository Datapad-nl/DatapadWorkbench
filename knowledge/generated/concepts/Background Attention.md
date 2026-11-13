---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/resources
workbench_generated: true
---

# Background Attention

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

When a chat that the user is not looking at needs them, for example to answer a question or a permission request, the app sends a notification and puts a badge on the Dock icon. The app keeps running when its window is closed, with a menu bar icon that lists the bots with their next scheduled run and the chats waiting for an answer. If the app was opened at login, it starts without a window.

## Works with

- [[generated/concepts/Agent Questions.md|Agent Questions]]
- [[generated/concepts/Permission Modes.md|Permission Modes]]
- [[generated/concepts/Scheduled Runs.md|Scheduled Runs]]
- [[generated/concepts/Progress Cues.md|Progress Cues]]

## Where it lives

- `src/main/`: The Electron main process.
  - `attention.ts`: Shows system notifications and the Dock badge for chats that need the user in background.
  - `index.ts`: App entry: creates the window, tray behavior, single instance, startup and clean quitting.
- `resources/`: Holds the app's icon artwork, which the packaging step and the main process use.
  - `trayTemplate.png`: Menu bar tray icon template image at standard resolution.
  - `trayTemplate@2x.png`: Retina (2x) version of the menu bar tray icon template.
  - `trayTemplate.svg`: Vector source artwork for the menu bar tray icon.
