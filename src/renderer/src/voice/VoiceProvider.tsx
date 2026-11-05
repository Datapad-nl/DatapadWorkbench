import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { DEFAULT_VOICE, type VoiceModelStatus, type VoiceSettings } from '../../../shared/types'
import { shouldAnnounceProgress, STILL_ON_IT_SPEECH, useChatProgress } from '../progress'
import { useStreams, useWorkspace } from '../workspace'
import {
  dropSpokenUserEcho,
  echoesUserRequest,
  isAsideSpeaking,
  isSpeaking,
  openLiveMicStream,
  primeTtsOutput,
  resetSpokenLog,
  resetVoiceMotion,
  speakableText,
  speakAside,
  speakText,
  speechLanguage,
  stopAside,
  warmAsideVoice,
  textLanguage,
  startNativeSpeech,
  startRecorder,
  stopSpeaking,
  takeSpeakableDelta,
  transcribePcm,
  isJunkTranscript,
  type NativeSpeech,
  type PcmClip,
  type Recorder
} from './engine'

export type VoiceUiStatus = 'idle' | 'loading' | 'listening' | 'transcribing' | 'waiting' | 'speaking' | 'error'

type VoiceContextValue = {
  enabled: boolean
  conversation: boolean
  live: boolean
  userTalking: boolean
  level: number
  bands: number[]
  status: VoiceUiStatus
  error: string | null
  model: VoiceModelStatus
  pendingTranscript: string | null
  caption: string
  consumeTranscript: () => void
  toggleListen: () => void
  toggleConversation: () => void
  stopAll: () => void
  speaks: boolean
  replyMuted: boolean
  muteReply: () => void
}

const VoiceContext = createContext<VoiceContextValue | null>(null)

const emptyModel: VoiceModelStatus = {
  ready: false,
  downloading: false,
  error: null,
  file: null,
  loadedBytes: 0,
  totalBytes: 0
}

export function VoiceProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { settings, activeChatId, chatsById, sendMessage, saveSettings } = useWorkspace()
  const streams = useStreams()
  const activeStreaming = Boolean(activeChatId && streams[activeChatId]?.status === 'streaming')
  const progress = useChatProgress(activeChatId, activeStreaming)
  const voice: VoiceSettings = settings?.voice ?? DEFAULT_VOICE
  const [status, setStatus] = useState<VoiceUiStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<VoiceModelStatus>(emptyModel)
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null)
  const [caption, setCaption] = useState('')
  const [live, setLive] = useState(false)
  const [userTalking, setUserTalking] = useState(false)
  const [level, setLevel] = useState(0)
  const [bands, setBands] = useState<number[]>(() => [0, 0, 0, 0, 0, 0, 0])
  const [replyMuted, setReplyMuted] = useState(false)
  const recorder = useRef<Recorder | null>(null)
  const liveRef = useRef(false)
  const levelFrame = useRef(0)
  const pendingLevel = useRef({ rms: 0, heard: false, silentFor: 0 })
  const primedChats = useRef(new Set<string>())
  const clipBusy = useRef(false)
  const listenLock = useRef(false)
  const enablingRef = useRef(false)
  const awaitingReply = useRef(false)
  const committedRef = useRef('')
  const speechRef = useRef<NativeSpeech | null>(null)
  const speechIgnoreEnd = useRef(false)
  const speakEpoch = useRef(0)
  const statusRef = useRef<VoiceUiStatus>('idle')
  const voiceRef = useRef(voice)
  const activeChatIdRef = useRef(activeChatId)
  const streamsRef = useRef(streams)
  const chatsByIdRef = useRef(chatsById)
  const progressRef = useRef(progress)
  const userTalkingRef = useRef(false)
  const replyAt = useRef(0)
  const announcedAt = useRef(0)
  const announcedKey = useRef('')
  const speakableLen = useRef(0)
  const turnChat = useRef<string | null>(null)

  statusRef.current = status
  voiceRef.current = voice
  activeChatIdRef.current = activeChatId
  streamsRef.current = streams
  chatsByIdRef.current = chatsById
  progressRef.current = progress
  userTalkingRef.current = userTalking

  useEffect(() => {
    void window.workbench.getVoiceModelStatus().then(setModel)
    return window.workbench.onVoiceModelStatus(setModel)
  }, [])

  useEffect(() => {
    setReplyMuted(activeChatId ? speechState(activeChatId).silenced : false)
  }, [activeChatId])

  const muteReply = useCallback(() => {
    const chatId = activeChatIdRef.current
    if (!chatId) return
    const spoken = speechState(chatId)
    spoken.silenced = !spoken.silenced
    setReplyMuted(spoken.silenced)
    if (!spoken.silenced) return
    speakEpoch.current += 1
    stopAside()
    stopSpeaking()
    if (statusRef.current === 'speaking') {
      const stillWorking = streamsRef.current[chatId]?.status === 'streaming' || liveRef.current
      setStatus(stillWorking ? 'waiting' : 'idle')
    }
  }, [])

  useEffect(() => {
    if (!activeChatId) return
    if (primedChats.current.has(activeChatId)) return
    primedChats.current.add(activeChatId)
    const last = chatsById[activeChatId]?.messages.at(-1)
    if (last?.role === 'assistant') speechState(activeChatId).ids.add(last.id)
  }, [activeChatId, chatsById])

  const stopAll = useCallback(() => {
    liveRef.current = false
    awaitingReply.current = false
    committedRef.current = ''
    setCaption('')
    setLive(false)
    setUserTalking(false)
    setLevel(0)
    setBands([0, 0, 0, 0, 0, 0, 0])
    resetVoiceMotion()
    speakEpoch.current += 1
    stopAside()
    stopSpeaking()
    speechIgnoreEnd.current = true
    speechRef.current?.stop()
    speechRef.current = null
    const current = recorder.current
    recorder.current = null
    if (current) void current.stop()
    setStatus('idle')
  }, [])

  const handleClip = useCallback(async (clip: PcmClip) => {
    if (clipBusy.current) return
    clipBusy.current = true
    recorder.current = null
    setUserTalking(false)
    setLevel(0)
    setBands([0, 0, 0, 0, 0, 0, 0])
    const looping = liveRef.current
    const talking = isSpeaking() || statusRef.current === 'speaking' || awaitingReply.current
    if (clip.samples.length < SAMPLE_FLOOR) {
      clipBusy.current = false
      if (looping) {
        if (!talking) setStatus('idle')
        return
      }
      setError("Didn't catch that")
      setStatus('idle')
      return
    }
    if (!talking) setStatus('transcribing')
    try {
      const text = await transcribePcm(clip.samples, clip.sampleRate, clip.heardSpeech)
      const spoken = activeChatIdRef.current ? heardText(activeChatIdRef.current) : progressSpokenText
      const bargeIn = looping && talking
      const leftover = leftoverSpeak(text, committedRef.current)
      committedRef.current = ''
      setCaption('')
      if (!leftover && !text) {
        if (!looping) setError("Didn't catch that")
        if (!talking) setStatus('idle')
        return
      }
      if (!leftover || isJunkTranscript(leftover)) {
        if (!talking) setStatus('idle')
        return
      }
      if (bargeIn && isLikelyEcho(leftover, spoken)) {
        return
      }
      setError(null)
      const currentVoice = voiceRef.current
      const chatId = activeChatIdRef.current
      const shouldSend = (looping || currentVoice.autoSend || currentVoice.conversation) && chatId
      if (shouldSend) {
        if (looping) {
          awaitingReply.current = true
          stopAside()
          stopSpeaking()
          speakEpoch.current += 1
        }
        await sendMessage(chatId, leftover)
        setStatus(looping ? 'waiting' : 'idle')
        return
      }
      setPendingTranscript(leftover)
      setStatus('idle')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not transcribe'
      setError(/bad_alloc|session/i.test(message) ? 'Speech engine ran out of memory. Pause, then try again.' : message)
      setStatus('error')
    } finally {
      clipBusy.current = false
      if (liveRef.current) void startListen({ preserveSpeech: true })
    }
  }, [sendMessage])

  const handleSpeechFinal = useCallback(
    async (text: string) => {
      const chatId = activeChatIdRef.current
      if (!chatId || !text.trim() || isJunkTranscript(text)) return
      const spoken = heardText(chatId)
      if (isSpeaking() && isLikelyEcho(text, spoken)) return
      setCaption('')
      setError(null)
      if (liveRef.current) {
        awaitingReply.current = true
        stopAside()
        stopSpeaking()
        speakEpoch.current += 1
        await sendMessage(chatId, text.trim())
        setStatus('waiting')
        return
      }
      if (voiceRef.current.autoSend) {
        await sendMessage(chatId, text.trim())
        setStatus('idle')
        return
      }
      setPendingTranscript(text.trim())
      setStatus('idle')
    },
    [sendMessage]
  )

  const beginSpeech = useCallback(() => {
    if (speechRef.current) return
    speechIgnoreEnd.current = false
    try {
      speechRef.current = startNativeSpeech({
        onCaption: (text) => {
          if (liveRef.current) setCaption(text)
        },
        onFinal: (text) => {
          void handleSpeechFinal(text)
        },
        onError: (message) => {
          if (message === 'network') {
            setError('Speech recognition needs a network connection')
            return
          }
          setError(message)
        },
        onEnd: () => {
          speechRef.current = null
          if (liveRef.current && !speechIgnoreEnd.current) beginSpeech()
        }
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start speech recognition')
    }
  }, [handleSpeechFinal])

  const startListen = useCallback(async (opts?: {
    preserveSpeech?: boolean
    context?: AudioContext
    stream?: MediaStream
  }) => {
    if (opts?.stream) {
      if (recorder.current) {
        const previous = recorder.current
        recorder.current = null
        void previous.stop()
      }
    } else if (recorder.current || listenLock.current) {
      return
    } else if (statusRef.current === 'listening' || statusRef.current === 'transcribing') {
      return
    }
    if (!opts?.preserveSpeech) {
      speakEpoch.current += 1
      stopAside()
      stopSpeaking()
    }
    listenLock.current = true
    setError(null)
    setStatus('loading')
    try {
      const rec = await startRecorder({
        context: opts?.context,
        stream: opts?.stream,
        deviceId: voiceRef.current.micDeviceId || undefined,
        onLevel: (rms, silentFor, heard) => {
          pendingLevel.current = { rms, heard, silentFor }
          if (levelFrame.current) return
          levelFrame.current = requestAnimationFrame(() => {
            levelFrame.current = 0
            const next = pendingLevel.current
            const mapped = Math.min(1, Math.max(0, next.rms / 0.04))
            setLevel(mapped)
            setUserTalking(next.heard && next.silentFor < 320)
          })
        },
        onBands: (next) => {
          setBands(next)
        },
        idleStop: true,
        onAutoStop: (clip) => {
          void handleClip(clip)
        }
      })
      recorder.current = rec
      if (statusRef.current !== 'speaking' && statusRef.current !== 'waiting') setStatus('listening')
      void window.workbench.ensureVoiceModel().then(setModel).catch(() => undefined)
    } catch (err) {
      liveRef.current = false
      setLive(false)
      setError(err instanceof Error ? err.message : 'Could not start the microphone')
      setStatus('error')
    } finally {
      listenLock.current = false
    }
  }, [handleClip])

  const toggleListen = useCallback(() => {
    if (voiceRef.current.conversation) {
      if (liveRef.current) {
        stopAll()
        return
      }
      liveRef.current = true
      setLive(true)
      void startListen({ preserveSpeech: true })
      return
    }
    if (statusRef.current === 'listening') {
      const current = recorder.current
      recorder.current = null
      if (current) {
        void current.stop().then((clip) => handleClip(clip))
        return
      }
      setStatus('idle')
      return
    }
    if (statusRef.current === 'transcribing') return
    void startListen()
  }, [handleClip, startListen, stopAll])

  const toggleConversation = useCallback(() => {
    if (liveRef.current) {
      enablingRef.current = false
      const current = recorder.current
      recorder.current = null
      liveRef.current = false
      setLive(false)
      setStatus('idle')
      if (current) void current.stop().then((clip) => handleClip(clip))
      else stopAll()
      return
    }
    liveRef.current = true
    enablingRef.current = true
    committedRef.current = ''
    setCaption('')
    setLive(true)
    setError(null)
    setStatus('loading')
    primeTtsOutput()
    const current = voiceRef.current
    void saveSettings({
      voice: { enabled: true, conversation: true, speakReplies: true, autoSend: true }
    }).finally(() => {
      enablingRef.current = false
    })
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('This window cannot access the microphone')
        }
        const stream = await openLiveMicStream(current.micDeviceId || undefined)
        if (!liveRef.current) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        await startListen({ preserveSpeech: true, stream })
      } catch (err) {
        console.error('conversation mic', err)
        liveRef.current = false
        setLive(false)
        setError(err instanceof Error ? err.message : 'Could not start the microphone')
        setStatus('error')
      }
    })()
  }, [handleClip, saveSettings, startListen, stopAll])

  useEffect(() => {
    const shouldSpeak = liveRef.current || (voice.enabled && voice.speakReplies)
    if (!shouldSpeak || !activeChatId) return
    const spoken = speechState(activeChatId)

    const stream = streams[activeChatId]
    if (stream?.status === 'streaming') {
      if (!spoken.hearing) {
        spoken.hearing = true
        if (spoken.silenced) {
          spoken.silenced = false
          setReplyMuted(false)
        }
      }
      if (stream.draft.length < spoken.draftLen) {
        spoken.plain = ''
        spoken.draftLen = 0
        spoken.ids.clear()
        spoken.silenced = false
        setReplyMuted(false)
        resetSpokenLog()
        speakEpoch.current += 1
        stopSpeaking()
      }
      spoken.draftLen = stream.draft.length
      if (spoken.silenced) {
        if (isSpeaking()) {
          speakEpoch.current += 1
          stopSpeaking()
        }
        if (statusRef.current === 'speaking') setStatus('waiting')
        return
      }
      const raw = dropSpokenUserEcho(
        speakableText(stream.draft),
        latestUserText(chatsById[activeChatId]?.messages)
      )
      if (!raw) return
      // Wait until there is enough text to tell the language, so the first sentence gets the right accent.
      if (!spoken.plain && voice.language === 'auto' && textLanguage(raw) === 'unknown') return
      const { speak, consumed } = takeSpeakableDelta(raw, spoken.plain, false)
      if (!speak) return
      spoken.plain = consumed
      setStatus('speaking')
      void speakText(speak, voice, { append: true, lang: speechLanguage(raw, voice) }).catch((err) => {
        if (streams[activeChatId]?.status !== 'streaming') return
        setError(err instanceof Error ? err.message : 'Could not speak')
        setStatus('error')
      })
      return
    }

    spoken.hearing = false
    const chat = chatsById[activeChatId]
    const last = chat?.messages.at(-1)
    if (stream?.status === 'error') {
      const epoch = ++speakEpoch.current
      void speakText('', voice, { append: true }).finally(() => {
        if (epoch !== speakEpoch.current) return
        if (statusRef.current === 'speaking') setStatus('idle')
      })
      return
    }
    if (!last || last.role !== 'assistant') return
    if (spoken.ids.has(last.id)) return
    spoken.ids.add(last.id)
    const userText = latestUserText(chat?.messages)
    const raw = dropSpokenUserEcho(speakableText(last.content), userText, true)
    const full = spoken.silenced ? '' : raw
    const prior = spoken.plain
    const speak = leftoverSpeak(full, prior)
    spoken.plain = full.replace(/\s+/g, ' ').trim()
    spoken.draftLen = 0
    const epoch = ++speakEpoch.current
    const run = speak
      ? speakText(speak, voice, { append: Boolean(prior.trim()), lang: speechLanguage(full, voice) })
      : speakText('', voice, { append: true })
    if (speak) setStatus('speaking')
    void run
      .catch((err) => {
        if (epoch !== speakEpoch.current) return
        setError(err instanceof Error ? err.message : 'Could not speak')
        setStatus('error')
      })
      .finally(() => {
        if (epoch !== speakEpoch.current) return
        awaitingReply.current = false
        if (statusRef.current === 'speaking' || statusRef.current === 'waiting') setStatus('idle')
        if (liveRef.current) {
          if (!recorder.current) void startListen({ preserveSpeech: true })
          return
        }
        if (voiceRef.current.handsFree && voiceRef.current.enabled && statusRef.current !== 'listening') {
          void startListen()
        }
      })
  }, [activeChatId, chatsById, startListen, streams, voice])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const chatId = activeChatIdRef.current
      const voiceNow = voiceRef.current
      const shouldSpeak = liveRef.current || (voiceNow.enabled && voiceNow.speakReplies)
      if (!chatId || !shouldSpeak) return
      const stream = streamsRef.current[chatId]
      if (stream?.status !== 'streaming') {
        turnChat.current = null
        return
      }
      if (turnChat.current !== chatId) {
        turnChat.current = chatId
        replyAt.current = Date.now()
        announcedAt.current = 0
        announcedKey.current = ''
        speakableLen.current = 0
      }
      const speakable = speakableText(stream.draft)
      if (speakable.length > speakableLen.current) {
        speakableLen.current = speakable.length
        replyAt.current = Date.now()
      }
      if (speechState(chatId).silenced) return
      const cue = progressRef.current
      const userText = latestUserText(chatsByIdRef.current[chatId]?.messages)
      const echoesUser = echoesUserRequest(cue.speech, userText) || echoesUserRequest(cue.label, userText)
      const userBusy =
        userTalkingRef.current ||
        statusRef.current === 'listening' ||
        statusRef.current === 'transcribing'
      if (
        !shouldAnnounceProgress({
          now: Date.now(),
          replyAt: replyAt.current,
          announcedAt: announcedAt.current,
          lastKey: announcedKey.current,
          key: cue.key,
          speaking: isAsideSpeaking(),
          userBusy,
          echoesUser
        })
      ) {
        return
      }
      const speech = echoesUser ? STILL_ON_IT_SPEECH : cue.speech
      announcedAt.current = Date.now()
      announcedKey.current = cue.key
      progressSpokenText = `${progressSpokenText} ${speech}`.trim().slice(-2000)
      const epoch = speakEpoch.current
      setStatus('speaking')
      void speakAside(speech, voiceNow)
        .catch((err) => {
          if (epoch !== speakEpoch.current) return
          if (streamsRef.current[chatId]?.status !== 'streaming') return
          setError(err instanceof Error ? err.message : 'Could not speak')
          setStatus('error')
        })
        .finally(() => {
          if (epoch !== speakEpoch.current) return
          if (streamsRef.current[chatId]?.status !== 'streaming') return
          if (statusRef.current === 'speaking' && !isSpeaking() && !isAsideSpeaking()) setStatus('waiting')
        })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  const wasEnabled = useRef(voice.enabled)
  useEffect(() => {
    if (wasEnabled.current && !voice.enabled && !enablingRef.current) stopAll()
    wasEnabled.current = voice.enabled
  }, [stopAll, voice.enabled])

  const wasConversation = useRef(voice.conversation)
  useEffect(() => {
    if (wasConversation.current && !voice.conversation && liveRef.current && !enablingRef.current) {
      stopAll()
    }
    wasConversation.current = voice.conversation
  }, [stopAll, voice.conversation])

  useEffect(() => {
    if (!recorder.current || !liveRef.current) return
    const current = recorder.current
    recorder.current = null
    void current.stop()
    void startListen({ preserveSpeech: true })
  }, [startListen, voice.micDeviceId])

  useEffect(() => {
    if (!voice.enabled) return
    void window.workbench.ensureVoiceModel().then((next) => {
      if (next.ready) warmAsideVoice()
    })
  }, [voice.enabled])

  const consumeTranscript = useCallback(() => setPendingTranscript(null), [])

  const value = useMemo<VoiceContextValue>(
    () => ({
      enabled: voice.enabled,
      conversation: voice.conversation,
      live,
      userTalking,
      level,
      bands,
      status,
      error,
      model,
      pendingTranscript,
      caption,
      consumeTranscript,
      toggleListen,
      toggleConversation,
      stopAll,
      speaks: live || (voice.enabled && voice.speakReplies),
      replyMuted,
      muteReply
    }),
    [
      caption,
      consumeTranscript,
      bands,
      error,
      level,
      live,
      model,
      muteReply,
      pendingTranscript,
      replyMuted,
      status,
      toggleConversation,
      toggleListen,
      stopAll,
      userTalking,
      voice.conversation,
      voice.enabled,
      voice.speakReplies
    ]
  )

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}

type ChatSpeech = {
  plain: string
  ids: Set<string>
  draftLen: number
  silenced: boolean
  hearing: boolean
}

const speechByChat = new Map<string, ChatSpeech>()
let progressSpokenText = ''

function speechState(chatId: string): ChatSpeech {
  let state = speechByChat.get(chatId)
  if (!state) {
    state = { plain: '', ids: new Set(), draftLen: 0, silenced: false, hearing: false }
    speechByChat.set(chatId, state)
  }
  return state
}

function heardText(chatId: string): string {
  return `${speechState(chatId).plain} ${progressSpokenText}`.trim()
}

function latestUserText(messages: { role: string; content: string }[] | undefined): string {
  if (!messages) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return speakableText(messages[i].content)
  }
  return ''
}

function leftoverSpeak(full: string, consumed: string): string {
  const a = full.replace(/\s+/g, ' ').trim()
  const b = consumed.replace(/\s+/g, ' ').trim()
  if (!a || a === b) return ''
  if (!b) return a
  if (a.startsWith(b)) return a.slice(b.length).trim()
  if (a.toLowerCase().startsWith(b.toLowerCase())) return a.slice(b.length).trim()
  if (b.toLowerCase().includes(a.toLowerCase())) return ''
  return a
}

const SAMPLE_FLOOR = 1600

function isLikelyEcho(transcript: string, spoken: string): boolean {
  const a = transcript.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const b = spoken.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (!a || !b) return false
  if (a.length >= 8 && b.includes(a)) return true
  const words = a.split(' ').filter((word) => word.length > 2)
  if (words.length < 3) return false
  const spokenWords = new Set(b.split(' '))
  const overlap = words.filter((word) => spokenWords.has(word)).length
  return overlap / words.length >= 0.55
}

export function useVoice(): VoiceContextValue {
  const value = useContext(VoiceContext)
  if (!value) {
    return {
      enabled: false,
      conversation: false,
      live: false,
      userTalking: false,
      level: 0,
      bands: [0, 0, 0, 0, 0, 0, 0],
      status: 'idle',
      error: null,
      model: emptyModel,
      pendingTranscript: null,
      caption: '',
      consumeTranscript: () => undefined,
      toggleListen: () => undefined,
      toggleConversation: () => undefined,
      stopAll: () => undefined,
      speaks: false,
      replyMuted: false,
      muteReply: () => undefined
    }
  }
  return value
}
