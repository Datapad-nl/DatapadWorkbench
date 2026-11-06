import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./supertonic', () => ({ loadSupertonic: vi.fn(), synthesize: vi.fn() }))
vi.mock('./whisper', () => ({ getAsr: vi.fn() }))

import { openLiveMicStream } from './engine'

type Mic = { id: string; signal: 'loud' | 'silent' | 'fails' }

/** Fake mics: each open stream records whether its track was stopped. */
function installMics(mics: Mic[]): { open: { id: string; stopped: boolean }[] } {
  const open: { id: string; stopped: boolean }[] = []
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => mics.map((mic) => ({ kind: 'audioinput', deviceId: mic.id, label: mic.id })),
      getUserMedia: async (constraints: { audio: { deviceId?: { exact: string } } | true }) => {
        const id = constraints.audio === true ? 'probe' : (constraints.audio.deviceId?.exact ?? 'probe')
        const entry = { id, stopped: false }
        if (id !== 'probe') open.push(entry)
        const track = {
          id,
          readyState: 'live',
          stop: () => {
            entry.stopped = true
          }
        }
        return { getAudioTracks: () => [track], getTracks: () => [track] }
      }
    }
  })
  vi.stubGlobal(
    'MediaStreamTrackProcessor',
    class {
      readable: { getReader: () => unknown }
      constructor({ track }: { track: { id: string } }) {
        const mic = mics.find((item) => item.id === track.id)
        this.readable = {
          getReader: () => ({
            cancel: async () => undefined,
            read: async () => {
              await new Promise((resolve) => setTimeout(resolve, 5))
              if (mic?.signal === 'fails') throw new Error('track processor failed')
              const level = mic?.signal === 'loud' ? 0.1 : 0
              return {
                done: false,
                value: {
                  sampleRate: 48000,
                  allocationSize: () => 480 * 4,
                  copyTo: (out: Float32Array) => out.fill(level),
                  close: () => undefined
                }
              }
            }
          })
        }
      }
    }
  )
  return { open }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openLiveMicStream', () => {
  it('closes every mic it does not return when a later one is louder', async () => {
    const { open } = installMics([
      { id: 'a', signal: 'silent' },
      { id: 'b', signal: 'silent' },
      { id: 'c', signal: 'loud' }
    ])
    const stream = (await openLiveMicStream()) as unknown as { getAudioTracks: () => { id: string }[] }
    expect(stream.getAudioTracks()[0].id).toBe('c')
    expect(open).toEqual([
      { id: 'a', stopped: true },
      { id: 'b', stopped: true },
      { id: 'c', stopped: false }
    ])
  })

  it('keeps only the first quiet mic when none is loud', async () => {
    const { open } = installMics([
      { id: 'a', signal: 'silent' },
      { id: 'b', signal: 'silent' }
    ])
    const stream = (await openLiveMicStream()) as unknown as { getAudioTracks: () => { id: string }[] }
    expect(stream.getAudioTracks()[0].id).toBe('a')
    expect(open).toEqual([
      { id: 'a', stopped: false },
      { id: 'b', stopped: true }
    ])
  })

  it('closes a mic whose probe fails, and the quiet one it kept, once a loud one opens', async () => {
    const { open } = installMics([
      { id: 'a', signal: 'silent' },
      { id: 'b', signal: 'fails' },
      { id: 'c', signal: 'loud' }
    ])
    const stream = (await openLiveMicStream()) as unknown as { getAudioTracks: () => { id: string }[] }
    expect(stream.getAudioTracks()[0].id).toBe('c')
    expect(open).toEqual([
      { id: 'a', stopped: true },
      { id: 'b', stopped: true },
      { id: 'c', stopped: false }
    ])
  })
})
