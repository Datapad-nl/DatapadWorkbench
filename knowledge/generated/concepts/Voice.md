---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Voice

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Voice input and output run locally in web workers, using onnxruntime-web. Whisper turns dictated speech into text, one request at a time, with a UI-thread fallback. Supertonic turns text into audio. Before a reply is read aloud, its Markdown is turned into speakable text, the language is chosen, and echoes of the user's own request are dropped. A provider tracks listening, transcribing and speaking and exposes them through `useVoice`. The settings modal sets the voice language and speed, and the main process handles the voice model status and microphone permission.

## Works with

- [[generated/concepts/Progress Cues.md|Progress Cues]]
- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]

## Where it lives

- `src/renderer/src/voice/`
  - `VoiceProvider.tsx`
  - `engine.ts`
  - `whisper.ts`
  - `asr.worker.ts`
  - `supertonic.ts`
  - `asideTts.worker.ts`
  - `ortAssets.ts`
  - `VoiceBlob.tsx`
- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `voice.ts`: Voice model status, its protocol, and microphone permission.
- `src/renderer/src/components/`
  - `Modals.tsx`
