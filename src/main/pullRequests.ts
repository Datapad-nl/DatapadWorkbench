import { execFile } from "child_process";
import { homedir } from "os";
import type { Chat, ChatPullRequest } from "../shared/types";
import { callerChat, chatRunning, emitChat, send } from "./chatTools";
import { chatWorkingDir } from "./git";
import { listChats, listProjects, mutateChat } from "./store";

/**
 * GitHub pull requests linked to a chat (`link_pr`, `pr_status`, `unlink_pr`), read with the
 * GitHub CLI. A watched PR is checked every minute; when its checks finish, a review comes in
 * or it closes, the chat gets a message so its agent can act on it.
 */

type GhCheck = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
};
type GhReview = { author?: { login?: string }; state?: string; body?: string };
type GhPr = {
  number: number;
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  reviewDecision?: string | null;
  statusCheckRollup?: GhCheck[] | null;
  reviews?: GhReview[] | null;
};

const FIELDS =
  "number,url,title,state,isDraft,reviewDecision,statusCheckRollup,reviews";

function gh(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      { cwd, env: process.env, timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reject(
            new Error(
              "The GitHub CLI (gh) is not installed. Install it, then run `gh auth login`.",
            ),
          );
        }
        reject(new Error((stderr || error.message).trim()));
      },
    );
  });
}

async function fetchPr(cwd: string, ref: string | undefined): Promise<GhPr> {
  try {
    return JSON.parse(
      await gh(cwd, ["pr", "view", ...(ref ? [ref] : []), "--json", FIELDS]),
    ) as GhPr;
  } catch (error) {
    if (ref) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Found no pull request for the current branch (${reason}). Pass a PR number or URL.`,
    );
  }
}

function outcome(check: GhCheck): "pending" | "passed" | "failed" {
  if (check.__typename === "StatusContext" || (check.state && !check.status)) {
    if (check.state === "SUCCESS") return "passed";
    return check.state === "PENDING" || check.state === "EXPECTED"
      ? "pending"
      : "failed";
  }
  if (check.status !== "COMPLETED") return "pending";
  return ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion ?? "")
    ? "passed"
    : "failed";
}

function summarise(pr: GhPr, watch: boolean): ChatPullRequest {
  const checks = (pr.statusCheckRollup ?? []).map((check) => ({
    name: check.name || check.context || "check",
    outcome: outcome(check),
  }));
  const passed = checks.filter((check) => check.outcome === "passed").length;
  const pending = checks.filter((check) => check.outcome === "pending").length;
  const failed = checks
    .filter((check) => check.outcome === "failed")
    .map((check) => check.name);
  const parts = [
    passed ? `${passed} passed` : "",
    pending ? `${pending} running` : "",
    failed.length
      ? `${failed.length} failed (${failed.slice(0, 5).join(", ")}${failed.length > 5 ? ", …" : ""})`
      : "",
  ].filter(Boolean);
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    checks: !checks.length
      ? "none"
      : pending
        ? "pending"
        : failed.length
          ? "failing"
          : "passing",
    checksSummary: parts.join(", ") || "no checks",
    review: pr.reviewDecision || null,
    reviewCount: (pr.reviews ?? []).length,
    watch: watch && pr.state === "OPEN",
    checkedAt: new Date().toISOString(),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Review text without the HTML comments and tags bots put in. */
function plain(text: string | undefined): string {
  return (text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n\s*\n(\s*\n)+/g, "\n\n")
    .trim();
}

const REVIEW_STATE: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

function statusText(pr: ChatPullRequest, gh?: GhPr): string {
  const lines = [
    `#${pr.number} ${pr.title}`,
    pr.url,
    `State: ${pr.state.toLowerCase()}${pr.isDraft ? " (draft)" : ""}`,
    `Checks: ${pr.checksSummary}`,
    `Review: ${pr.review ? pr.review.toLowerCase().replace(/_/g, " ") : "none required"} · ${pr.reviewCount} review${pr.reviewCount === 1 ? "" : "s"}`,
    `Watching: ${pr.watch ? "yes, this chat gets a message when checks finish, a review comes in or the PR closes" : "no"}`,
  ];
  const reviews = (gh?.reviews ?? []).slice(-5);
  for (const review of reviews) {
    const text = plain(review.body);
    const body = text ? `: ${clip(text.replace(/\s+/g, " "), 300)}` : "";
    lines.push(
      `- @${review.author?.login ?? "someone"} ${REVIEW_STATE[review.state ?? ""] ?? review.state?.toLowerCase()}${body}`,
    );
  }
  return lines.join("\n");
}

async function chatDir(
  chat: Pick<Chat, "projectId" | "worktreePath">,
): Promise<string> {
  const project = (await listProjects()).find(
    (item) => item.id === chat.projectId,
  );
  return chatWorkingDir(chat, project?.path) ?? homedir();
}

function prRef(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0)
    return String(value);
  if (typeof value === "string" && value.trim())
    return value.trim().replace(/^#/, "");
  return undefined;
}

export async function linkPr(input: {
  from?: unknown;
  pr?: unknown;
  watch?: unknown;
}): Promise<{ text: string }> {
  const caller = await callerChat(input.from);
  const pr = await fetchPr(await chatDir(caller), prRef(input.pr));
  const linked = summarise(pr, input.watch !== false);
  const chat = await mutateChat(caller.id, (next) => {
    next.pr = linked;
  });
  emitChat(chat);
  return { text: `Linked to this chat.\n${statusText(linked, pr)}` };
}

export async function prStatus(input: {
  from?: unknown;
  pr?: unknown;
}): Promise<{ text: string }> {
  const caller = await callerChat(input.from);
  const ref = prRef(input.pr);
  const linked = caller.pr;
  const pr = await fetchPr(await chatDir(caller), ref ?? linked?.url);
  const status = summarise(pr, linked?.url === pr.url ? linked.watch : false);
  if (linked?.url !== pr.url)
    return {
      text: `${statusText(status, pr)}\n(Not linked to this chat; link_pr links it.)`,
    };
  const chat = await mutateChat(caller.id, (next) => {
    next.pr = status;
  });
  emitChat(chat);
  return { text: statusText(status, pr) };
}

export async function unlinkPr(chatId: string): Promise<Chat> {
  const chat = await mutateChat(chatId, (next) => {
    next.pr = null;
  });
  emitChat(chat);
  return chat;
}

export async function unlinkCallerPr(input: {
  from?: unknown;
}): Promise<unknown> {
  const caller = await callerChat(input.from);
  if (!caller.pr) throw new Error("No pull request is linked to this chat.");
  await unlinkPr(caller.id);
  return { unlinked: caller.pr.url };
}

/** What changed between two checks of a watched PR, as lines for the chat. */
function changes(
  before: ChatPullRequest,
  after: ChatPullRequest,
  pr: GhPr,
): string[] {
  const notes: string[] = [];
  // Also when checks re-ran and finished within one interval, e.g. passing to failing.
  if (
    before.checks !== after.checks &&
    (after.checks === "passing" || after.checks === "failing")
  ) {
    notes.push(`Checks finished: ${after.checksSummary}.`);
  }
  for (const review of (pr.reviews ?? []).slice(before.reviewCount)) {
    const state =
      REVIEW_STATE[review.state ?? ""] ??
      review.state?.toLowerCase() ??
      "reviewed";
    const text = plain(review.body);
    const body = text
      ? `\n  > ${clip(text, 1500).replace(/\n/g, "\n  > ")}`
      : "";
    notes.push(
      `Review from @${review.author?.login ?? "someone"}: ${state}.${body}`,
    );
  }
  if (before.state !== after.state && after.state !== "OPEN")
    notes.push(`The pull request was ${after.state.toLowerCase()}.`);
  return notes;
}

function wakeMessage(pr: ChatPullRequest, notes: string[]): string {
  const open = pr.state === "OPEN";
  return [
    `Pull request #${pr.number} “${pr.title}” changed:`,
    ...notes.map((note) => `- ${note}`),
    "",
    open
      ? `Look into it and act on it if what to do is clear; otherwise tell me what needs deciding. \`gh pr checks ${pr.number}\` and \`gh pr view ${pr.number} --comments\` show the details.`
      : "Datapad Workbench has stopped watching it.",
  ].join("\n");
}

let watcher: NodeJS.Timeout | null = null;
let checking = false;

async function checkWatchedPrs(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    for (const summary of await listChats()) {
      const before = summary.pr;
      // A busy chat is checked again next time, so nothing it should hear about is lost.
      if (!before?.watch || chatRunning(summary.id)) continue;
      let pr: GhPr;
      try {
        pr = await fetchPr(await chatDir(summary), before.url);
      } catch {
        continue;
      }
      // The chat may have started a turn while gh ran.
      if (chatRunning(summary.id)) continue;
      const after = summarise(pr, true);
      const notes = changes(before, after, pr);
      const same = (
        [
          "state",
          "isDraft",
          "title",
          "checks",
          "checksSummary",
          "review",
          "reviewCount",
        ] as const
      ).every((key) => before[key] === after[key]);
      if (same && !notes.length) continue;
      let linked = false;
      const chat = await mutateChat(summary.id, (next) => {
        // link_pr, pr_status or unlink wrote newer data while gh ran; the next check uses it.
        linked =
          next.pr?.url === before.url &&
          next.pr.checkedAt === before.checkedAt;
        if (linked) next.pr = after;
      });
      if (!linked) continue;
      emitChat(chat);
      if (!notes.length) continue;
      const turn = await send(chat.id, wakeMessage(after, notes)).catch(
        () => null,
      );
      if (turn) {
        turn.done.catch(() => {});
        continue;
      }
      // Not delivered: restore the old sample so the next check reports these changes again.
      const restored = await mutateChat(summary.id, (next) => {
        if (next.pr?.checkedAt === after.checkedAt) next.pr = before;
      });
      emitChat(restored);
    }
  } finally {
    checking = false;
  }
}

export function startPrWatcher(): void {
  if (watcher) return;
  watcher = setInterval(() => void checkWatchedPrs().catch(() => {}), 60_000);
  setTimeout(() => void checkWatchedPrs().catch(() => {}), 10_000);
}
