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

- `src/renderer/src/voice/`: Gives the app voice input and output that run locally: Whisper speech recognition and Supertonic text-to-speech on onnxruntime-web, each in a web worker.
  - `VoiceProvider.tsx`: React context provider managing listening, transcribing and speaking state, exposed through useVoice.
  - `engine.ts`: Voice list and helpers for speakable text, language choice and dropping user echoes.
  - `whisper.ts`: Loads and shares the Whisper recognition pipeline for the worker and UI-thread fallback.
  - `asr.worker.ts`: Worker that transcribes audio to text, one request at a time.
  - `supertonic.ts`: Loads the Supertonic 3 model and synthesizes mono PCM audio from text.
  - `asideTts.worker.ts`: Worker that queues speech synthesis tasks, letting status lines jump ahead of reply sentences.
  - `ortAssets.ts`: Exports the bundled URLs of the onnxruntime-web module and WASM files.
  - `VoiceBlob.tsx`: An animated blob of rings that visualizes voice activity.
- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `voice.ts`: Voice model status, its protocol, and microphone permission.
- `src/renderer/src/components/`: The React components that make up the Workbench interface: the sidebar of projects, bots and chats, the chat pane with live agent replies, and the side panes for the browser, git, knowledge graph and subagents.
  - `Modals.tsx`: New project, settings (agent sign-in, voice language and speed), and usage modals.
