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

Chats can hold images, videos and pages drawn by agents. Chat media is served over a custom protocol, and a media source is only served if it resolves to a real file inside the allowed folders. The user can attach images in the composer. Agents can draw pages with `show_visual`; these are stored and shown in sandboxed frames. For a YouTube link, the app can fetch the video's captions and return them as a transcript.

## Works with

- [[generated/concepts/Agent Replies.md|Agent Replies]]
- [[generated/concepts/BrowserPane.md|BrowserPane]]
- [[generated/concepts/Slash Commands.md|Slash Commands]]

## Where it lives

- `src/main/`: The Electron main process.
  - `media.ts`: Custom workbench-media protocol serving chat media files and opening them.
  - `mediaFiles.ts`: Resolves a media source path safely to a real file inside allowed roots.
  - `visuals.ts`: Stores and serves agent-drawn HTML visuals via a sandboxed workbench-visual protocol.
  - `youtube.ts`: Fetches a YouTube video's captions and formats them as a timestamped transcript.
- `src/shared/`: Types and small pure helpers used by both the main process and the UI.
  - `media.ts`: Recognizes image and video sources and builds chat media URLs.
  - `youtube.ts`: YouTube transcript types, video id parsing and watch URL building.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `Markdown.tsx`: Memoized Markdown renderer with GFM, local media and embedded visual frames.
