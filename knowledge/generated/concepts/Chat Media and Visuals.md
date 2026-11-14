---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Chat Media and Visuals

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Chats can show images, videos, YouTube transcripts and HTML visuals that agents draw. A custom protocol serves media files to the chat, and media paths are resolved only within allowed root folders. An agent-drawn HTML visual is stored and shown in a sandboxed frame. The Markdown renderer recognizes image and video sources and visual blocks and draws them inline. YouTube links are parsed to a video id and the video's captions are fetched as a transcript.

## Works with

- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/Knowledge Vault.md|Knowledge Vault]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `media.ts`: Custom protocol serving chat media files and opening them.
  - `mediaFiles.ts`: Resolves media paths safely within allowed root folders.
  - `visuals.ts`: Stores and serves agent-drawn HTML visuals in sandboxed frames.
  - `youtube.ts`: Fetches and formats YouTube video caption transcripts.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `media.ts`: Recognizes image and video sources and builds chat media URLs.
  - `youtube.ts`: YouTube transcript types, video id parsing and watch URL building.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `Markdown.tsx`: Markdown renderer with GFM, local media, visual blocks and vault note links.
  - `AgentReply.tsx`: Renders an agent reply, folding earlier tool steps and showing visual blocks.
