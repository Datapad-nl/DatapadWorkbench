import { describe, expect, it } from 'vitest'
import { dropRequest, groupByChat, pushRequest } from './workspace'

const own = { requestId: 'r1', chatId: 'chat-1' }
const fromBot = { requestId: 'r2', chatId: 'run-1', shownIn: { chatId: 'chat-1', botName: 'Master Chief' } }

describe('request queues', () => {
  it('queues a request of a chat under that chat', () => {
    const queues = pushRequest({}, own)
    expect(queues).toEqual({ 'chat-1': [own] })
    expect(dropRequest(queues, 'chat-1', 'r1')).toEqual({})
  })

  it('queues a request of a bot asked from another chat under the asking chat, and drops it from there', () => {
    const queues = pushRequest(pushRequest({}, own), fromBot)
    expect(queues).toEqual({ 'chat-1': [own, fromBot] })
    expect(dropRequest(queues, 'chat-1', 'r2')).toEqual({ 'chat-1': [own] })
  })

  it('puts the requests restored after a reload in the same chats', () => {
    expect(groupByChat([own, fromBot, { requestId: 'r3', chatId: 'chat-2' }])).toEqual({
      'chat-1': [own, fromBot],
      'chat-2': [{ requestId: 'r3', chatId: 'chat-2' }]
    })
  })
})
