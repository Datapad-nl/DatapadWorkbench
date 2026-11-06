import { execFile } from 'child_process'
import { realpath } from 'fs/promises'
import { resolve } from 'path'
import { withLock } from './storeIo'

/** The repository's shared .git dir, so a project folder and all its chat worktrees take one lock. */
async function repoLockKey(cwd: string): Promise<string> {
  const common = await new Promise<string | null>((done) => {
    execFile('git', ['rev-parse', '--git-common-dir'], { cwd, timeout: 10_000 }, (error, stdout) =>
      done(error ? null : stdout.trim())
    )
  })
  // Relative from the main folder, a real path from a worktree.
  const dir = common ? resolve(cwd, common) : resolve(cwd)
  return `git:${await realpath(dir).catch(() => dir)}`
}

/** Runs one of this app's git writes once any other on the same repository has finished. Not reentrant. */
export async function withRepoLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  return withLock(await repoLockKey(cwd), fn)
}
