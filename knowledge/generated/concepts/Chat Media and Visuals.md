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
- `src/shared/`
  - `media.ts`
  - `youtube.ts`
- `src/renderer/src/components/`
  - `Markdown.tsx`
  - `AgentReply.tsx`
