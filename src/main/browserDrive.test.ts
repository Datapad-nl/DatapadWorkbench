import { beforeEach, describe, expect, it, vi } from 'vitest'

const page = vi.hoisted(() => ({
  pending: new Map<string, (value: unknown) => void>(),
  order: [] as string[]
}))

vi.mock('./browser', () => {
  const state = { url: 'http://127.0.0.1/', title: '', loading: false }
  return {
    browserConsole: () => [],
    browserPainted: () => true,
    getBrowserState: () => state,
    browserContents: (scope: string) => ({
      isLoading: () => false,
      executeJavaScript: () => {
        page.order.push(`${scope} evaluate starts`)
        return new Promise((resolve) => {
          page.pending.set(scope, (value) => {
            page.order.push(`${scope} evaluate ends`)
            resolve(value)
          })
        })
      }
    }),
    navigateBrowser: async (scope: string, url: string) => {
      page.order.push(`${scope} navigate ${url}`)
      return state
    },
    goBack: (scope: string) => {
      page.order.push(`${scope} back`)
      return state
    },
    goForward: (scope: string) => {
      page.order.push(`${scope} forward`)
      return state
    },
    reloadBrowser: (scope: string) => {
      page.order.push(`${scope} reload`)
      return state
    }
  }
})

import { back, evaluate, forward, navigate, reload } from './browserDrive'

const tick = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  page.pending.clear()
  page.order.length = 0
})

describe('browser drive queue', () => {
  it('holds navigation until the drive call before it in the same scope is done', async () => {
    const running = evaluate('p', '1')
    const moves = Promise.all([navigate('p', 'http://127.0.0.1/next'), back('p'), forward('p'), reload('p')])
    await tick()
    expect(page.order).toEqual(['p evaluate starts'])

    page.pending.get('p')?.(1)
    await running
    await moves
    expect(page.order).toEqual([
      'p evaluate starts',
      'p evaluate ends',
      'p navigate http://127.0.0.1/next',
      'p back',
      'p forward',
      'p reload'
    ])
  })

  it('runs a call in one scope while a call in another scope is still pending', async () => {
    const running = evaluate('p', '1')
    await tick()
    await navigate('bot:scout', 'http://127.0.0.1/other')
    const other = evaluate('bot:scout', '2')
    await tick()
    expect(page.order).toEqual(['p evaluate starts', 'bot:scout navigate http://127.0.0.1/other', 'bot:scout evaluate starts'])

    page.pending.get('bot:scout')?.(2)
    page.pending.get('p')?.(1)
    await Promise.all([running, other])
  })
})
