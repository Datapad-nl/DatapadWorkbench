import { useCallback, useEffect, useSyncExternalStore } from 'react'

type Ask = (chatId: string, srcs: string[]) => Promise<boolean[]>

const keyOf = (chatId: string, src: string): string => `${chatId}\0${src}`

/**
 * Whether paths a reply mentions are files of its chat, asked in batches. A file that exists stays known;
 * one that does not is asked again after `ttl`, since an agent often names a file before it writes it.
 */
export function createFileChecks({
  ask,
  now = Date.now,
  schedule = (run, ms) => void setTimeout(run, ms),
  ttl = 5000,
  delay = 60
}: {
  ask: Ask
  now?: () => number
  schedule?: (run: () => void, ms: number) => void
  ttl?: number
  delay?: number
}) {
  const answers = new Map<string, { ok: boolean; at: number }>()
  const asking = new Set<string>()
  // Asked together after a short wait, so a reply full of paths, or one streaming in, is one call per chat.
  const queued = new Map<string, Set<string>>()
  const listeners = new Map<string, Set<() => void>>()
  let scheduled = false

  function settle(chatId: string, src: string, ok: boolean): void {
    const key = keyOf(chatId, src)
    asking.delete(key)
    const before = answers.get(key)?.ok
    answers.set(key, { ok, at: now() })
    if (before !== ok) listeners.get(key)?.forEach((listener) => listener())
  }

  function flush(): void {
    scheduled = false
    for (const [chatId, srcs] of queued) {
      const all = [...srcs]
      // The main process answers at most 200 at a time.
      for (let start = 0; start < all.length; start += 200) {
        const batch = all.slice(start, start + 200)
        void ask(chatId, batch).then(
          (oks) => batch.forEach((src, index) => settle(chatId, src, oks[index] === true)),
          () => batch.forEach((src) => settle(chatId, src, false))
        )
      }
    }
    queued.clear()
  }

  function enqueue(chatId: string, src: string): void {
    asking.add(keyOf(chatId, src))
    const srcs = queued.get(chatId) ?? new Set<string>()
    queued.set(chatId, srcs)
    srcs.add(src)
    if (!scheduled) {
      scheduled = true
      schedule(flush, delay)
    }
  }

  return {
    known: (chatId: string, src: string): boolean => answers.get(keyOf(chatId, src))?.ok === true,

    /** Asks unless an answer is on its way, the file is known, or it was found missing within `ttl`. */
    request(chatId: string, src: string): void {
      const key = keyOf(chatId, src)
      const answer = answers.get(key)
      if (asking.has(key) || answer?.ok || (answer && now() - answer.at < ttl)) return
      enqueue(chatId, src)
    },

    /** Asks again about every path of the chat on screen that was missing, as when its turn ends. */
    recheckChat(chatId: string): void {
      for (const key of listeners.keys()) {
        const src = key.slice(chatId.length + 1)
        if (!key.startsWith(`${chatId}\0`) || asking.has(key) || answers.get(key)?.ok !== false) continue
        enqueue(chatId, src)
      }
    },

    subscribe(chatId: string, src: string, listener: () => void): () => void {
      const key = keyOf(chatId, src)
      const set = listeners.get(key) ?? new Set()
      listeners.set(key, set)
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(key)
      }
    }
  }
}

const checks = createFileChecks({ ask: (chatId, srcs) => window.workbench.filesResolvable(chatId, srcs) })

export const recheckChatFiles = checks.recheckChat

/** True once `src` is known to be a file of the chat, for every span showing it. */
export function useFileResolvable(chatId: string, src: string, enabled: boolean): boolean {
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? checks.subscribe(chatId, src, listener) : () => {}),
    [chatId, src, enabled]
  )
  const ok = useSyncExternalStore(subscribe, () => enabled && checks.known(chatId, src))
  // On every render: a cheap no-op unless the path was never asked or was missing a while ago.
  useEffect(() => {
    if (enabled) checks.request(chatId, src)
  })
  return ok
}
