import { describe, expect, it } from 'vitest'
import { streamStatuses } from './streamStatus'

const streaming = (draft: string) => ({ status: 'streaming' as const, draft, error: null, turnId: 1 })
const idle = (error: string | null) => ({ status: 'idle' as const, draft: '', error, turnId: 1 })

describe('streamStatuses', () => {
  it('keeps the same object while only the reply text grows', () => {
    const first = streamStatuses({}, { a: streaming('He') })
    expect(first).toEqual({ a: { status: 'streaming', error: null } })
    expect(streamStatuses(first, { a: streaming('Hello') })).toBe(first)
  })

  it('changes when a status or an error does', () => {
    const first = streamStatuses({}, { a: streaming('Hello') })
    const done = streamStatuses(first, { a: idle(null) })
    expect(done).toEqual({ a: { status: 'idle', error: null } })
    const failed = streamStatuses(done, { a: idle('No reply') })
    expect(failed).toEqual({ a: { status: 'idle', error: 'No reply' } })
  })

  it('changes when a chat starts or is dropped', () => {
    const first = streamStatuses({}, { a: streaming('') })
    const two = streamStatuses(first, { a: streaming(''), b: streaming('') })
    expect(Object.keys(two)).toEqual(['a', 'b'])
    expect(streamStatuses(two, { b: streaming('') })).toEqual({ b: { status: 'streaming', error: null } })
    expect(streamStatuses(first, { b: streaming('') })).not.toBe(first)
  })
})
