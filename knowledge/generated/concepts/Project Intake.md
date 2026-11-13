---
tags:
  - datapad-workbench
  - generated
  - concept
  - area/src/main
workbench_generated: true
---

# Project Intake

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

When a new project is added, the app can ask the user a few questions about it. First it scans the project folder for its stack, dependencies and other findings. From that scan it generates intake questions, and it falls back to standard questions if it cannot generate them. The user's answers are turned into session rules, which the project's chats are then given.

## Works with

- [[generated/concepts/Projects.md|Projects]]
- [[generated/concepts/Knowledge Vault.md|Knowledge Vault]]
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]]

## Where it lives

- `src/main/`: The Electron main process.
  - `intake.ts`: Project intake: decides when to run it, schedules it and turns answers into session rules.
  - `intakeQuestions.ts`: Generates project intake questions from a project scan, with fallback questions.
  - `projectScan.ts`: Scans a project folder for its stack, dependencies and other findings.
- `src/renderer/src/components/`: The React components that make up the Workbench window: the project sidebar, the chat pane with agent replies, and the right-hand panes for the browser, git, the knowledge graph and agent activity.
  - `Modals.tsx`: New project, settings and usage modals, including voice options and agent sign-in status.
