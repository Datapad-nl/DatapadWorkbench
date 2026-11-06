import { describe, expect, it, vi } from 'vitest'

const page = vi.hoisted(() => ({
  pending: null as null | ((value: unknown) => void),
  order: [] as string[]
}))

vi.mock('./browser', () => {
  const state = { url: 'http://127.0.0.1/', title: '', loading: false }
  return {
    browserConsole: () => [],
    getBrowserState: () => state,
    requestShowBrowser: () => undefined,
    browserContents: () => ({
      isLoading: () => false,
      executeJavaScript: () => {
        page.order.push('evaluate starts')
        return new Promise((resolve) => {
          page.pending = (value) => {
            page.order.push('evaluate ends')
            resolve(value)
          }
        })
      }
    }),
    navigateBrowser: async (url: string) => {
      page.order.push(`navigate ${url}`)
      return state
    },
    goBack: () => {
      page.order.push('back')
      return state
    },
    goForward: () => {
      page.order.push('forward')
      return state
    },
    reloadBrowser: () => {
      page.order.push('reload')
      return state
    }
  }
})

import { back, evaluate, forward, navigate, reload } from './browserDrive'

describe('browser drive queue', () => {
  it('holds navigation until the drive call before it is done', async () => {
    const running = evaluate('1')
    const moves = Promise.all([navigate('http://127.0.0.1/next'), back(), forward(), reload()])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(page.order).toEqual(['evaluate starts'])

    page.pending?.(1)
    await running
    await moves
    expect(page.order).toEqual([
      'evaluate starts',
      'evaluate ends',
      'navigate http://127.0.0.1/next',
      'back',
      'forward',
      'reload'
    ])
  })
})
