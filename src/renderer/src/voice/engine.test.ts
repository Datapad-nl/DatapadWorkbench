import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./supertonic', () => ({ loadSupertonic: vi.fn(), synthesize: vi.fn() }))
vi.mock('./whisper', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./whisper')>()),
  getAsr: vi.fn()
}))

import { DEFAULT_VOICE } from '../../../shared/types'
import {
  micLevel,
  openLiveMicStream,
  resetSpokenLog,
  speakableText,
  speakText,
  speechDetector,
  startRecorder,
  stopSpeaking,
  transcribePcm,
  type PcmClip
} from './engine'
import { getAsr } from './whisper'

const SILENCE_MS = 800
const FRAME_MS = 10
const NOISE = 0.003
const SPEECH = 0.05

type Segment = { rms: number | ((t: number) => number); ms: number }
type Step = { t: number; heard: boolean; silentMs: number }

/** Feeds 10 ms frames to a fresh detector and records its answer after each. */
function run(segments: Segment[]): Step[] {
  const detect = speechDetector()
  const steps: Step[] = []
  let t = 0
  for (const segment of segments) {
    for (let at = 0; at < segment.ms; at += FRAME_MS) {
      const rms = typeof segment.rms === 'number' ? segment.rms : segment.rms(at)
      t += FRAME_MS
      steps.push({ t, ...detect(rms, FRAME_MS) })
    }
  }
  return steps
}

/** Time the clip would end, or null when it never does. */
function endsAt(steps: Step[]): number | null {
  return steps.find((step) => step.heard && step.silentMs >= SILENCE_MS)?.t ?? null
}

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

describe('speechDetector', () => {
  it('ends a clip in room noise above the old fixed 0.0008 threshold, which never ended it', () => {
    const steps = run([
      { rms: NOISE, ms: 1000 },
      { rms: SPEECH, ms: 1500 },
      { rms: NOISE, ms: 3000 }
    ])
    expect(steps.find((step) => step.t === 1000)?.heard).toBe(false)
    expect(steps.find((step) => step.t === 2500)?.heard).toBe(true)
    const end = endsAt(steps)
    expect(end).not.toBeNull()
    expect(end! - 2500).toBeGreaterThanOrEqual(SILENCE_MS)
    expect(end! - 2500).toBeLessThanOrEqual(SILENCE_MS + 100)
  })

  it('never hears steady room noise alone', () => {
    expect(run([{ rms: NOISE, ms: 5000 }]).some((step) => step.heard)).toBe(false)
  })

  it('still ends a clip between digital silence', () => {
    const steps = run([
      { rms: 0, ms: 500 },
      { rms: SPEECH, ms: 1000 },
      { rms: 0, ms: 2000 }
    ])
    const end = endsAt(steps)
    expect(end).not.toBeNull()
    expect(end! - 1500).toBeGreaterThanOrEqual(SILENCE_MS)
    expect(end! - 1500).toBeLessThanOrEqual(SILENCE_MS + 100)
  })

  it('ends a clip the user was already talking when it started', () => {
    const steps = run([
      { rms: SPEECH, ms: 1500 },
      { rms: NOISE, ms: 3000 }
    ])
    expect(steps.some((step) => step.heard)).toBe(true)
    const end = endsAt(steps)
    expect(end).not.toBeNull()
    expect(end! - 1500).toBeLessThanOrEqual(SILENCE_MS + 400)
  })

  it('does not end a clip on a pause shorter than the silence, and resets when speech resumes', () => {
    const steps = run([
      { rms: NOISE, ms: 500 },
      { rms: SPEECH, ms: 800 },
      { rms: NOISE, ms: 600 },
      { rms: SPEECH, ms: 800 }
    ])
    expect(endsAt(steps)).toBeNull()
    expect(Math.max(...steps.map((step) => step.silentMs))).toBeGreaterThanOrEqual(500)
    expect(steps.at(-1)?.silentMs).toBe(0)
  })

  it('counts noise that auto gain lifts after speech as silence', () => {
    const steps = run([
      { rms: NOISE, ms: 500 },
      { rms: SPEECH, ms: 1500 },
      { rms: (t) => NOISE + (NOISE * t) / 2000, ms: 2000 }
    ])
    const end = endsAt(steps)
    expect(end).not.toBeNull()
    expect(end! - 2000).toBeLessThanOrEqual(SILENCE_MS + 100)
  })

  it('ignores a single loud frame in noise, before and after speech', () => {
    const before = run([
      { rms: NOISE, ms: 1000 },
      { rms: SPEECH, ms: FRAME_MS },
      { rms: NOISE, ms: 1000 }
    ])
    expect(before.some((step) => step.heard)).toBe(false)

    const after = run([
      { rms: NOISE, ms: 500 },
      { rms: SPEECH, ms: 1000 },
      { rms: NOISE, ms: 700 },
      { rms: SPEECH, ms: FRAME_MS },
      { rms: NOISE, ms: 1500 }
    ])
    const spike = after.findIndex((step) => step.t === 2210)
    expect(after[spike]?.silentMs).toBeGreaterThan(after[spike - 1]?.silentMs ?? Infinity)
    expect(endsAt(after)! - 1500).toBeLessThanOrEqual(SILENCE_MS + 100)
  })
})

/** What the fake worker and speaker did, in order. */
const voiceLog: string[] = []
const SETTINGS = { ...DEFAULT_VOICE, language: 'en' }
/** The engine keeps its first worker, so the fake reads this when a job comes in. */
let failText = ''

/** A worker that synthesizes one job at a time, and an output whose sources play for 50 ms. */
function installSpeech(fail = ''): { browserSaid: string[] } {
  const browserSaid: string[] = []
  failText = fail
  vi.stubGlobal('window', { workbench: { ensureVoiceModel: async () => ({ state: 'ready' }) } })
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: ((event: { data: unknown }) => void) | null = null
      busy = Promise.resolve()
      postMessage(message: { type: string; id: number; text: string }): void {
        if (message.type === 'load') setTimeout(() => this.onmessage?.({ data: { type: 'ready' } }))
        if (message.type !== 'synth') return
        voiceLog.push(`synth ${message.text}`)
        this.busy = this.busy
          .then(() => new Promise((resolve) => setTimeout(resolve, 20)))
          .then(() => {
            const data =
              message.text === failText
                ? { type: 'error', id: message.id, message: 'synth failed' }
                : { type: 'audio', id: message.id, samples: new Float32Array(160), sampleRate: 16000 }
            this.onmessage?.({ data })
          })
      }
      terminate(): void {}
    }
  )
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running'
      destination = {}
      async resume(): Promise<void> {}
      async close(): Promise<void> {}
      createGain(): unknown {
        return { gain: { value: 1 }, connect: () => undefined }
      }
      createBuffer(_channels: number, length: number): unknown {
        return { getChannelData: () => new Float32Array(length) }
      }
      createBufferSource(): unknown {
        let timer: ReturnType<typeof setTimeout> | undefined
        const source = {
          buffer: null,
          onended: null as (() => void) | null,
          connect: () => undefined,
          disconnect: () => undefined,
          start: () => {
            voiceLog.push('play')
            timer = setTimeout(() => {
              voiceLog.push('end')
              source.onended?.()
            }, 50)
          },
          stop: () => {
            clearTimeout(timer)
            setTimeout(() => source.onended?.())
          }
        }
        return source
      }
    }
  )
  vi.stubGlobal('speechSynthesis', {
    speaking: false,
    pending: false,
    cancel: () => undefined,
    getVoices: () => [{ name: 'Daniel' }],
    speak: (utter: { text: string; onend: () => void }) => {
      browserSaid.push(utter.text)
      utter.onend()
    }
  })
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(public text: string) {}
    }
  )
  return { browserSaid }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

describe('speakText', () => {
  afterEach(() => {
    stopSpeaking()
    resetSpokenLog()
    voiceLog.length = 0
  })

  it('synthesizes a chunk that arrives while another plays before that one ends, and only once', async () => {
    installSpeech()
    const first = speakText('The first sentence.', SETTINGS)
    await until(() => voiceLog.includes('play'))
    const second = speakText('The second sentence.', SETTINGS, { append: true })
    const again = speakText('The second sentence.', SETTINGS, { append: true })
    await Promise.all([first, second, again])
    expect(voiceLog).toEqual(['synth The first sentence.', 'play', 'synth The second sentence.', 'end', 'play', 'end'])
  })

  it('starts the next chunk when one starts playing, not while it is still synthesizing', async () => {
    installSpeech()
    const first = speakText('One sentence here.', SETTINGS)
    const second = speakText('Another sentence there.', SETTINGS, { append: true })
    await Promise.all([first, second])
    expect(voiceLog).toEqual(['synth One sentence here.', 'play', 'synth Another sentence there.', 'end', 'play', 'end'])
  })

  it('never plays a chunk synthesized ahead once speech stops', async () => {
    installSpeech()
    const first = speakText('Stop after this.', SETTINGS)
    void speakText('Never heard.', SETTINGS, { append: true })
    await until(() => voiceLog.includes('synth Never heard.'))
    stopSpeaking()
    await first
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(voiceLog.filter((entry) => entry === 'play')).toHaveLength(1)
  })

  it('reads the chunk that failed ahead, and the ones behind it, with the system voice', async () => {
    const { browserSaid } = installSpeech('Second fails.')
    const first = speakText('First plays.', SETTINGS)
    await until(() => voiceLog.includes('play'))
    const second = speakText('Second fails.', SETTINGS, { append: true })
    const third = speakText('Third waits.', SETTINGS, { append: true })
    await Promise.all([first, second, third])
    expect(voiceLog.filter((entry) => entry === 'play')).toHaveLength(1)
    expect(browserSaid).toEqual(['Second fails. Third waits.'])
  })
})

describe('speakableText', () => {
  it('reads names in inline code as words', () => {
    expect(
      speakableText('I pushed it to `origin`. The files under `src/` and `docs/`, without the linked `node_modules`, into `master`.')
    ).toBe('I pushed it to origin. The files under src and docs, without the linked node modules, into master.')
  })

  it('reads a branch, a file and a function, without line numbers or hashes', () => {
    expect(speakableText('On `workbench/b4476b3c`, see `ChatPane.tsx:320` and `handoffChat`.')).toBe(
      'On workbench, see Chat Pane.tsx and handoff Chat.'
    )
  })

  it('leaves out commit hashes, commands and code', () => {
    expect(
      speakableText('Committed as `a1fd985`. Run `git push -u origin HEAD` or `contexts.get(chatId)` now.')
    ).toBe('Committed as. Run or now.')
  })
})

describe('micLevel', () => {
  it('is 0 for silence', () => {
    expect(micLevel(0)).toBe(0)
    expect(micLevel(-0.1)).toBe(0)
  })

  it('is 0 at -60 dBFS and below', () => {
    expect(micLevel(0.001)).toBeCloseTo(0)
    expect(micLevel(0.0001)).toBe(0)
  })

  it('is about half at -30 dBFS', () => {
    expect(micLevel(10 ** (-30 / 20))).toBeCloseTo(0.5)
  })

  it('is 1 at full scale and above', () => {
    expect(micLevel(1)).toBe(1)
    expect(micLevel(2)).toBe(1)
  })

  it('is 0 for a value that is not a number', () => {
    expect(micLevel(NaN)).toBe(0)
    expect(micLevel(Infinity)).toBe(0)
  })
})

const RATE = 16000
const FRAME = RATE / 100
// Speech frames carry their own sample value, so a test can count which of them reached a clip.
const A = 0.05
const B = 0.06

/** A mic whose frames come from level(), one 10 ms frame per read, on a clock that moves with them. */
function installFrames(level: (frame: number) => number | null): {
  stream: MediaStream
  track: { stopped: boolean }
  read: () => number
} {
  let clock = 0
  let frame = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const track = {
    stopped: false,
    enabled: false,
    getSettings: () => ({ sampleRate: RATE }),
    stop: () => {
      track.stopped = true
    }
  }
  let cancel = (): void => undefined
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve
  })
  vi.stubGlobal(
    'MediaStreamTrackProcessor',
    class {
      readable = {
        getReader: () => ({
          cancel: async () => cancel(),
          read: async () => {
            await Promise.resolve()
            const value = track.stopped ? null : level(frame)
            if (value === null) {
              await cancelled
              return { done: true, value: undefined }
            }
            frame++
            clock += 10
            return {
              done: false,
              value: {
                sampleRate: RATE,
                allocationSize: () => FRAME * 4,
                copyTo: (out: Float32Array) => out.fill(value),
                close: () => undefined
              }
            }
          }
        })
      }
    }
  )
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
  return { stream, track, read: () => frame }
}

/** Levels for each 10 ms frame of the segments, then null. */
function script(segments: { level: number; ms: number }[]): (frame: number) => number | null {
  const levels = segments.flatMap((segment) => Array<number>(segment.ms / 10).fill(segment.level))
  return (frame) => levels[frame] ?? null
}

function count(clip: PcmClip | undefined, value: number): number {
  return clip ? clip.samples.filter((sample) => sample === Math.fround(value)).length : 0
}

type Recording = {
  clips: PcmClip[]
  /** Whether the mic was stopped when each clip was handed on. */
  stoppedAt: boolean[]
  track: { stopped: boolean }
  read: () => number
  stop: () => Promise<PcmClip>
}

async function record(
  level: (frame: number, clips: PcmClip[]) => number | null,
  continuous: boolean
): Promise<Recording> {
  const clips: PcmClip[] = []
  const stoppedAt: boolean[] = []
  const { stream, track, read } = installFrames((frame) => level(frame, clips))
  const rec = await startRecorder({
    stream,
    idleStop: true,
    continuous,
    onLevel: () => undefined,
    onAutoStop: (clip) => {
      clips.push(clip)
      stoppedAt.push(track.stopped)
    }
  })
  return { clips, stoppedAt, track, read, stop: rec.stop }
}

/** Waits until the mic has handed out every frame it has. */
async function drained(rec: Recording, level: (frame: number, clips: PcmClip[]) => number | null): Promise<void> {
  await until(() => level(rec.read(), rec.clips) === null)
  await new Promise((resolve) => setTimeout(resolve))
}

describe('startRecorder', () => {
  afterEach(() => {
    vi.mocked(performance.now).mockRestore?.()
  })

  it('in continuous mode hands on each clip and keeps the same mic open for the next', async () => {
    const level = script([
      { level: NOISE, ms: 500 },
      { level: A, ms: 1000 },
      { level: NOISE, ms: 1500 },
      { level: B, ms: 1000 },
      { level: NOISE, ms: 1500 }
    ])
    const rec = await record(level, true)
    await drained(rec, level)
    expect(rec.clips).toHaveLength(2)
    expect(rec.stoppedAt).toEqual([false, false])
    expect(rec.track.stopped).toBe(false)
    expect(count(rec.clips[0], A)).toBe(100 * FRAME)
    expect(count(rec.clips[0], B)).toBe(0)
    expect(count(rec.clips[1], B)).toBe(100 * FRAME)
    expect(count(rec.clips[1], A)).toBe(0)
    await rec.stop()
    expect(rec.track.stopped).toBe(true)
  })

  it('in continuous mode keeps speech that starts on the frame after a clip ends', async () => {
    let first = -1
    const level = (frame: number, clips: PcmClip[]): number | null => {
      if (clips.length === 0) return frame < 50 ? NOISE : frame < 150 ? A : NOISE
      if (first < 0) first = frame
      const at = frame - first
      return at < 100 ? B : at < 300 ? NOISE : null
    }
    const rec = await record(level, true)
    await drained(rec, level)
    const rest = await rec.stop()
    const second = rec.clips[1] ?? rest
    expect(count(second, B)).toBe(100 * FRAME)
    expect(second.samples[0]).toBe(Math.fround(B))
  })

  it('in continuous mode drops a minute with no speech and carries on recording', async () => {
    const level = script([
      { level: NOISE, ms: 61_000 },
      { level: A, ms: 1000 },
      { level: NOISE, ms: 1500 }
    ])
    const rec = await record((frame, clips) => {
      // Nothing may come out of the minute of noise.
      if (frame === 6100) expect(clips).toHaveLength(0)
      return level(frame)
    }, true)
    await drained(rec, level)
    expect(rec.track.stopped).toBe(false)
    expect(rec.clips).toHaveLength(1)
    expect(count(rec.clips[0], A)).toBe(100 * FRAME)
    // Only the pre-roll of the noise before the speech is in the clip.
    expect(rec.clips[0]!.samples.length).toBeLessThan(3 * RATE)
    await rec.stop()
  })

  it('without continuous mode stops the mic and hands on one clip', async () => {
    const level = script([
      { level: NOISE, ms: 500 },
      { level: A, ms: 1000 },
      { level: NOISE, ms: 1500 },
      { level: B, ms: 1000 },
      { level: NOISE, ms: 1500 }
    ])
    const rec = await record(level, false)
    await until(() => rec.clips.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rec.clips).toHaveLength(1)
    expect(rec.track.stopped).toBe(true)
    expect(count(rec.clips[0], A)).toBe(100 * FRAME)
    expect(count(rec.clips[0], B)).toBe(0)
  })

  it('starts a clip shortly before the speech in it, and keeps every speech sample', async () => {
    const level = script([
      { level: NOISE, ms: 3000 },
      { level: A, ms: 1000 },
      { level: NOISE, ms: 1500 }
    ])
    const rec = await record(level, false)
    await until(() => rec.clips.length === 1)
    const clip = rec.clips[0] as PcmClip
    const lead = clip.samples.findIndex((sample) => sample === Math.fround(A))
    expect(lead).toBeGreaterThan(0)
    expect(lead).toBeLessThanOrEqual(0.4 * RATE)
    expect(count(clip, A)).toBe(100 * FRAME)
  })

  it('does not trim a clip that opened while the user was already talking', async () => {
    const level = script([
      { level: A, ms: 1500 },
      { level: NOISE, ms: 3000 }
    ])
    const rec = await record(level, false)
    await until(() => rec.clips.length === 1)
    const clip = rec.clips[0] as PcmClip
    expect(clip.heardSpeech).toBe(true)
    expect(clip.samples[0]).toBe(Math.fround(A))
    expect(count(clip, A)).toBe(150 * FRAME)
    expect(clip.samples.length).toBe(rec.read() * FRAME)
  })
})

describe('transcribePcm', () => {
  it('passes the whole clip to Whisper, with windows for audio over 30 s, and no more than a minute', async () => {
    // The worker cannot start, so recognition runs on this thread.
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('no workers here')
        }
      }
    )
    const pipe = vi.fn(async () => ({ text: 'hello there friend' }))
    vi.mocked(getAsr).mockResolvedValue(pipe)
    const windows = { chunk_length_s: 30, stride_length_s: 5 }

    expect(await transcribePcm(new Float32Array(10 * RATE), RATE)).toBe('hello there friend')
    expect(pipe).toHaveBeenLastCalledWith(expect.objectContaining({ length: 10 * RATE }), windows)

    await transcribePcm(new Float32Array(45 * RATE), RATE)
    expect(pipe).toHaveBeenLastCalledWith(expect.objectContaining({ length: 45 * RATE }), windows)

    await transcribePcm(new Float32Array(70 * RATE), RATE)
    expect(pipe).toHaveBeenLastCalledWith(expect.objectContaining({ length: 60 * RATE }), windows)
  })
})
