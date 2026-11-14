import type {
  Attachment,
  Bot,
  Chat,
  ChatAgent,
  ChatEvent,
  ChatSummary,
  ChatWake,
  FileMention,
} from "../shared/types";
import { runningAdmitted, type BuiltinAgent } from "../shared/builtinAgents";
import { CONDUCTOR_EDIT_REFUSED, isFileEditTool } from "../shared/conductor";
import { nextCronRun } from "../shared/cron";
import { handoffOpening } from "../shared/handoff";
import { plainReply } from "../shared/steps";
import { chatAgentLabel, normalizeChatAgent } from "../shared/types";
import { addBotUnread, clearBotUnread, getBot, setBotChat } from "./bots";
import { endBotRun, startBotRun } from "./botRuns";
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
let closeSession: (sessionId: string) => Promise<void> = async () => {};

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
  /** Lets the agent drop a session a chat has moved on from. */
  closeSession?: (sessionId: string) => Promise<void>;
}): void {
  sendTurn = input.send;
  if (input.closeSession) closeSession = input.closeSession;
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

/**
 * A turn Workbench sends a chat by itself once its running turn has ended, such as after a secret was
 * saved. It resolves with that turn's reply, or undefined when none was sent.
 */
const followUps = new Map<string, Promise<Chat | null | undefined>>();

export function expectFollowUp(
  chatId: string,
  reply: Promise<Chat | null | undefined>,
): void {
  followUps.set(chatId, reply);
  void reply.finally(() => {
    if (followUps.get(chatId) === reply) followUps.delete(chatId);
  });
}

/** The chat's reply once the turns Workbench sent after this one have ended too. */
async function afterFollowUps(
  chatId: string,
  reply: Chat | null,
): Promise<Chat | null> {
  for (let next = followUps.get(chatId); next && reply; next = followUps.get(chatId)) {
    const followed = await next;
    if (followUps.get(chatId) === next) followUps.delete(chatId);
    if (followed !== undefined) reply = followed;
  }
  return reply;
}
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

/** `delivered`: the chat's own agent wrote it, so its next prompt need not bring it. */
async function postBotAnswer(
  input: { botId: string; fromChatId: string },
  name: string,
  runChatId: string,
  content: string,
  delivered = false,
): Promise<void> {
  const chat = await mutateChat(input.fromChatId, (latest) => {
    latest.messages.push({
      id: id(),
      role: "assistant",
      content,
      fromBot: { botId: input.botId, name, runChatId, ...(delivered ? { delivered } : {}) },
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
  if (existing && normalizeChatAgent(existing.agent) === bot.agent) return existing;
  // The bot's agent was changed in Settings. A chat that has not started switches to it; a started
  // one belongs to its agent's session, so it is kept and the bot gets a new chat.
  if (existing && !existing.grokSessionId && existing.messages.length === 0) {
    const switched = await mutateChat(existing.id, (chat) => {
      chat.agent = bot.agent;
    });
    emitChat(switched);
    return switched;
  }
  return makeBotChat(bot);
}

async function makeBotChat(bot: Bot): Promise<Chat> {
  const chat = await createChat("", { botId: bot.id, agent: bot.agent, title: bot.name });
  const saved = await setBotChat(bot.id, chat.id);
  emitChat(chat);
  emit?.({ type: "bot", bot: saved });
  return chat;
}

/** A fresh chat for the bot's Chat tab, as /new does for a project. The old chat is kept. */
export async function newBotChat(botId: string): Promise<Chat> {
  return makeBotChat(await getBot(botId));
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
    .then((first) => afterFollowUps(chat.id, first))
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
let recovered = false;

/** The chat is being deleted, so its run says nothing more. Otherwise the bot's chat could come back after it went. */
export function forgetBotRun(chatId: string): void {
  endBotRun(chatId);
}

/** Where a message from a scheduled run says it came from. */
function runSource(title: string): string {
  return title.replace(/^Scheduled: /, "");
}

/**
 * The bot tells the user something: a message from the bot in its own chat, with a toast, a notice
 * and one more unread. `inChat`: the text is already in `from`, which may be the bot's own chat.
 */
async function tellFromBot(
  botId: string,
  from: Pick<Chat, "id" | "title">,
  content: string,
  inChat = false,
): Promise<void> {
  const bot = await getBot(botId);
  const chat = await botChat(bot.id);
  const own = chat.id === from.id;
  if (!(own && inChat)) {
    await postBotAnswer({ botId: bot.id, fromChatId: chat.id }, bot.name, from.id, content, own);
  }
  await botMessage(bot.id, chat.id, content, own ? undefined : runSource(from.title));
}

/** The chats where a bot runs unattended and speaks with `notify`: its own, outside any project. */
function isBotsOwn(chat: Pick<Chat, "botId" | "projectId">): chat is Pick<Chat, "projectId"> & { botId: string } {
  return Boolean(chat.botId) && !chat.projectId;
}

/** `notify`: the one way a bot's unattended run reaches the user. */
export async function notifyFromBot(input: {
  from?: unknown;
  message?: unknown;
}): Promise<unknown> {
  const caller = await callerChat(input.from);
  if (!isBotsOwn(caller)) {
    throw new Error("notify is for a bot's own chats. Here, your answer is posted where you were asked.");
  }
  const message = optionalText(input.message);
  if (!message) throw new Error("Pass the message for the user.");
  await tellFromBot(caller.botId, caller, message);
  return { sent: true };
}

const MAX_FOLLOW_UP_MINUTES = 366 * 24 * 60;

function wakeTime(at: unknown, minutes: unknown): Date {
  const inMinutes = typeof minutes === "number" && Number.isFinite(minutes) ? minutes : undefined;
  const atText = optionalText(at);
  if ((inMinutes === undefined) === !atText) throw new Error("Pass either at or minutes.");
  if (inMinutes === undefined) return firstRun(undefined, atText);
  if (inMinutes < 1 || inMinutes > MAX_FOLLOW_UP_MINUTES) {
    throw new Error("Pass minutes from 1 up to a year.");
  }
  return new Date(Date.now() + inMinutes * 60_000);
}

/** `follow_up`: this chat wakes once, later, in the session it is set from. One per chat; a new one replaces it. */
export async function setFollowUp(input: {
  from?: unknown;
  at?: unknown;
  minutes?: unknown;
  note?: unknown;
}): Promise<unknown> {
  const caller = await callerChat(input.from);
  if (!isBotsOwn(caller)) throw new Error("follow_up is for a bot's own chats.");
  const note = optionalText(input.note);
  if (!note) throw new Error("Pass the note: what to check, and why.");
  const at = wakeTime(input.at, input.minutes);
  const chat = await mutateChat(caller.id, (latest) => {
    latest.wake = { at: at.toISOString(), note, sessionId: latest.grokSessionId ?? null };
  });
  emitChat(chat);
  return { chatId: chat.id, at: at.toString(), replaced: caller.wake ? caller.wake.note : undefined };
}

export async function cancelFollowUp(chatId: string): Promise<Chat> {
  const chat = await mutateChat(chatId, (latest) => {
    latest.wake = null;
  });
  emitChat(chat);
  return chat;
}

/** The run that started at `startedAt` is over: nothing is left to recover at the next start. */
async function finishUnattended(chatId: string, startedAt: string): Promise<void> {
  const chat = await mutateChat(chatId, (latest) => {
    // A later run in this chat has marked it since; that one is still going.
    if (latest.unattended?.startedAt === startedAt) latest.unattended = null;
  }).catch(() => null);
  if (chat) emitChat(chat);
}

/** The session a chat leaves behind is let go, unless the chat is back in it. */
function closeLeftSession(sessionId: string | null | undefined, current: string | null | undefined): void {
  if (sessionId && sessionId !== current) void closeSession(sessionId).catch(() => {});
}

/** Send each due schedule's prompt, and each due follow-up, to its chat. A run missed while the app was closed runs once at start. */
async function runDueSchedules(): Promise<void> {
  if (checking || !sendTurn) return;
  checking = true;
  try {
    if (!recovered) {
      recovered = true;
      await recordInterruptedRuns();
    }
    const now = new Date();
    for (const summary of await listChats()) {
      // Busy with the last run or the user: try again on the next check.
      if (chatRunning(summary.id)) continue;
      const nextRunAt = summary.schedule?.nextRunAt;
      if (nextRunAt && Date.parse(nextRunAt) <= now.getTime()) await runSchedule(summary, now);
      else if (summary.wake && Date.parse(summary.wake.at) <= now.getTime()) await runFollowUp(summary, now);
    }
  } finally {
    checking = false;
  }
}

async function runSchedule(summary: ChatSummary, now: Date): Promise<void> {
  const schedule = summary.schedule!;
  let next: string | null = null;
  try {
    next = schedule.cron
      ? (nextCronRun(schedule.cron, now)?.toISOString() ?? null)
      : null;
  } catch {
    next = null;
  }
  // A bot's schedule outside a project runs unattended, never in the bot's chat itself.
  const bot = isBotsOwn(summary) ? await getBot(summary.botId).catch(() => null) : null;
  const botId = bot && bot.chatId !== summary.id ? bot.id : null;
  // The user may have started a turn here meanwhile: try again on the next check.
  if (chatRunning(summary.id)) return;
  const startedAt = now.toISOString();
  let leftSession: string | null = null;
  const marked = await mutateChat(summary.id, (latest) => {
    // Each run of a bot starts fresh: what it needs from earlier runs is in its memory.
    if (botId) {
      leftSession = latest.grokSessionId ?? null;
      latest.grokSessionId = null;
    }
    latest.unattended = { kind: "schedule", startedAt };
  }).catch(() => null);
  // Deleted since the list was read.
  if (!marked) return;
  closeLeftSession(leftSession, null);
  const botRun = botId ? startBotRun(summary.id, { botId, kind: "schedule" }) : null;
  let run: { done: Promise<Chat | null> };
  try {
    run = await send(summary.id, schedule.prompt);
  } catch {
    if (botRun) endBotRun(summary.id, botRun);
    await finishUnattended(summary.id, startedAt);
    // Not started, so the run is still due: the next check tries again.
    return;
  }
  run.done.then(
    () => {
      if (botRun) endBotRun(summary.id, botRun);
    },
    async (error: unknown) => {
      // Kept in the chat: the run's live error is gone once the window misses it.
      const text = await recordFailedRun(summary.id, "The scheduled run failed", error);
      if (botRun && endBotRun(summary.id, botRun)) await tellFromBot(botRun.botId, summary, text);
    },
  )
    .catch(() => {})
    .finally(() => void finishUnattended(summary.id, startedAt));
  const chat = await mutateChat(summary.id, (latest) => {
    // Changed or cancelled while the run started: leave the user's schedule alone.
    if (latest.schedule?.nextRunAt !== schedule.nextRunAt) return;
    latest.schedule = next
      ? { ...latest.schedule, nextRunAt: next, lastRunAt: now.toISOString() }
      : null;
  }).catch(() => null);
  if (chat) emitChat(chat);
}

async function runFollowUp(summary: ChatSummary, now: Date): Promise<void> {
  const listed = summary.wake!;
  // Only a bot's own chat sets one.
  if (!isBotsOwn(summary)) {
    await cancelFollowUp(summary.id).catch(() => null);
    return;
  }
  // Its bot tells the user the outcome. A bot that is gone takes its chats along, so try again later.
  const bot = await getBot(summary.botId).catch(() => null);
  if (!bot || chatRunning(summary.id)) return;
  const startedAt = now.toISOString();
  let wake: ChatWake | null = null;
  let leftSession: string | null = null;
  const woken = await mutateChat(summary.id, (latest) => {
    // Cancelled or replaced since the list was read.
    if (!latest.wake || latest.wake.at !== listed.at || latest.wake.note !== listed.note) return;
    wake = latest.wake;
    latest.wake = null;
    // Back in the session it was set from, even if a scheduled run has started another since.
    leftSession = latest.grokSessionId ?? null;
    if (wake.sessionId) latest.grokSessionId = wake.sessionId;
    latest.unattended = { kind: "followUp", startedAt };
  }).catch(() => null);
  const due = wake as ChatWake | null;
  if (!woken || !due) return;
  emitChat(woken);
  if (due.sessionId) closeLeftSession(leftSession, due.sessionId);
  const botRun = startBotRun(summary.id, { botId: bot.id, kind: "followUp", note: due.note });
  let run: { done: Promise<Chat | null> };
  try {
    run = await send(summary.id, `Follow-up: ${due.note}`);
  } catch {
    endBotRun(summary.id, botRun);
    // Not started: it stays due, and the next check tries again.
    const kept = await mutateChat(summary.id, (latest) => {
      latest.wake ??= due;
      if (latest.unattended?.startedAt === startedAt) latest.unattended = null;
    }).catch(() => null);
    if (kept) emitChat(kept);
    return;
  }
  run.done.then(
    () => {
      endBotRun(summary.id, botRun);
    },
    async (error: unknown) => {
      const text = await recordFailedRun(summary.id, "The follow-up failed", error);
      if (endBotRun(summary.id, botRun)) await tellFromBot(bot.id, summary, text, true);
    },
  )
    .catch(() => {})
    .finally(() => void finishUnattended(summary.id, startedAt));
}

/** Writes why a run failed in its chat, and gives the text. */
async function recordFailedRun(chatId: string, what: string, error: unknown): Promise<string> {
  const reason = error instanceof Error ? error.message : String(error);
  const content = `${what}: ${reason}`;
  const chat = await mutateChat(chatId, (latest) => {
    latest.messages.push({
      id: id(),
      role: "assistant",
      content,
      createdAt: now(),
    });
  }).catch(() => null);
  if (chat) emitChat(chat);
  return content;
}

/**
 * Runs the app closed during are still marked at the next start. Each says so in its chat, and a bot's
 * run tells the user too, since a run that never finished would otherwise go unnoticed.
 */
async function recordInterruptedRuns(): Promise<void> {
  for (const summary of await listChats()) {
    const run = summary.unattended;
    if (!run || chatRunning(summary.id)) continue;
    const what = run.kind === "schedule" ? "The scheduled run" : "The follow-up";
    const content = `${what} that started ${new Date(run.startedAt).toLocaleString()} did not finish: Datapad Workbench closed during it.`;
    const chat = await mutateChat(summary.id, (latest) => {
      latest.unattended = null;
      latest.messages.push({ id: id(), role: "assistant", content, createdAt: now() });
    }).catch(() => null);
    if (!chat) continue;
    emitChat(chat);
    if (isBotsOwn(summary)) await tellFromBot(summary.botId, summary, content, true).catch(() => {});
  }
}

export function startScheduler(): void {
  if (scheduler) return;
  scheduler = setInterval(() => void runDueSchedules().catch(() => {}), 30_000);
  setTimeout(() => void runDueSchedules().catch(() => {}), 5_000);
}
