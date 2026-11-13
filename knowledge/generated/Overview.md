---
tags:
  - datapad-workbench
  - generated
  - overview
workbench_generated: true
---

# Overview

> This note is maintained by Datapad Workbench. Add your own writing in `notes/`.

Electron + Vite + React desktop app. Unofficial desktop for Grok Build. Projects in the sidebar, concurrent chats.
Stack: Electron + React + Vite + Tailwind.
Languages: javascript, tsx, typescript, yaml.
140 indexed files.
2959 symbols.

## How it works

- [[generated/concepts/Projects.md|Projects]] — A project is a folder on disk that the user adds to the sidebar, and each project holds its own chats.
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]] — Every chat runs as a session of an agent CLI, either Grok Build or Claude Code, which the app talks to over the Agent Client Protocol (ACP) on stdio.
- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]] — While a turn runs, the agent's output reaches the UI piece by piece as it is produced.
- [[generated/concepts/IPC Bridge.md|IPC Bridge]] — The renderer has no direct access to Electron or the file system.
- [[generated/concepts/Persistence Store.md|Persistence Store]] — Projects, chats, MCP servers and the theme choice are saved as JSON files in the app's userData/workbench folder.
- [[generated/concepts/Workspace State.md|Workspace State]] — In the renderer, a React context called the workspace holds the state that components share.
- [[generated/concepts/Session Import.md|Session Import]] — Sessions that already exist on disk for a project's folder are imported into the sidebar.
- [[generated/concepts/Agent CLI Detection.md|Agent CLI Detection]] — Before it can run chats, the app has to find the agent programs.
- [[generated/concepts/Permission Modes.md|Permission Modes]] — Each agent session has a permission mode that decides which tool calls the agent may run without asking.
- [[generated/concepts/Agent Questions.md|Agent Questions]] — An agent can stop in the middle of a turn to ask the user something, including asking for approval before it leaves plan mode.
- [[generated/concepts/BrowserPane.md|BrowserPane]] — The BrowserPane is a web browser built into the Workbench window.
- [[generated/concepts/Browser MCP Server.md|Browser MCP Server]] — Agents use the BrowserPane through an MCP server that runs over stdio.
- [[generated/concepts/Page Annotation.md|Page Annotation]] — The user can annotate a web page to give an agent feedback about it.
- [[generated/concepts/Chat-to-Chat Tools.md|Chat-to-Chat Tools]] — An agent can work with the other chats in its project.
- [[generated/concepts/Git Worktrees.md|Git Worktrees]] — A chat can run in its own git worktree, so its changes stay apart from the project's main checkout and from other chats.
- [[generated/concepts/Checkpoints.md|Checkpoints]] — Before an agent's tool changes a file, the app copies the file as it was.
- [[generated/concepts/Git Pane.md|Git Pane]] — The Git pane shows the state of the project's repository.
- [[generated/concepts/Knowledge Vault.md|Knowledge Vault]] — Each project can have a knowledge vault: a folder of Markdown notes that describes how the project works.
- [[generated/concepts/CodeGraph Index.md|CodeGraph Index]] — CodeGraph builds an index of the symbols in a project's code.
- [[generated/concepts/Project Intake.md|Project Intake]] — When a new project is added, the app can ask the user a few questions about it.
- [[generated/concepts/Pull Request Watching.md|Pull Request Watching]] — A GitHub pull request can be linked to a chat.
- [[generated/concepts/Activity Feed.md|Activity Feed]] — The main process records each chat's turns, notices and permission events as activity.
- [[generated/concepts/Agent Replies.md|Agent Replies]] — An agent's reply is shown as Markdown, with GitHub-style formatting, local media and embedded visuals.
- [[generated/concepts/Chat Media and Visuals.md|Chat Media and Visuals]] — Chats can hold images, videos and pages drawn by agents.
- [[generated/concepts/Slash Commands.md|Slash Commands]] — Typing / in the composer starts a slash command.
- [[generated/concepts/MCP Server Configuration.md|MCP Server Configuration]] — The user can add MCP servers for the agents to use, and edit or rename them in settings.
- [[generated/concepts/Background Attention.md|Background Attention]] — When a chat that the user is not looking at needs them, for example to answer a question or a permission request, the app sends a notification and puts a badge on the Dock icon.
- [[generated/concepts/Scheduled Runs.md|Scheduled Runs]] — Runs can be scheduled with five-field cron expressions.
- [[generated/concepts/Progress Cues.md|Progress Cues]] — During a long turn, the app keeps the user informed about what the agent is doing.
- [[generated/concepts/Voice.md|Voice]] — Voice input and output run locally on onnxruntime-web, each in its own web worker.

## Map

- [[Architecture]]
- [[Stack]]
- [[Rules]]
- [[Home]]
