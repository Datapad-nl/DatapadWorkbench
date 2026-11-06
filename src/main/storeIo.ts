import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'

const locks = new Map<string, Promise<void>>()

/** Runs `fn` after every earlier call with the same key has settled. Not reentrant. */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  locks.set(key, tail)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  }
}

let tempCount = 0

/** Writes a temp file next to `path`, then renames it over, so readers never see half a file. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${++tempCount}.tmp`
  try {
    await writeFile(temp, data, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * `fallback` when the file doesn't exist. A file that doesn't parse is moved aside to
 * `<path>.corrupt-<ms>`, reported to `onCorrupt`, and also reads as `fallback`. Other read errors throw.
 */
export async function readJsonFile<T>(path: string, fallback: T, onCorrupt?: (aside: string) => void): Promise<T> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
  try {
    return JSON.parse(text) as T
  } catch {
    const aside = `${path}.corrupt-${Date.now()}`
    await rename(path, aside).catch(() => undefined)
    console.error(`Unreadable JSON moved to ${aside}`)
    onCorrupt?.(aside)
    return fallback
  }
}
