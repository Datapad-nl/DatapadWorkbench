import { describe, expect, it } from 'vitest'
import { applyAskElicitationResponse, askUserQuestionsToCreateRequest } from '@agentclientprotocol/claude-agent-acp/dist/elicitation.js'
import { elicitationResult, parseAsk, type QuestionOutcome } from './questions'

type AskQuestion = Parameters<typeof applyAskElicitationResponse>[2][number]

const pace: AskQuestion = {
  question: 'How fast should it go?',
  header: 'Pace',
  multiSelect: false,
  options: [
    { label: 'Fast', description: 'Ship today', preview: '<b>fast</b>' },
    { label: 'Careful', description: 'Take a day' }
  ]
}

const extras: AskQuestion = {
  question: 'Which extras?',
  header: 'Extras',
  multiSelect: true,
  options: [
    { label: 'Tests', description: 'Add tests' },
    { label: 'Docs', description: 'Add docs' }
  ]
}

/** Workbench's reply, read back by the adapter the way the agent will see it. */
function roundTrip(questions: AskQuestion[], answers: Array<string | string[]> | null): unknown {
  const request = askUserQuestionsToCreateRequest(questions, 'session', undefined)
  const parsed = parseAsk(request)
  if (!parsed) throw new Error('no questions parsed')
  const outcome: QuestionOutcome = answers
    ? { type: 'Accepted', partial_answers: answers }
    : { type: 'SkipInterview' }
  return applyAskElicitationResponse(elicitationResult(outcome, parsed.fields), { questions }, questions)
}

describe('Claude AskUserQuestion elicitation', () => {
  it('shows each question with its text and options, hiding the Other companion fields', () => {
    const parsed = parseAsk(askUserQuestionsToCreateRequest([pace, extras], 'session', undefined))
    expect(parsed?.questions).toEqual([
      {
        question: 'How fast should it go?',
        header: 'Pace',
        multiSelect: false,
        options: [
          { label: 'Fast', description: 'Ship today', preview: '<b>fast</b>' },
          { label: 'Careful', description: 'Take a day', preview: null }
        ]
      },
      {
        question: 'Which extras?',
        header: 'Extras',
        multiSelect: true,
        options: [
          { label: 'Tests', description: 'Add tests', preview: null },
          { label: 'Docs', description: 'Add docs', preview: null }
        ]
      }
    ])
  })

  it('takes a single question’s text from the message', () => {
    const parsed = parseAsk(askUserQuestionsToCreateRequest([pace], 'session', undefined))
    expect(parsed?.questions.map((item) => item.question)).toEqual(['How fast should it go?'])
  })

  it('returns picked options as answers', () => {
    expect(roundTrip([pace, extras], ['Careful', ['Tests', 'Docs']])).toEqual({
      action: 'answered',
      updatedInput: {
        questions: [pace, extras],
        answers: { 'How fast should it go?': 'Careful', 'Which extras?': 'Tests, Docs' }
      }
    })
  })

  it('returns typed Other text as the answer', () => {
    expect(roundTrip([pace, extras], ['Medium, please', ['Docs', 'Benchmarks']])).toEqual({
      action: 'answered',
      updatedInput: {
        questions: [pace, extras],
        answers: { 'How fast should it go?': 'Medium, please', 'Which extras?': 'Docs, Benchmarks' }
      }
    })
  })

  it('tells the agent the user skipped instead of aborting the tool call', () => {
    expect(roundTrip([pace], null)).toEqual({
      action: 'answered',
      updatedInput: { questions: [pace], answers: {} }
    })
  })
})

describe('plain enum elicitation', () => {
  it('reads enum options and answers with the picked value', () => {
    const params = {
      message: 'Pick a colour',
      requestedSchema: { type: 'object', properties: { colour: { type: 'string', enum: ['red', 'blue'] } } }
    }
    const parsed = parseAsk(params)
    expect(parsed?.questions[0]).toMatchObject({ question: 'Pick a colour', multiSelect: false })
    expect(parsed?.questions[0].options.map((option) => option.label)).toEqual(['red', 'blue'])
    expect(elicitationResult({ type: 'Accepted', partial_answers: ['blue'] }, parsed!.fields)).toEqual({
      action: 'accept',
      content: { colour: 'blue' }
    })
  })
})
