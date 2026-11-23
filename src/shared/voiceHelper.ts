import type { VoiceSettings } from './types'

/**
 * The voice helper: a page with no window that the main process opens for Telegram's voice notes and
 * spoken replies, since speech runs on Web Audio, WebCodecs and web workers, and those need a page.
 */

export const VOICE_HELPER_JOB = 'voice-helper:job'
export const VOICE_HELPER_DONE = 'voice-helper:done'

export type VoiceHelperJob =
  | { id: number; kind: 'transcribe'; audio: Uint8Array }
  | { id: number; kind: 'speak'; text: string; voice: VoiceSettings }

export type VoiceHelperResult =
  | { id: number; text: string }
  | { id: number; ogg: Uint8Array }
  | { id: number; error: string }

export type VoiceHelperApi = {
  onJob: (listener: (job: VoiceHelperJob) => void) => void
  done: (result: VoiceHelperResult) => void
}
