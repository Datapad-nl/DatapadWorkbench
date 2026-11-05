import type { Chat, ChatAgent, ChatEvent } from "../shared/types";
import { nextCronRun } from "../shared/cron";
import { chatAgentLabel, normalizeChatAgent } from "../shared/types";
import { addChatWorktree, dropWorktreeIfUnchanged } from "./git";
import { isStreaming } from "./grok";
import {
  createChat,
  getChat,
  listChats,
  listProjects,
  mutateChat,
  saveChat,
} from "./store";

/**
 * The `workbench` MCP tools that reach other chats: delegate, list_chats,
 * read_chat, start_chat and the scheduled tasks. Turns run through the same path as a send from
 * the chat box, which ipc.ts hands over with `registerChatTools`.
 */

type SendTurn = (
  chatId: string,
  content: string,
) => Promise<{ chat: Chat; done: Promise<Chat | null> }>;

let sendTurn: SendTurn | null = null;
let emit: ((event: ChatEvent) => void) | null = null;

export function registerChatTools(input: {
  send: SendTurn;
  emit: (event: ChatEvent) => void;
}): void {
  sendTurn = input.send;
  emit = input.emit;
}

type Run = {
  done: Promise<void>;
  answer: string;
  error: string | null;
  finished: boolean;
};

const runs = new Map<string, Run>();

export async function callerChat(from: unknown): Promise<Chat> {
  if (typeof from !== "string" || !from)
    throw new Error("This chat is not known to Datapad Workbench.");
  return getChat(from);
}

export function emitChat(chat: Chat): void {
  emit?.({ type: "chat", chatId: chat.id, chat });
}

function agentOf(value: unknown): ChatAgent | undefined {
  return value === "grok" || value === "claude"
    ? normalizeChatAgent(value)
    : undefined;
}

function localTime(iso: string | null | undefined): string | undefined {
  return iso ? new Date(iso).toString() : undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

async function openChat(
  from: Chat,
  input: { agent?: unknown; title?: unknown },
  fallbackTitle: string,
): Promise<Chat> {
  const title =
    typeof input.title === "string" && input.title.trim()
      ? clip(input.title.trim(), 80)
      : fallbackTitle;
  const chat = await createChat(from.projectId, {
    title,
    agent: agentOf(input.agent),
  });
  emit?.({ type: "chat", chatId: chat.id, chat });
  return chat;
}

export async function send(
  chatId: string,
  content: string,
): Promise<{ done: Promise<Chat | null> }> {
  if (!sendTurn) throw new Error("Datapad Workbench is still starting.");
  return sendTurn(chatId, content);
}

export async function listProjectChats(from: unknown): Promise<unknown> {
  const caller = await callerChat(from);
  const chats = (await listChats()).filter(
    (chat) => chat.projectId === caller.projectId,
  );
  return {
    chats: chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      agent: chatAgentLabel(normalizeChatAgent(chat.agent)),
      messages: chat.messageCount,
      running: isStreaming(chat.id),
      updatedAt: chat.updatedAt,
      worktreeBranch: chat.worktreeBranch ?? undefined,
      schedule: chat.schedule
        ? {
            cron: chat.schedule.cron,
            nextRunAt: localTime(chat.schedule.nextRunAt),
            lastRunAt: localTime(chat.schedule.lastRunAt),
          }
        : undefined,
      self: chat.id === caller.id || undefined,
    })),
  };
}

/** A chat in the caller's project, by id or (part of) its title. */
async function findProjectChat(caller: Chat, value: unknown): Promise<Chat> {
  const wanted = typeof value === "string" ? value.trim() : "";
  if (!wanted) throw new Error("Pass a chat id or title.");
  const chats = (await listChats()).filter(
    (chat) => chat.projectId === caller.projectId,
  );
  const lower = wanted.toLowerCase();
  const match =
    chats.find((chat) => chat.id === wanted) ??
    chats.find((chat) => chat.title.toLowerCase() === lower) ??
    chats.find((chat) => chat.title.toLowerCase().includes(lower));
  if (!match)
    throw new Error(
      `No chat in this project matches “${wanted}”. Use list_chats to see them.`,
    );
  return getChat(match.id);
}

export async function readProjectChat(input: {
  from?: unknown;
  chat?: unknown;
  last?: unknown;
}): Promise<{ text: string }> {
  const chat = await findProjectChat(await callerChat(input.from), input.chat);
  const last =
    typeof input.last === "number" && input.last > 0
      ? Math.min(Math.floor(input.last), 200)
      : 20;
  const messages = chat.messages.slice(-last);
  const head = `${chat.title} (${chat.id}) · ${chatAgentLabel(normalizeChatAgent(chat.agent))} · ${chat.messages.length} messages${isStreaming(chat.id) ? " · running" : ""}`;
  const body = messages
    .map((message) => `## ${message.role}\n\n${clip(message.content, 8000)}`)
    .join("\n\n");
  const skipped = chat.messages.length - messages.length;
  return {
    text: `${head}${skipped > 0 ? `\n(${skipped} earlier messages left out)` : ""}\n\n${body || "(no messages)"}`,
  };
}

export async function startProjectChat(input: {
  from?: unknown;
  prompt?: unknown;
  agent?: unknown;
  title?: unknown;
}): Promise<unknown> {
  const caller = await callerChat(input.from);
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const chat = await openChat(caller, input, "New chat");
  if (prompt) (await send(chat.id, prompt)).done.catch(() => {});
  return {
    chatId: chat.id,
    title: chat.title,
    agent: chatAgentLabel(normalizeChatAgent(chat.agent)),
    sent: Boolean(prompt),
  };
}

export async function delegateTask(input: {
  from?: unknown;
  brief?: unknown;
  agent?: unknown;
  title?: unknown;
  worktree?: unknown;
}): Promise<unknown> {
  const caller = await callerChat(input.from);
  const brief = typeof input.brief === "string" ? input.brief.trim() : "";
  if (!brief) throw new Error("Pass the brief for the other agent.");
  let chat = await openChat(
    caller,
    input,
    `Delegated: ${clip(brief.split("\n")[0], 60)}`,
  );
  const project = (await listProjects()).find(
    (item) => item.id === chat.projectId,
  );
  if (input.worktree === true && project?.path) {
    const worktree = await addChatWorktree(project.path, chat.id);
    chat = await saveChat({
      ...chat,
      worktreePath: worktree.path,
      worktreeBranch: worktree.branch,
    });
    emit?.({ type: "chat", chatId: chat.id, chat });
  }

  const run: Run = {
    done: Promise.resolve(),
    answer: "",
    error: null,
    finished: false,
  };
  const { done: finished } = await send(chat.id, brief);
  run.done = finished
    .then((done) => {
      const reply = done?.messages.at(-1);
      run.answer = reply?.role === "assistant" ? reply.content : "";
      if (!done) run.error = "The chat was stopped.";
    })
    .catch((error: unknown) => {
      run.error = error instanceof Error ? error.message : String(error);
    })
    .then(async () => {
      const latest = await getChat(chat.id);
      if (!project?.path || !latest.worktreePath || !latest.worktreeBranch)
        return;
      if (
        await dropWorktreeIfUnchanged(
          project.path,
          latest.worktreePath,
          latest.worktreeBranch,
        )
      ) {
        const cleared = await mutateChat(chat.id, (next) => {
          next.worktreePath = null;
          next.worktreeBranch = null;
        });
        emit?.({ type: "chat", chatId: chat.id, chat: cleared });
      }
    })
    .catch(() => {
      // the answer still comes back if the worktree cleanup fails
    })
    .finally(() => {
      run.finished = true;
    });
  runs.set(chat.id, run);
  return { chatId: chat.id, title: chat.title };
}

/** Wait up to `ms` for a delegated chat; the MCP side polls so no request runs for long. */
export async function waitForDelegate(input: {
  chatId?: unknown;
  ms?: unknown;
}): Promise<unknown> {
  const chatId = typeof input.chatId === "string" ? input.chatId : "";
  const run = runs.get(chatId);
  if (!run) throw new Error("No delegated chat with that id is running.");
  const ms =
    typeof input.ms === "number"
      ? Math.min(Math.max(input.ms, 1000), 120_000)
      : 60_000;
  let timer: NodeJS.Timeout | null = null;
  await Promise.race([
    run.done,
    new Promise((resolve) => (timer = setTimeout(resolve, ms))),
  ]);
  if (timer) clearTimeout(timer);
  if (!run.finished) return { done: false };
  runs.delete(chatId);
  const chat = await getChat(chatId).catch(() => null);
  return {
    done: true,
    answer: run.answer,
    error: run.error ?? undefined,
    worktreeBranch: chat?.worktreeBranch ?? undefined,
  };
}

export async function scheduleTask(input: {
  from?: unknown;
  prompt?: unknown;
  cron?: unknown;
  at?: unknown;
  agent?: unknown;
  title?: unknown;
}): Promise<unknown> {
  const caller = await callerChat(input.from);
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new Error("Pass the prompt to run.");
  const cron =
    typeof input.cron === "string" && input.cron.trim()
      ? input.cron.trim()
      : undefined;
  const at =
    typeof input.at === "string" && input.at.trim()
      ? input.at.trim()
      : undefined;
  if (Boolean(cron) === Boolean(at))
    throw new Error("Pass either cron (repeating) or at (once).");
  let next: Date | null;
  if (cron) {
    next = nextCronRun(cron, new Date());
    if (!next) throw new Error(`“${cron}” never comes up.`);
  } else {
    next = new Date(at!);
    if (Number.isNaN(next.getTime()))
      throw new Error(`Cannot read “${at}” as a date and time.`);
    if (next.getTime() < Date.now() - 60_000)
      throw new Error(`${next.toString()} is in the past.`);
  }
  const chat = await openChat(
    caller,
    input,
    `Scheduled: ${clip(prompt.split("\n")[0], 50)}`,
  );
  const saved = await saveChat({
    ...chat,
    schedule: { prompt, cron, nextRunAt: next.toISOString() },
  });
  emit?.({ type: "chat", chatId: saved.id, chat: saved });
  return {
    chatId: saved.id,
    title: saved.title,
    cron,
    nextRunAt: next.toString(),
  };
}

export async function stopSchedule(chatId: string): Promise<Chat> {
  const chat = await mutateChat(chatId, (next) => {
    next.schedule = null;
  });
  emit?.({ type: "chat", chatId, chat });
  return chat;
}

export async function cancelProjectSchedule(input: {
  from?: unknown;
  chat?: unknown;
}): Promise<unknown> {
  const chat = await findProjectChat(await callerChat(input.from), input.chat);
  if (!chat.schedule) throw new Error(`“${chat.title}” has no schedule.`);
  await stopSchedule(chat.id);
  return { chatId: chat.id, title: chat.title, cancelled: true };
}

let scheduler: NodeJS.Timeout | null = null;
let checking = false;

/** Send each due schedule's prompt to its chat. A run missed while the app was closed runs once at start. */
async function runDueSchedules(): Promise<void> {
  if (checking || !sendTurn) return;
  checking = true;
  try {
    const now = new Date();
    for (const summary of await listChats()) {
      const schedule = summary.schedule;
      if (
        !schedule?.nextRunAt ||
        Date.parse(schedule.nextRunAt) > now.getTime()
      )
        continue;
      // Busy with the last run or the user: try again on the next check.
      if (isStreaming(summary.id)) continue;
      let next: string | null = null;
      try {
        next = schedule.cron
          ? (nextCronRun(schedule.cron, now)?.toISOString() ?? null)
          : null;
      } catch {
        next = null;
      }
      const chat = await mutateChat(summary.id, (latest) => {
        latest.schedule = next
          ? { ...schedule, nextRunAt: next, lastRunAt: now.toISOString() }
          : null;
      });
      emit?.({ type: "chat", chatId: chat.id, chat });
      try {
        (await send(chat.id, schedule.prompt)).done.catch(() => {});
      } catch {
        // a chat that cannot start now still keeps its schedule for the next run
      }
    }
  } finally {
    checking = false;
  }
}

export function startScheduler(): void {
  if (scheduler) return;
  scheduler = setInterval(() => void runDueSchedules().catch(() => {}), 30_000);
  setTimeout(() => void runDueSchedules().catch(() => {}), 5_000);
}
