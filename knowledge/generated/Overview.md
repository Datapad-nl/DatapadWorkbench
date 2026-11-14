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
181 indexed files.
3482 symbols.

## How it works

- [[generated/concepts/Projects.md|Projects]] — A project is a folder on disk that the user adds to the sidebar so they can run chats against it.
- [[generated/concepts/Chat Sessions over ACP.md|Chat Sessions over ACP]] — Every chat runs as an agent session over the Agent Client Protocol (ACP), on either `grok agent stdio` or the Claude Code ACP adapter.
- [[generated/concepts/Live Turn Streaming.md|Live Turn Streaming]] — While an agent works, its output reaches the UI as a stream of live events.
- [[generated/concepts/Agent CLI Detection.md|Agent CLI Detection]] — Before a chat can run, the Workbench has to find the agent CLIs installed on the machine.
- [[generated/concepts/Session Import.md|Session Import]] — Chats started outside the Workbench show up in the sidebar for their project.
- [[generated/concepts/Persistence Store.md|Persistence Store]] — The main process keeps all state on disk under Electron's userData/workbench folder: projects, handoffs, MCP servers, the theme, hidden sessions and bots.
- [[generated/concepts/IPC Bridge.md|IPC Bridge]] — The React UI never touches Electron directly.
- [[generated/concepts/Permission Modes.md|Permission Modes]] — Each chat session has a permission mode that sets what the agent may do without asking.
- [[generated/concepts/Checkpoints.md|Checkpoints]] — Before an agent's tool changes a file, the main process takes a snapshot of that file.
- [[generated/concepts/Git Worktrees.md|Git Worktrees]] — A chat can work in its own git worktree, so concurrent chats don't edit the same checkout.
- [[generated/concepts/Git Pane.md|Git Pane]] — The git pane is a right-side pane showing the repository state for the current project or worktree.
- [[generated/concepts/BrowserPane.md|BrowserPane]] — The BrowserPane is a web view built into the Workbench, so pages open inside the app instead of an external browser.
- [[generated/concepts/Browser MCP Server.md|Browser MCP Server]] — Agents control the BrowserPane through a stdio MCP server that the Workbench adds to each chat session.
- [[generated/concepts/Page Annotation.md|Page Annotation]] — The user can point at parts of a page in the BrowserPane and attach notes to them.
- [[generated/concepts/Chat-to-Chat Tools.md|Chat-to-Chat Tools]] — Agents can talk to other chats and to bots through tools on the Workbench MCP server.
- [[generated/concepts/Bots.md|Bots]] — A bot is a persistent agent with its own folder, avatar, session rules and Agent Skills.
- [[generated/concepts/Scheduled Runs.md|Scheduled Runs]] — A bot can run a prompt on a schedule written as a five-field cron expression.
- [[generated/concepts/MCP Server Configuration.md|MCP Server Configuration]] — Users can add their own MCP servers so agents get extra tools.
- [[generated/concepts/CodeGraph Index.md|CodeGraph Index]] — A project can have a CodeGraph index of its symbols that agents query.
- [[generated/concepts/Knowledge Vault.md|Knowledge Vault]] — Each project can have a knowledge vault of Markdown notes describing its modules and concepts.
- [[generated/concepts/Project Intake.md|Project Intake]] — When a project is new to the Workbench, an intake questionnaire is scheduled for it.
- [[generated/concepts/Agent Questions.md|Agent Questions]] — An agent can stop in the middle of a turn to ask the user a question.
- [[generated/concepts/Activity Feed.md|Activity Feed]] — The activity feed is a separate window showing what every chat's agent is doing.
- [[generated/concepts/Background Attention.md|Background Attention]] — The Workbench keeps running when its window is closed, and it tells the user when a chat needs them.
- [[generated/concepts/Chat Media and Visuals.md|Chat Media and Visuals]] — Chats can show images, videos, YouTube transcripts and HTML visuals that agents draw.
- [[generated/concepts/Slash Commands.md|Slash Commands]] — Typing a slash in the composer opens a list of commands.
- [[generated/concepts/Themes.md|Themes]] — The UI's colors and fonts come from a theme file.
- [[generated/concepts/Voice.md|Voice]] — Voice input and output run locally in web workers, using onnxruntime-web.
- [[generated/concepts/Progress Cues.md|Progress Cues]] — While a long turn runs, the Workbench gives short progress updates so the user knows what the agent is doing.
- [[generated/concepts/Pull Request Watching.md|Pull Request Watching]] — A chat can be linked to a GitHub pull request.

## Map

- [[Architecture]]
- [[Stack]]
- [[Rules]]
- [[Home]]
