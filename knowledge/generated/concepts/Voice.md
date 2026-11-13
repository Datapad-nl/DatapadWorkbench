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

Voice input and output run locally on onnxruntime-web, each in its own web worker. For dictation, the Whisper model turns recorded audio into text, one request at a time, and can fall back to running on the UI thread. For reading replies aloud, Markdown is first turned into speakable text, the speech language is picked, and echoes of the user's own request are dropped; the Supertonic model then makes audio from the text. A React provider tracks whether the app is listening, transcribing or speaking, and an animated blob shows this. The main process reports the voice models' status and handles microphone access.

## Works with

- [[generated/concepts/Progress Cues.md|Progress Cues]]
- [[generated/concepts/Agent Replies.md|Agent Replies]]

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
- `src/main/`: The Electron main process.
  - `voice.ts`: Voice model status, voice file protocol and microphone access permission.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `Modals.tsx`: New project, settings and usage modals, including voice options and agent sign-in status.
