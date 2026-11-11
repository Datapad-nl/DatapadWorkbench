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

/**
 * What /conduct sends ahead of the job: the chat plans, and workers started with `delegate` do the work.
 * `workerModel` is the model Settings fixes for every worker; empty lets the conductor pick per task.
 * `maxWorkers` is how many workers Settings lets run at the same time.
 */
export function conductorPrompt(job: string, workerModel: string, maxWorkers: number): string {
  const model = workerModel
    ? `Every worker runs on ${workerModel}, as set in Settings.`
    : 'Pick the model for each worker with `model`: `opus` for work that needs judgement, `sonnet` for routine work, and `haiku` when a small, fast model is enough for the job.'
  return [
    'You are the conductor of this job. You do the thinking: the plan, the architecture, the strategy.',
    'Split the job into tasks. Give each one to its own worker with the `delegate` tool of the `workbench` MCP server. Start tasks that do not depend on each other in the same turn, so they run side by side; give workers that edit files at the same time their own worktree. A worker starts with no context: its brief carries the goal, the files, what is already ruled out, and what to report back.',
    model,
    `At most ${maxWorkers} ${maxWorkers === 1 ? 'worker runs' : 'workers run'} at the same time, as set in Settings; \`delegate\` refuses more. When the job has more tasks than that, start the next one when a worker reports back.`,
    'While workers run, wait for them. Do not do their work for them.',
    'When a worker reports back, check its work. If the task is not done, send that worker back to it with `nudge`, until it is. Then give out the next task.',
    'Handle anything that does not need me. Stop only when you need a decision from me, or when the whole job is done.',
    `The job:\n${job.trim()}`
  ].join('\n\n')
}
