import { useEffect, useState } from 'react'
import type { ActivityEvent } from '../../shared/types'

/** Quiet stretch before the first "still on it" cue. */
export const PROGRESS_FIRST_MS = 60_000
/** At most one spoken progress line per minute. */
export const PROGRESS_REPEAT_MS = 60_000

export type ProgressNow = {
  label: string
  speech: string
  key: string
}

export const STILL_ON_IT_SPEECH = 'I am still working on your request.'

const IDLE: ProgressNow = {
  label: 'Still working',
  speech: STILL_ON_IT_SPEECH,
  key: 'idle'
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= max) return one
  return `${one.slice(0, max - 1).trim()}…`
}

export function latestRunning(events: ActivityEvent[], chatId: string): ActivityEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.chatId !== chatId) continue
    if (event.kind === 'turn') continue
    if (event.status === 'running') return event
  }
  return null
}

export function progressNow(event: ActivityEvent | null): ProgressNow {
  if (!event) return IDLE
  if (event.kind === 'thought') {
    const bit = clip(event.detail ?? '', 140)
    if (bit.startsWith('Still working')) {
      return {
        label: bit,
        speech: STILL_ON_IT_SPEECH,
        key: `idle:${bit}`
      }
    }
    return {
      label: bit ? `Thinking. ${bit}` : 'Thinking',
      speech: STILL_ON_IT_SPEECH,
      key: 'thought'
    }
  }
  if (event.kind === 'goal') {
    const label = clip(event.title?.trim() || 'Working on the goal', 160)
    return {
      label,
      speech: STILL_ON_IT_SPEECH,
      key: `goal:${label}`
    }
  }
  if (event.kind === 'write') {
    return {
      label: 'Writing the reply',
      speech: STILL_ON_IT_SPEECH,
      key: 'write'
    }
  }
  if (event.kind === 'permission') {
    const label = clip(event.title?.trim() || 'Waiting for you', 160)
    return {
      label,
      speech: 'I am waiting for you to allow the next step.',
      key: `permission:${event.id}`
    }
  }
  if (event.kind === 'error') {
    const label = clip(event.title?.trim() || 'Something went wrong', 160)
    return {
      label,
      speech: 'Something went wrong.',
      key: `error:${event.id}`
    }
  }
  const title = clip(event.title?.trim() || 'Still working', 160)
  return {
    label: title,
    speech: STILL_ON_IT_SPEECH,
    key: `${event.coalesceKey ?? event.id}:${title}`
  }
}

function isStatusFiller(key: string): boolean {
  return key === 'idle' || key === 'thought'
}

export function shouldAnnounceProgress(input: {
  now: number
  replyAt: number
  announcedAt: number
  lastKey: string
  key: string
  speaking: boolean
  userBusy: boolean
  /** Cue text is the user's own request, so it waits with the other fillers. */
  echoesUser?: boolean
}): boolean {
  if (input.speaking || input.userBusy) return false
  const sinceReply = input.now - input.replyAt
  const sinceAnnounce = input.now - input.announcedAt
  if (input.announcedAt !== 0 && sinceAnnounce < PROGRESS_REPEAT_MS) return false
  const urgent =
    !input.echoesUser &&
    !isStatusFiller(input.key) &&
    (input.key.startsWith('permission:') || input.key.startsWith('error:')) &&
    input.key !== input.lastKey
  if (urgent) return true
  if (sinceReply >= PROGRESS_FIRST_MS && sinceAnnounce >= PROGRESS_REPEAT_MS) return true
  return false
}

export function useChatProgress(chatId: string | null, streaming: boolean): ProgressNow {
  const scope = chatId && streaming ? chatId : ''
  const [trackedScope, setTrackedScope] = useState(scope)
  const [now, setNow] = useState<ProgressNow>(IDLE)
  if (scope !== trackedScope) {
    setTrackedScope(scope)
    setNow(IDLE)
  }

  useEffect(() => {
    if (!chatId || !streaming) return
    let cancel = false
    let live = false
    void window.workbench.getActivity().then((snapshot) => {
      if (cancel || live) return
      setNow(progressNow(latestRunning(snapshot.events, chatId)))
    })
    const off = window.workbench.onActivityEvent((feed) => {
      if (feed.type === 'reset') {
        live = true
        setNow(progressNow(latestRunning(feed.events, chatId)))
        return
      }
      if (feed.event.chatId !== chatId || feed.event.kind === 'turn') return
      live = true
      setNow(progressNow(feed.event))
    })
    return () => {
      cancel = true
      off()
    }
  }, [chatId, streaming])

  return streaming ? now : IDLE
}
