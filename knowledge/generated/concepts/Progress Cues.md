---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/renderer
workbench_generated: true
---

# Progress Cues

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

During a long turn, the app keeps the user informed about what the agent is doing. It follows the chat's current activity and decides when there is enough progress worth announcing. These announcements can be read aloud as short status lines, which go ahead of reply sentences in the speech queue.

## Works with

- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]]
- [[generated/concepts/Voice.md|Voice]]
- [[generated/concepts/Background Attention.md|Background Attention]]

## Where it lives

- `src/renderer/src/`: The React UI of the Workbench.
  - `progress.ts`: Works out a chat's running progress and when to speak a still-working cue.
- `src/renderer/src/voice/`: Gives the app voice input and output that run locally: Whisper speech recognition and Supertonic text-to-speech on onnxruntime-web, each in a web worker.
  - `asideTts.worker.ts`: Worker that queues speech synthesis tasks, letting status lines jump ahead of reply sentences.
