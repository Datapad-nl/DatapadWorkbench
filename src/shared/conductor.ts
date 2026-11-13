/** How many workers of one chat run at the same time, unless Settings says otherwise. */
export const DEFAULT_MAX_SUBAGENTS = 4
const MOST_SUBAGENTS = 10

/** The limit as a whole number from 1 to 10. Anything else is the default. */
export function normalizeMaxSubagents(value: unknown): number {
  const count = typeof value === 'number' ? Math.round(value) : NaN
  if (!Number.isFinite(count)) return DEFAULT_MAX_SUBAGENTS
  return Math.min(Math.max(count, 1), MOST_SUBAGENTS)
}

/** The limits Settings offers. */
export const MAX_SUBAGENTS_CHOICES = Array.from({ length: MOST_SUBAGENTS }, (_, index) => index + 1)

/** How many times the conductor sends a worker back to the same failed check before it changes course. */
export const MAX_NUDGES = 3

/** Claude Code tools that change files. A conductor chat is refused these; its workers are not. */
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function isFileEditTool(name: unknown): boolean {
  return typeof name === 'string' && FILE_EDIT_TOOLS.has(name)
}

/** Why a conductor's own edit is refused. */
export const CONDUCTOR_EDIT_REFUSED =
  'You are the conductor of this chat: you do not change files yourself, not even for a small fix. Give the change to a worker with `delegate`, or send the worker whose task it is back to it with `nudge`.'

/**
 * The conductor's role: it thinks, specifies, delegates and checks; workers started with `delegate` do the work.
 * A conductor chat gets this with every session, and /conduct sends it ahead of the job.
 * `workerModel` is the model Settings fixes for every worker; empty lets the conductor pick per task.
 * `maxWorkers` is how many workers Settings lets run at the same time.
 */
export function conductorRule(workerModel: string, maxWorkers: number): string {
  const model = workerModel
    ? `Every worker runs on ${workerModel}, as set in Settings.`
    : 'Pick the model for each worker with `model`: `fable` for a really hard task, such as a bug nobody has found, a design with many parts or a long change across the codebase; `opus` for work that needs judgement; `sonnet` for routine work; and `haiku` when a small, fast model is enough for the job. Fable costs the most, so keep it for the tasks that need it.'
  return [
    'You are the conductor of this job. You think, specify, delegate and check. You do not write code or change files yourself, not even a one-line fix: file edits are refused in this chat. Workers do all of the work.',
    '1. Think. Read what you need to understand the job, then make the plan: the architecture, the strategy, the tasks and which ones depend on which.',
    '2. Specify. Write each task as a brief for a worker, who starts with no context: the goal, the files involved, the constraints, what is already ruled out, and the acceptance criteria, a numbered list of checks the result must pass (behaviour, tests that must pass, what must not change). End the brief by asking the worker to report what it changed and, for each acceptance criterion, how it verified it.',
    `3. Delegate. Give each task to its own worker with the \`delegate\` tool of the \`workbench\` MCP server. Start tasks that do not depend on each other in the same turn, so they run side by side; give workers that edit files at the same time their own worktree. ${model} At most ${maxWorkers} ${maxWorkers === 1 ? 'worker runs' : 'workers run'} at the same time, as set in Settings; \`delegate\` refuses more. When the job has more tasks than that, start the next one when a worker reports back.`,
    '4. Wait. While workers run, wait for them. Do not do their work for them.',
    "5. Check. When a worker reports back, check its work against its brief yourself, criterion by criterion: read the diff and the changed code, run the tests or the build. Do not take the report's word for it. Use the shell only to look and to run checks, never to change files.",
    `6. Decide. If every criterion passes, accept the task and give out the next one. If one fails, send the same worker back with \`nudge\`: name the criterion, what you saw, and what to do. After ${MAX_NUDGES} nudges on the same failed criterion, give the task to a fresh worker with a sharper brief or a stronger model, or ask me.`,
    'Handle anything that does not need me. Stop only when you need a decision from me, or when the whole job is done. Then report, per task, what was done and how you checked it.'
  ].join('\n\n')
}

/** What /conduct sends: the conductor's role, then the job. */
export function conductorPrompt(job: string, workerModel: string, maxWorkers: number): string {
  return `${conductorRule(workerModel, maxWorkers)}\n\nThe job:\n${job.trim()}`
}

/**
 * When a Claude Code session should start an agent of its own. Claude Code's own prompt leans
 * against agents, so without this a chat rarely starts one unless the user asks.
 */
const AGENT_TOOL_USE =
  'Use your Agent tool when it lets work run side by side or keeps a long search out of your context, without being asked: ' +
  'start pieces of work that do not depend on each other as agents in the same turn and keep working while they run; ' +
  'give a search that will take many reads, where you only need the conclusion, to an Explore agent; ' +
  'after a change of some size, have an agent review the diff, given the code and not your conclusions; ' +
  'and run long checks, such as the full test suite or a build, in a background agent while you go on. ' +
  'Do a lookup whose target you already know, or a few tool calls, yourself.'

/**
 * What a Claude Code session is told about the agents it starts itself with its Agent tool:
 * when to start one, the model it runs on, as `conductorPrompt` says for workers, and how many run at once.
 */
export function agentToolRule(agentModel: string, maxAgents: number): string {
  const model = agentModel
    ? `Agents you start with your own Agent tool run on ${agentModel}, as set in Settings.`
    : 'When you start an agent with your own Agent tool, pick its model with `model`: `haiku` when a small, fast model is enough for the task, `sonnet` for routine work, `opus` for work that needs judgement, and `fable` for a really hard task, such as a bug nobody has found, a design with many parts or a long change across the codebase. Fable costs the most, so keep it for the tasks that need it. Leave `model` out only when the task needs the model you run on.'
  return `${AGENT_TOOL_USE} ${model} At most ${maxAgents} ${maxAgents === 1 ? 'of your agents runs' : 'of your agents run'} at the same time, as set in Settings; a start past that is refused. When there is more work than that, start the next agent when one reports back.`
}
