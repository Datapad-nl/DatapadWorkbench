---
tags:
  - design
  - bots
status: draft, to tweak
---

# Bot chat (design)

How a bot talks to the user about things that don't belong to a project. It builds on [[Bots (design)]]. Mockup: `design/bot-chat-mockup.html`.

## Bot window

- Clicking a bot in the sidebar opens its window, in place of the chat pane, as the bot page does now.
- The window has two tabs in its title bar: **Chat**, the default, and **Settings**.
- **Chat:** a normal chat with the bot (the existing chat pane), working in the bot's folder. Each bot has one such chat; it is made the first time the window opens.
- **Settings:** today's bot page, unchanged: name, avatar, agent, model, instructions, tools, skills, schedules, folder, delete.

## Where messages come from

- **The bot's chat:** its replies to the user.
- **Scheduled runs:**
  - They keep running in a chat of their own, so the bot's chat doesn't fill up with each run's tool calls.
  - When a run is done, its answer is posted in the bot's chat as a message from the bot, with a chip ("⏱ Morning brief · open run") that opens the run.
  - This reuses how an @-run's answer is posted in a project chat (`replyTo`, `fromBot`). The bot's chat sees the posted answers on its next turn (`promptForBotAnswers`), so the user can reply to them there.
- The bot's instructions decide what a run says, for example "message me only when something needs me".

## New messages

- A message is new when it arrived while the bot's Chat tab was not open. Opening the Chat tab marks them all read.
- The time it was last read is saved per bot.
- **Sidebar:** the bot's row has a badge with the number of new messages. The avatar's state badge (running, waiting, scheduled) stays as it is.
- **Sidebar:** bots no longer list their chats under them; their runs are reached from the chips and from the schedules in Settings.
- **Chat tab:** a "New" line above the first unread message.

## Toast

- **When:** a new message comes in while the window has focus but the user isn't on that bot's Chat tab, for example in a project.
- **Where:** bottom right of the window.
- **What it shows:**
  - the bot's avatar and name
  - the run it came from
  - the first two lines of the message
  - an **Open** button, which goes to the bot's Chat tab
  - ✕ to close it
- **How long:** it hides after about 8 seconds and stays while the pointer is over it. Up to 3 stack; older ones go first.
- **Window in the background:** the system notification is used instead, as now ([[Background Attention]]).
- The app has no toast yet, so this is a new small component.

## Assumptions to check

1. One chat per bot in the Chat tab, rather than a list of conversations.
2. Every finished scheduled run posts its answer, rather than only when the bot calls a tool to message the user.
3. The bot's chats leave the sidebar; only the bot row with its badge stays.
4. A question or permission request from a scheduled run stays in that run, and gets the toast and the avatar's "waiting" badge, rather than being posted in the bot's chat.
