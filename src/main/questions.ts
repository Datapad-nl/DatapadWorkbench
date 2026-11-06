import type { UserQuestion, UserQuestionAnswer, UserQuestionRequest } from '../shared/types'
import { chatIdForSession, fallbackSessionId } from './permissions'

export type QuestionOutcome =
  | { type: 'Accepted'; partial_answers: Array<string | string[]> }
  | { type: 'SkipInterview' }

type PendingAsk = {
  request: UserQuestionRequest
  sessionId: string
  kind: 'ext' | 'elicitation'
  resolve: (outcome: QuestionOutcome) => void
}

const pending = new Map<string, PendingAsk>()
const promptListeners = new Set<(request: UserQuestionRequest) => void>()
const settleListeners = new Set<(request: UserQuestionRequest) => void>()

export function onUserQuestionPrompt(listener: (request: UserQuestionRequest) => void): () => void {
  promptListeners.add(listener)
  return () => {
    promptListeners.delete(listener)
  }
}

export function onUserQuestionSettled(listener: (request: UserQuestionRequest) => void): () => void {
  settleListeners.add(listener)
  return () => {
    settleListeners.delete(listener)
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseOptions(value: unknown): UserQuestion['options'] {
  if (!Array.isArray(value)) return []
  const options: UserQuestion['options'] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      options.push({ label: item.trim(), description: null, preview: null })
      continue
    }
    const record = asRecord(item)
    if (!record) continue
    const label = asString(record.label) ?? asString(record.name) ?? asString(record.title)
    if (!label) continue
    options.push({
      label,
      description: asString(record.description),
      preview: asString(record.preview)
    })
  }
  return options
}

function parseQuestion(value: unknown): UserQuestion | null {
  const record = asRecord(value)
  if (!record) return null
  const question =
    asString(record.question) ?? asString(record.header) ?? asString(record.title) ?? asString(record.message)
  if (!question) return null
  const options = parseOptions(record.options ?? record.choices)
  const multiSelect = record.multiSelect === true || record.multi_select === true
  return {
    question,
    header: asString(record.header),
    multiSelect,
    options
  }
}

/** Where a question's answer goes in an elicitation response. */
export type AnswerField = {
  key: string
  /** The free-text companion field ("Other") the Claude adapter adds per question. */
  customKey: string | null
  /** Option label shown to the user → the value the schema expects. */
  values: Record<string, string>
}

export type ParsedAsk = { questions: UserQuestion[]; fields: AnswerField[] }

const OPTION_META_KEY = '_claude/askUserQuestionOption'

/** Options from `enum`, or from titled `oneOf` / `anyOf` entries, on the field or its array items. */
function fieldOptions(field: Record<string, unknown>): Pick<UserQuestion, 'options'> & { values: Record<string, string> } {
  const items = asRecord(field.items)
  const titled = [field.oneOf, field.anyOf, items?.oneOf, items?.anyOf].find(Array.isArray) as unknown[] | undefined
  const values: Record<string, string> = {}
  if (!titled) {
    const options = parseOptions(Array.isArray(field.enum) ? field.enum : Array.isArray(items?.enum) ? items.enum : [])
    for (const option of options) values[option.label] = option.label
    return { options, values }
  }
  const options: UserQuestion['options'] = []
  for (const entry of titled) {
    const record = asRecord(entry)
    const raw = record?.const
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue
    const value = String(raw)
    const label = asString(record?.title) ?? value
    values[label] = value
    options.push({
      label,
      description: asString(record?.description),
      preview: asString(asRecord(asRecord(record?._meta)?.[OPTION_META_KEY])?.preview)
    })
  }
  return { options, values }
}

function parseElicitation(record: Record<string, unknown>): ParsedAsk {
  const properties = asRecord(asRecord(record.requestedSchema ?? record.schema)?.properties) ?? {}
  const isCompanion = (key: string): boolean =>
    key.endsWith('_custom') && asRecord(properties[key.slice(0, -'_custom'.length)]) !== null
  const keys = Object.keys(properties).filter((key) => asRecord(properties[key]) && !isCompanion(key))
  const questions: UserQuestion[] = []
  const fields: AnswerField[] = []
  for (const key of keys) {
    const field = properties[key] as Record<string, unknown>
    const { options, values } = fieldOptions(field)
    // With one question the adapter puts its text in `message`, not in the field.
    const message = keys.length === 1 ? asString(record.message) : null
    questions.push({
      question: asString(field.description) ?? message ?? asString(field.title) ?? key,
      header: asString(field.title),
      multiSelect: field.type === 'array',
      options
    })
    const customKey = `${key}_custom`
    fields.push({ key, customKey: isCompanion(customKey) ? customKey : null, values })
  }
  return { questions, fields }
}

export function parseAsk(params: unknown): ParsedAsk | null {
  const record = asRecord(params)
  if (!record) return null
  const toolCall = asRecord(record.toolCall)
  const nested =
    record.questions ??
    asRecord(record.rawInput)?.questions ??
    asRecord(record.input)?.questions ??
    asRecord(record.params)?.questions ??
    asRecord(toolCall?.rawInput)?.questions
  if (Array.isArray(nested)) {
    const questions = nested.map(parseQuestion).filter((item): item is UserQuestion => Boolean(item))
    const fields = questions.map((_, index) => ({ key: `q${index}`, customKey: null, values: {} }))
    return questions.length > 0 ? { questions, fields } : null
  }
  const parsed = parseElicitation(record)
  return parsed.questions.length > 0 ? parsed : null
}

export function parseQuestions(params: unknown): UserQuestion[] | null {
  return parseAsk(params)?.questions ?? null
}

export function isUserQuestionMethod(method: string | undefined): boolean {
  if (!method) return false
  const name = method.toLowerCase()
  return (
    name === 'x.ai/ask_user_question' ||
    name === 'ask_user_question' ||
    name.endsWith('/ask_user_question')
  )
}

export function isElicitationMethod(method: string | undefined): boolean {
  return method === 'elicitation/create'
}

export function looksLikeUserQuestion(params: unknown): boolean {
  return parseQuestions(params) !== null
}

export function skipOutcome(): QuestionOutcome {
  return { type: 'SkipInterview' }
}

/**
 * Skip declines, which tells the agent the user skipped; cancel would abort its tool call.
 * Picked labels go back as their schema values, typed text into the question's "Other" field.
 */
export function elicitationResult(
  outcome: QuestionOutcome,
  fields: AnswerField[]
): { action: 'accept' | 'decline'; content?: Record<string, string | string[]> } {
  if (outcome.type !== 'Accepted') return { action: 'decline' }
  const content: Record<string, string | string[]> = {}
  fields.forEach((field, index) => {
    const answer = outcome.partial_answers[index] ?? ''
    const items = (Array.isArray(answer) ? answer : [answer]).filter((item) => item !== '')
    const picks = items.filter((item) => item in field.values).map((item) => field.values[item])
    const typed = items.filter((item) => !(item in field.values))
    const toCustom = field.customKey !== null && typed.length > 0
    if (Array.isArray(answer)) {
      content[field.key] = toCustom ? picks : [...picks, ...typed]
    } else if (picks.length > 0 || !toCustom) {
      content[field.key] = picks[0] ?? typed[0] ?? ''
    }
    if (toCustom) content[field.customKey as string] = typed.join(', ')
  })
  return { action: 'accept', content }
}

export function askUserQuestions(
  requestId: string,
  sessionId: string,
  questions: UserQuestion[],
  kind: PendingAsk['kind'] = 'ext',
  options?: { chatId?: string; title?: string | null }
): Promise<QuestionOutcome> {
  const chatId = options?.chatId || chatIdForSession(sessionId || fallbackSessionId())
  if (!chatId) return Promise.resolve(skipOutcome())

  const request: UserQuestionRequest = {
    requestId,
    chatId,
    questions,
    title: options?.title ?? null
  }

  return new Promise((resolve) => {
    pending.set(requestId, {
      request,
      sessionId,
      kind,
      resolve: (outcome) => {
        pending.delete(requestId)
        resolve(outcome)
        for (const listener of settleListeners) listener(request)
      }
    })
    for (const listener of promptListeners) listener(request)
  })
}

export function resolveUserQuestion(
  requestId: string,
  decision: { type: 'skip' } | { type: 'submit'; answers: UserQuestionAnswer[] }
): boolean {
  const item = pending.get(requestId)
  if (!item) return false
  if (decision.type === 'skip') {
    item.resolve(skipOutcome())
    return true
  }
  const answers = item.request.questions.map((itemQuestion, index) => {
    const picked = decision.answers[index] ?? []
    if (itemQuestion.multiSelect) return picked
    return picked[0] ?? ''
  })
  item.resolve({ type: 'Accepted', partial_answers: answers })
  return true
}

function cancelMatching(predicate: (item: PendingAsk) => boolean): void {
  for (const item of [...pending.values()]) {
    if (!predicate(item)) continue
    item.resolve(skipOutcome())
  }
}

export function cancelSessionQuestions(sessionId: string): void {
  cancelMatching((item) => item.sessionId === sessionId)
}

/** Intake asks under `intake:<chatId>` and has no agent turn. Stopping a turn leaves it alone. */
function isIntake(item: PendingAsk): boolean {
  return item.sessionId.startsWith('intake:')
}

export function cancelChatQuestions(chatId: string, options: { keepIntake?: boolean } = {}): void {
  cancelMatching((item) => item.request.chatId === chatId && !(options.keepIntake && isIntake(item)))
}

/** Every question an agent asked. Intake's own questions stay. */
export function cancelAgentQuestions(): void {
  cancelMatching((item) => !isIntake(item))
}

/** The questions still waiting for an answer, so a reloaded window can show them again. */
export function pendingQuestionRequests(): UserQuestionRequest[] {
  return [...pending.values()].map((item) => item.request)
}
