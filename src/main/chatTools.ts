import type {
  Attachment,
  Bot,
  Chat,
  ChatAgent,
  ChatEvent,
  FileMention,
} from "../shared/types";
import { runningAdmitted, type BuiltinAgent } from "../shared/builtinAgents";
import { CONDUCTOR_EDIT_REFUSED, isFileEditTool } from "../shared/conductor";
import { nextCronRun } from "../shared/cron";
import { handoffOpening } from "../shared/handoff";
import { plainReply } from "../shared/steps";
import { chatAgentLabel, normalizeChatAgent } from "../shared/types";
import { addBotUnread, clearBotUnread, getBot, setBotChat } from "./bots";
import { addChatWorktree, dropWorktreeIfUnchanged } from "./git";
import { id, now } from "./ids";
import {
  createChat,
  getChat,
  getMaxSubagents,
  getSubagentModel,
  listChats,
  listProjects,
  mutateChat,
  saveHandoff,
} from "./store";

/**
 * The `workbench` MCP tools that reach other chats: delegate, nudge, list_chats,
 * read_chat, start_chat and the scheduled tasks. Turns run through the same path as a send from
 * the chat box, which ipc.ts hands over with `registerChatTools`.
 */

type SendTurn = (
  chatId: string,
  content: string,
  attachments?: Attachment[],
  mentions?: FileMention[],
) => Promise<{ chat: Chat; done: Promise<Chat | null> }>;

let sendTurn: SendTurn | null = null;
let emit: ((event: ChatEvent) => void) | null = null;
let streaming: (chatId: string) => boolean = () => false;
let builtinAgents: (chatId: string) => BuiltinAgent[] = () => [];
let notifyBot: (bot: Bot, chatId: string, text: string) => void = () => {};

// The streaming check is handed over too: importing grok.ts here would close an import cycle
// through acp.ts and browserAgent.ts, and grok.ts would then run before acp.ts is ready.
// Claude Code's own agents come the same way, for the same reason.
export function registerChatTools(input: {
  send: SendTurn;
  emit: (event: ChatEvent) => void;
  isStreaming: (chatId: string) => boolean;
  builtinAgents?: (chatId: string) => BuiltinAgent[];
  /** The system notification for a new message in a bot's chat. */
  notifyBot?: (bot: Bot, chatId: string, text: string) => void;
}): void {
  sendTurn = input.send;
  emit = input.emit;
  streaming = input.isStreaming;
  if (input.builtinAgents) builtinAgents = input.builtinAgents;
  if (input.notifyBot) notifyBot = input.notifyBot;
}

/** Whether a chat's turn is running. */
export function chatRunning(chatId: string): boolean {
  return streaming(chatId);
}

type Run = {
  done: Promise<void>;
  answer: string;
  error: string | null;
  finishedAt: number | null;
};

const runs = new Map<string, Run>();
/** How long a finished run waits for its caller to collect the answer. */
const RUN_KEEP_MS = 30 * 60_000;

function pruneRuns(): void {
  const cutoff = Date.now() - RUN_KEEP_MS;
  for (const [chatId, run] of runs) {
    if (run.finishedAt !== null && run.finishedAt < cutoff) runs.delete(chatId);
  }
}

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

/** Chats of the same project, or of the same bot. */
function sameOwner(a: Pick<Chat, "projectId" | "botId">, b: Pick<Chat, "projectId" | "botId">): boolean {
  return a.projectId === b.projectId && (a.botId ?? null) === (b.botId ?? null);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

async function openChat(
  from: Chat,
  input: { agent?: unknown; title?: unknown },
  fallbackTitle: string,
  worker?: { agent?: ChatAgent; model: string },
): Promise<Chat> {
  const title =
    typeof input.title === "string" && input.title.trim()
      ? clip(input.title.trim(), 80)
      : fallbackTitle;
  const chat = await createChat(from.projectId, {
    title,
    agent: worker?.agent ?? agentOf(input.agent),
    ...(worker ? { model: worker.model, parentChatId: from.id } : {}),
    // A bot's chat starts chats of the same bot.
    botId: from.botId,
  });
  emit?.({ type: "chat", chatId: chat.id, chat });
  return chat;
}

export async function send(
  chatId: string,
  content: string,
  attachments?: Attachment[],
  mentions?: FileMention[],
): Promise<{ done: Promise<Chat | null> }> {
  if (!sendTurn) throw new Error("Datapad Workbench is still starting.");
  return sendTurn(chatId, content, attachments, mentions);
}

/**
 * A bot asked with @ in a project chat. The bot runs in a chat of its own, in the project's folder,
 * next to the project's agent, and its answer is posted in the project chat once it is done.
 */
export async function askBot(input: {
  botId: string;
  fromChatId: string;
  content: string;
  attachments?: Attachment[];
  mentions?: FileMention[];
}): Promise<void> {
  let name = "The bot";
  let runChatId = "";
  try {
    const caller = await getChat(input.fromChatId);
    if (caller.botId) throw new Error("A bot is asked from a project chat.");
    const bot = await getBot(input.botId);
    name = bot.name;
    const project = (await listProjects()).find(
      (item) => item.id === caller.projectId,
    );
    const firstLine =
      input.content.trim().split("\n")[0] ||
      input.mentions?.[0]?.path ||
      "Question";
    const created = await createChat(caller.projectId, {
      botId: bot.id,
      agent: bot.agent,
      title: `${project?.name ?? "Project"}: ${clip(firstLine, 50)}`,
    });
    runChatId = created.id;
    const run = await mutateChat(created.id, (latest) => {
      latest.replyTo = caller.id;
    });
    emitChat(run);
    const { done } = await send(
      run.id,
      input.content,
      input.attachments,
      input.mentions,
    );
    const finished = await done;
    const reply = finished?.messages.at(-1);
    await postBotAnswer(
      input,
      name,
      runChatId,
      !finished
        ? "The run was deleted before it answered."
        : reply?.role === "assistant"
          ? plainReply(reply.content) || "(empty answer)"
          : "(no answer)",
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await postBotAnswer(input, name, runChatId, `Could not answer: ${reason}`).catch(
      () => {},
    );
  }
}

async function postBotAnswer(
  input: { botId: string; fromChatId: string },
  name: string,
  runChatId: string,
  content: string,
): Promise<void> {
  const chat = await mutateChat(input.fromChatId, (latest) => {
    latest.messages.push({
      id: id(),
      role: "assistant",
      content,
      fromBot: { botId: input.botId, name, runChatId },
      createdAt: now(),
    });
  });
  emitChat(chat);
}

// Opening the window and a run's answer can ask at the same time; they get the same chat.
const makingBotChats = new Map<string, Promise<Chat>>();

/** The bot's own chat, for the Chat tab of its window. Made the first time, and again if it was deleted. */
export function botChat(botId: string): Promise<Chat> {
  let pending = makingBotChats.get(botId);
  if (!pending) {
    pending = findOrMakeBotChat(botId).finally(() => makingBotChats.delete(botId));
    makingBotChats.set(botId, pending);
  }
  return pending;
}

async function findOrMakeBotChat(botId: string): Promise<Chat> {
  const bot = await getBot(botId);
  const existing = bot.chatId ? await getChat(bot.chatId).catch(() => null) : null;
  if (existing) return existing;
  const chat = await createChat("", { botId: bot.id, agent: bot.agent, title: bot.name });
  const saved = await setBotChat(bot.id, chat.id);
  emitChat(chat);
  emit?.({ type: "bot", bot: saved });
  return chat;
}

/** A new message in the bot's own chat: one more unread, and the window and the system are told. */
export async function botMessage(
  botId: string,
  chatId: string,
  text: string,
  source?: string,
): Promise<void> {
  const bot = await addBotUnread(botId);
  emit?.({ type: "bot", bot });
  emit?.({ type: "bot-message", botId, chatId, text, ...(source ? { source } : {}) });
  notifyBot(bot, chatId, text);
}

/** The user has seen the bot's chat. */
export async function markBotRead(botId: string): Promise<Bot> {
  const bot = await clearBotUnread(botId);
  emit?.({ type: "bot", bot });
  return bot;
}

export async function listProjectChats(from: unknown): Promise<unknown> {
  const caller = await callerChat(from);
  const chats = (await listChats()).filter((chat) => sameOwner(chat, caller));
  return {
    chats: chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      agent: chatAgentLabel(normalizeChatAgent(chat.agent)),
      model: chat.model,
      workerOf: chat.parentChatId,
      messages: chat.messageCount,
      running: chatRunning(chat.id),
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
  const chats = (await listChats()).filter((chat) => sameOwner(chat, caller));
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
  const head = `${chat.title} (${chat.id}) · ${chatAgentLabel(normalizeChatAgent(chat.agent))} · ${chat.messages.length} messages${chatRunning(chat.id) ? " · running" : ""}`;
  const body = messages
    .map((message) => `## ${message.role}\n\n${clip(plainReply(message.content), 8000)}`)
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

/**
 * Continues the caller's work in a new chat that starts from a handoff file instead of the whole
 * conversation. The new chat works in the same folder, on the same agent, model and mode, and
 * takes the pull request along. The caller stays in the sidebar, pointing at the chat after it.
 */
export async function handoffChat(input: {
  from?: unknown;
  summary?: unknown;
  next?: unknown;
  title?: unknown;
}): Promise<unknown> {
  const caller = await callerChat(input.from);
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  if (!summary)
    throw new Error("summary is empty. The new chat starts with nothing else, so write the handoff there.");
  if ((await runningSubagents(caller.id)) > 0)
    throw new Error("Subagents of this chat are still running. Hand off once they have reported back.");
  const next = typeof input.next === "string" ? input.next.trim() : "";
  const file = await saveHandoff(
    caller.id,
    `# Handoff from "${caller.title}"\n\n${summary}${next ? `\n\n## Next\n\n${next}` : ""}\n`,
  );
  const created = await createChat(caller.projectId, {
    botId: caller.botId,
    title:
      typeof input.title === "string" && input.title.trim()
        ? clip(input.title.trim(), 80)
        : caller.title,
    agent: normalizeChatAgent(caller.agent),
    model: caller.model,
  });
  const chat = await mutateChat(created.id, (latest) => {
    latest.handoffFrom = caller.id;
    latest.mode = caller.mode;
    latest.prePlanMode = caller.prePlanMode;
    latest.conductor = caller.conductor;
    latest.worktreePath = caller.worktreePath;
    latest.worktreeBranch = caller.worktreeBranch;
    latest.pr = caller.pr;
  });
  // One chat is woken for a watched pull request: the one the work goes on in.
  emitChat(
    await mutateChat(caller.id, (latest) => {
      latest.handoffTo = chat.id;
      latest.pr = null;
    }),
  );
  emitChat(chat);
  const opening = handoffOpening({ fromTitle: caller.title, fromId: caller.id, file, summary, next });
  (await send(chat.id, opening)).done.catch(() => {});
  return { chatId: chat.id, title: chat.title, file };
}

/**
 * The agent and Claude Code model of a worker. The model in Settings wins over the one the caller
 * asked for. Only Claude Code picks a model per chat, so a worker with a model runs there.
 */
async function workerSetup(input: {
  agent?: unknown;
  model?: unknown;
}): Promise<{ agent?: ChatAgent; model: string }> {
  const agent = agentOf(input.agent);
  if (agent === "grok") return { agent, model: "" };
  const asked = typeof input.model === "string" ? input.model.trim() : "";
  const model = (await getSubagentModel()) || asked;
  return { agent: model ? "claude" : agent, model };
}

/** Send `content` to a worker chat and keep its answer for `waitForDelegate`. */
async function startRun(
  chat: Chat,
  projectPath: string | null | undefined,
  content: string,
): Promise<void> {
  const run: Run = {
    done: Promise.resolve(),
    answer: "",
    error: null,
    finishedAt: null,
  };
  const { done: finished } = await send(chat.id, content);
  run.done = finished
    .then((done) => {
      const reply = done?.messages.at(-1);
      run.answer = reply?.role === "assistant" ? plainReply(reply.content) : "";
      if (!done) run.error = "The chat was deleted.";
    })
    .catch((error: unknown) => {
      run.error = error instanceof Error ? error.message : String(error);
    })
    .then(async () => {
      const latest = await getChat(chat.id);
      if (!projectPath || !latest.worktreePath || !latest.worktreeBranch)
        return;
      if (
        await dropWorktreeIfUnchanged(
          projectPath,
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
      run.finishedAt = Date.now();
    });
  pruneRuns();
  runs.set(chat.id, run);
}

type DelegateInput = {
  from?: unknown;
  brief?: unknown;
  agent?: unknown;
  model?: unknown;
  title?: unknown;
  worktree?: unknown;
};

/** The Agent tool calls let through per chat, by id, with when. */
const admittedAgents = new Map<string, Map<string, number>>();

function admittedOf(chatId: string): Map<string, number> {
  let admitted = admittedAgents.get(chatId);
  if (!admitted) admittedAgents.set(chatId, (admitted = new Map()));
  return admitted;
}

/** How many subagents of a chat run now: its workers and the agents Claude Code started in it. */
async function runningSubagents(chatId: string): Promise<number> {
  const workers = (await listChats()).filter(
    (item) => item.parentChatId === chatId && chatRunning(item.id),
  ).length;
  return (
    workers +
    runningAdmitted(builtinAgents(chatId), admittedOf(chatId), Date.now())
  );
}

/**
 * Answers Claude Code's question before an Agent tool call or a file edit of `chatId`. Refuses a
 * conductor's own edit; refuses an Agent call past the limit in Settings, and drops the model it
 * asked for when Settings fixes one for every subagent.
 */
export async function agentHook(
  chatId: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (isFileEditTool(body.tool_name)) {
    // An agent the conductor started does the work, so its edits go through.
    if (!chatId || body.agent_id) return {};
    const chat = await getChat(chatId).catch(() => null);
    if (!chat?.conductor) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: CONDUCTOR_EDIT_REFUSED,
      },
    };
  }
  const callId = typeof body.tool_use_id === "string" ? body.tool_use_id : "";
  // An agent of an agent is not in the chat's list, so nothing would say when it ends.
  if (!chatId || !callId || body.agent_id) return {};
  const most = await getMaxSubagents();
  const running = await runningSubagents(chatId);
  if (running >= most) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${running} of your subagents are running, and Settings allows ${most} at the same time. Wait for one to report back, then start this agent again.`,
      },
    };
  }
  admittedOf(chatId).set(callId, Date.now());
  const input =
    body.tool_input && typeof body.tool_input === "object"
      ? (body.tool_input as Record<string, unknown>)
      : {};
  // The model the call names wins over CLAUDE_CODE_SUBAGENT_MODEL, so the one from Settings needs it gone.
  if (!("model" in input) || !(await getSubagentModel())) return {};
  const { model: _asked, ...rest } = input;
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: rest },
  };
}

// Tasks handed out in the same turn start one after another, so each counts the ones before it.
let delegating: Promise<unknown> = Promise.resolve();

export function delegateTask(input: DelegateInput): Promise<unknown> {
  const started = delegating.then(() => startWorker(input));
  delegating = started.catch(() => undefined);
  return started;
}

async function startWorker(input: DelegateInput): Promise<unknown> {
  const caller = await callerChat(input.from);
  const brief = typeof input.brief === "string" ? input.brief.trim() : "";
  if (!brief) throw new Error("Pass the brief for the other agent.");
  const most = await getMaxSubagents();
  const running = await runningSubagents(caller.id);
  if (running >= most) {
    throw new Error(
      `${running} of your subagents are running, and Settings allows ${most} at the same time. Wait for one to report back, then delegate this task again.`,
    );
  }
  let chat = await openChat(
    caller,
    input,
    `Delegated: ${clip(brief.split("\n")[0], 60)}`,
    await workerSetup(input),
  );
  const project = (await listProjects()).find(
    (item) => item.id === chat.projectId,
  );
  if (input.worktree === true && project?.path) {
    const worktree = await addChatWorktree(project.path, chat.id);
    chat = await mutateChat(chat.id, (latest) => {
      latest.worktreePath = worktree.path;
      latest.worktreeBranch = worktree.branch;
    });
    emit?.({ type: "chat", chatId: chat.id, chat });
  }
  await startRun(chat, project?.path, brief);
  return { chatId: chat.id, title: chat.title, model: chat.model };
}

/** Send a worker the caller delegated to back to its task. It keeps what it knows. */
export async function nudgeWorker(input: {
  from?: unknown;
  chat?: unknown;
  message?: unknown;
}): Promise<unknown> {
  const caller = await callerChat(input.from);
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) throw new Error("Pass the message for the worker.");
  const chat = await findProjectChat(caller, input.chat);
  if (chat.parentChatId !== caller.id)
    throw new Error(
      `“${chat.title}” is not a worker of this chat. Only a chat you started with delegate can be nudged.`,
    );
  if (chatRunning(chat.id))
    throw new Error(`“${chat.title}” is still working. Wait for its answer first.`);
  const project = (await listProjects()).find(
    (item) => item.id === chat.projectId,
  );
  await startRun(chat, project?.path, message);
  return { chatId: chat.id, title: chat.title, model: chat.model };
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
  if (run.finishedAt === null) return { done: false };
  runs.delete(chatId);
  const chat = await getChat(chatId).catch(() => null);
  return {
    done: true,
    answer: run.answer,
    error: run.error ?? undefined,
    worktreeBranch: chat?.worktreeBranch ?? undefined,
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** When a schedule first runs: the next time `cron` comes up, or once `at`. */
function firstRun(cron: string | undefined, at: string | undefined): Date {
  if (Boolean(cron) === Boolean(at))
    throw new Error("Pass either cron (repeating) or at (once).");
  if (cron) {
    const next = nextCronRun(cron, new Date());
    if (!next) throw new Error(`“${cron}” never comes up.`);
    return next;
  }
  const next = new Date(at!);
  if (Number.isNaN(next.getTime()))
    throw new Error(`Cannot read “${at}” as a date and time.`);
  if (next.getTime() < Date.now() - 60_000)
    throw new Error(`${next.toString()} is in the past.`);
  return next;
}

/** A schedule on a bot's page. It runs in a chat of its own, on the bot's agent. */
export async function scheduleBotTask(input: {
  botId?: unknown;
  prompt?: unknown;
  cron?: unknown;
  at?: unknown;
}): Promise<Chat> {
  const bot = await getBot(String(input.botId ?? ""));
  const prompt = optionalText(input.prompt);
  if (!prompt) throw new Error("Write what the bot should do.");
  const cron = optionalText(input.cron);
  const next = firstRun(cron, optionalText(input.at));
  const chat = await createChat("", {
    botId: bot.id,
    title: `Scheduled: ${clip(prompt.split("\n")[0], 50)}`,
    agent: bot.agent,
  });
  const saved = await mutateChat(chat.id, (latest) => {
    latest.schedule = { prompt, cron, nextRunAt: next.toISOString() };
  });
  emitChat(saved);
  return saved;
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
  const next = firstRun(cron, at);
  const chat = await openChat(
    caller,
    input,
    `Scheduled: ${clip(prompt.split("\n")[0], 50)}`,
  );
  const nextRunAt = next.toISOString();
  const saved = await mutateChat(chat.id, (latest) => {
    latest.schedule = { prompt, cron, nextRunAt };
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

/** Scheduled runs of a bot whose answer goes to the bot's chat once they finish. */
const botRuns = new Set<string>();

/** Whether a scheduled run of a bot is running in this chat. Its answer is told about in the bot's chat. */
export function isBotRun(chatId: string): boolean {
  return botRuns.has(chatId);
}

/** The chat is being deleted, so its run posts nothing. Otherwise the bot's chat could come back after it went. */
export function forgetBotRun(chatId: string): void {
  botRuns.delete(chatId);
}

/** Posts a scheduled run's answer in the bot's own chat, as a message from the bot. */
async function postRunAnswer(
  botId: string,
  run: Pick<Chat, "id" | "title">,
  content: string,
): Promise<void> {
  if (!botRuns.delete(run.id)) return;
  const bot = await getBot(botId);
  const chat = await botChat(bot.id);
  await postBotAnswer({ botId: bot.id, fromChatId: chat.id }, bot.name, run.id, content);
  await botMessage(bot.id, chat.id, content, run.title.replace(/^Scheduled: /, ""));
}

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
      if (chatRunning(summary.id)) continue;
      let next: string | null = null;
      try {
        next = schedule.cron
          ? (nextCronRun(schedule.cron, now)?.toISOString() ?? null)
          : null;
      } catch {
        next = null;
      }
      // A bot's schedule outside a project: its answer goes to the bot's chat, never the bot's chat itself.
      const bot =
        summary.botId && !summary.projectId
          ? await getBot(summary.botId).catch(() => null)
          : null;
      const botId = bot && bot.chatId !== summary.id ? bot.id : null;
      if (botId) botRuns.add(summary.id);
      try {
        const run = await send(summary.id, schedule.prompt);
        // Kept in the chat: the run's live error is gone once the window misses it.
        run.done.catch((error: unknown) => recordFailedRun(summary.id, error));
        if (botId) {
          run.done
            .then(
              (done) => {
                if (!done) return void botRuns.delete(summary.id);
                const reply = done.messages.at(-1);
                return postRunAnswer(
                  botId,
                  done,
                  reply?.role === "assistant"
                    ? plainReply(reply.content) || "(empty answer)"
                    : "(no answer)",
                );
              },
              (error: unknown) =>
                postRunAnswer(
                  botId,
                  summary,
                  `The scheduled run failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
            )
            .catch(() => {});
        }
      } catch {
        botRuns.delete(summary.id);
        // Not started, so the run is still due: the next check tries again.
        continue;
      }
      const chat = await mutateChat(summary.id, (latest) => {
        // Changed or cancelled while the run started: leave the user's schedule alone.
        if (latest.schedule?.nextRunAt !== schedule.nextRunAt) return;
        latest.schedule = next
          ? { ...latest.schedule, nextRunAt: next, lastRunAt: now.toISOString() }
          : null;
      }).catch(() => null);
      if (chat) emit?.({ type: "chat", chatId: chat.id, chat });
    }
  } finally {
    checking = false;
  }
}

async function recordFailedRun(chatId: string, error: unknown): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  const chat = await mutateChat(chatId, (latest) => {
    latest.messages.push({
      id: id(),
      role: "assistant",
      content: `The scheduled run failed: ${reason}`,
      createdAt: now(),
    });
  }).catch(() => null);
  if (chat) emit?.({ type: "chat", chatId: chat.id, chat });
}

export function startScheduler(): void {
  if (scheduler) return;
  scheduler = setInterval(() => void runDueSchedules().catch(() => {}), 30_000);
  setTimeout(() => void runDueSchedules().catch(() => {}), 5_000);
}
