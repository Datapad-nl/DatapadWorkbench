---
tags:
  - design
  - bots
status: agreed, not built
---

# Bots (design)

A bot is a configured agent with its own instructions, skills and scheduled tasks. Bots are their own thing, separate from projects, and can be called from any project with `@`.

## Decisions

- **Scope:** global, each bot has its own folder.
- **Skills:** a bot uses the global skills plus its own.
- **Unattended runs:** tools on the bot's allowed list are approved automatically; anything else sends a notification and asks.
- **App closed:** Workbench starts at login and lives in the menu bar.
- **Output:** results stay in the bot's chat history.
- **@ from a project:** the bot works in the project's folder and answers back in that project's chat. The project's agent handles the message too.
- **Same folder at once:** accepted. The project's agent and the bot may both edit the project at the same time; [[Checkpoints]] cover undo.

## Shape

- **Bot:** saved in `userData/workbench/bots.json`. It has:
  - name and icon
  - agent and model
  - instructions
  - allowed tools and MCP servers
  - schedules
  - its folder
- **Name and avatar:** each bot has a name and an avatar image. The avatar can be SVG (animated too), PNG, JPEG, GIF, WebP or APNG.
  - The chosen file is copied into the bot's folder as `avatar.<ext>`, so the bot stays whole if the original file moves.
  - It's drawn as a round avatar with the name under it, and a small round badge at the bottom right (see the reference image). The badge shows the bot's state:
    - **running:** a run is in progress (animated).
    - **waiting for you:** a run is asking for permission or has a question; this one stands out most.
    - **scheduled:** idle, with a next run coming.
    - No badge when the bot is idle with nothing scheduled.
    - If several apply, the badge shows the highest one: waiting for you, then running, then scheduled.
  - The image is loaded through the app's media protocol ([[Chat Media]]) in an `<img>` tag, never inline. That way an SVG's scripts don't run, while its CSS/SMIL animation, and GIF/WebP/APNG animation, still play.
  - Where it shows: the "Bots" sidebar section, the bot's page, the `@` list in the composer, the bot's answers in a project chat, and notifications.
  - With no image set, the bot gets its initials on a color.
- **Bot folder:** also a plugin. Its `skills/` holds the bot's own skills, next to a plugin manifest (`.grok-plugin/plugin.json`, `.claude-plugin/plugin.json`).
- **Bot history:** chats that belong to a bot, not a project, in a "Bots" section of the sidebar.
  - A scheduled run works in the bot's folder, and each schedule has its own chat.
  - Each `@` call is its own run, labelled with the project it came from.
- **@ flow:**
  1. Typing `@` in the composer lists bots next to files.
  2. On send, the message goes to the project's agent as a normal turn.
  3. At the same time, a bot run starts in the project's folder. It doesn't block the project chat; see `delegateTask` in `src/main/chatTools.ts`.
  4. When the run is done, the bot's answer is posted in the project chat as a message from the bot, with a link to the run. The project's agent sees it on its next turn.
- **Instructions:** passed as session rules (`sessionRules` in `src/main/acp.ts`): `_meta.rules` for Grok, an appended system prompt for Claude Code.
- **Skills at run time:**
  - Grok: each bot gets its own `grok agent --no-leader stdio --plugin-dir <bot folder>` process, because `--plugin-dir` applies to the whole process. Normal chats keep the shared process.
  - Claude Code: the plugin is passed when the session starts, through the options the app already sends with each session.
- **Schedules:** reuse the scheduler in `src/main/chatTools.ts` (`at` / cron, missed runs are caught up when the app starts), managed from the bot's page.
- **Permissions:** auto-approve the bot's allowed tools; otherwise use `notifyChat` in `src/main/attention.ts`, and clicking the notification opens the question.
- **Background:** `app.setLoginItemSettings` (open at login, hidden), a menu bar `Tray` (bots, next runs, questions waiting, Open, Quit), and the window closing doesn't quit the app.
- **Optional:** an `ask_bot` tool next to `delegate`, so a project's agent can call a bot itself.

## Checked

- `grok plugin validate` accepts a plugin folder with `skills/<name>/SKILL.md` and a `.grok-plugin/plugin.json` manifest.
- In live ACP sessions started in an unrelated folder, a bot plugin's skill appears only when the plugin is given:
  - **Grok:** `grok agent --no-leader --plugin-dir <bot folder> stdio` lists the skill under its bare name (`botcheck-hello`).
  - **Claude Code:** `_meta.claudeCode.options.plugins: [{ type: 'local', path: <bot folder> }]` in `session/new` lists it as `<plugin name>:<skill>` (`botplug:botcheck-hello`). The adapter spreads these options into the SDK, and `plugins` is one of the options that rebuilds a session.
- Grok doesn't prefix the skill with the plugin name, so a bot skill can clash with a global skill of the same name. The skill editor warns when a name matches one of Grok's commands.
- Grok reads the plugin's skills again for each new session, so a skill added while the bot's process runs is picked up without a restart.

## Build order

1. Bot model, storage, a "Bots" section in the sidebar, and an editor (name, avatar, instructions, agent, allowed tools).
2. Bot skills in the bot's folder; loading them per run (needs the two checks above).
3. Schedules on the bot's page.
4. `@bot` in the composer and the answer posted back to the project chat.
5. Auto-approval of allowed tools, notifications for the rest.
6. Start at login, the menu bar icon, keep running when the window closes.
