---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Bots

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

A bot is a persistent agent with its own folder, avatar, session rules and Agent Skills. Creating a bot sets up its folder and saves it. A bot's page has a Chat tab and a Settings tab, and skills can be added from skills.sh or well-known sites. When a bot posts a message, a toast appears in the bottom-right corner (at most three stacked), and read tracking marks bot chats as seen. Bots and their next runs also appear in the menu bar tray.

## Works with

- [[generated/concepts/Scheduled Runs.md|Scheduled Runs]]
- [[generated/concepts/Chat-to-Chat Tools.md|Chat-to-Chat Tools]]
- [[generated/concepts/Persistence Store.md|Persistence Store]]
- [[generated/concepts/Background Attention.md|Background Attention]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `bots.ts`: Creates, lists and updates bots, their folders, avatars and session rules.
  - `botSkills.ts`: Reads, saves, adds and trashes a bot's Agent Skills in its skills folder.
  - `skillsDirectory.ts`: Searches, previews and downloads skills from skills.sh or well-known sites.
  - `trayMenu.ts`: Builds menu bar labels for bots, their next runs and waiting chats.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `BotPage.tsx`: A bot window's title bar with Chat/Settings tabs, plus its Settings tab.
  - `BotSkills.tsx`: Manages a bot's own skills and finds and adds new ones from skills.sh.
  - `BotToasts.tsx`: Bottom-right toasts for new bot messages, stacking up to three, timing out.
- `src/renderer/src/`: The React UI root: it mounts the app, lays out the sidebar, chat and resizable right panes, and provides workspace and bot contexts to the components.
  - `bots.tsx`: Bots context, avatar loading and read tracking for bot chats.
- `design/`: Holds design references for the Workbench user interface: HTML mockups and written instructions for turning the current UI into the redesigned layout.
  - `bot-chat-mockup.html`: HTML mockup of the chat view for bots.
