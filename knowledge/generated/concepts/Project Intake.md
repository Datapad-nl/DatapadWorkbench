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

When a project is new to the Workbench, an intake questionnaire is scheduled for it. The main process first scans the folder for its stack, dependencies and notable source findings. From that scan it generates intake questions, using fallback questions if generation fails. The user's answers become session rules that later chats in the project follow.

## Works with

- [[generated/concepts/Projects.md|Projects]]
- [[generated/concepts/Agent Questions.md|Agent Questions]]
- [[generated/concepts/CodeGraph Index.md|CodeGraph Index]]

## Where it lives

- `src/main/`: The Electron main process: it stores projects, chats, bots and settings on disk, runs chat turns through the Grok and Claude Code agents over ACP, and answers the renderer over IPC.
  - `intake.ts`: Project intake questionnaire: scheduling it and turning answers into session rules.
  - `intakeQuestions.ts`: Generates intake questions from a project scan, with fallback questions.
  - `projectScan.ts`: Scans a project folder for stack, dependencies and source findings.
