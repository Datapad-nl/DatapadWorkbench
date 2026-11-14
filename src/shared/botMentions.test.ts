import { describe, expect, it } from 'vitest'
import { botMentionParts, mentionedBots, splitBotMentions } from './botMentions'

const ads = { id: 'ads', name: 'Ads Checker' }
const adsShort = { id: 'a', name: 'Ads' }
const scout = { id: 'scout', name: 'Scout' }
const bots = [adsShort, ads, scout]

describe('splitBotMentions', () => {
  it('addresses the bots a message starts with', () => {
    expect(splitBotMentions('@Ads Checker check these ads', bots)).toEqual({
      addressed: [ads],
      referenced: [],
      rest: 'check these ads'
    })
    expect(splitBotMentions('  @scout, @Ads Checker: look at this', bots)).toEqual({
      addressed: [scout, ads],
      referenced: [],
      rest: 'look at this'
    })
  })

  it('ends the addressed bots at a colon', () => {
    expect(splitBotMentions('@Scout: @Ads is flaky', bots)).toEqual({
      addressed: [scout],
      referenced: [adsShort],
      rest: '@Ads is flaky'
    })
  })

  it('leaves a bot named inside the sentence to the agent', () => {
    expect(splitBotMentions('send these to @Ads Checker so they join the campaign', bots)).toEqual({
      addressed: [],
      referenced: [ads],
      rest: 'send these to @Ads Checker so they join the campaign'
    })
  })

  it('sees bots named after the addressed ones', () => {
    expect(splitBotMentions('@Scout compare with @Ads', bots)).toEqual({
      addressed: [scout],
      referenced: [adsShort],
      rest: 'compare with @Ads'
    })
  })

  it('does not take a longer word or an email address for a mention', () => {
    expect(splitBotMentions('@Scouting is fun', bots).addressed).toEqual([])
    expect(mentionedBots('mail me@Scout.nl', bots)).toEqual([])
  })

  it('keeps its place after letters that change length in lower case', () => {
    expect(mentionedBots('İstanbul: @Scout', bots)).toEqual([scout])
  })
})

describe('botMentionParts', () => {
  it('cuts the text around each mention, keeping how it was written', () => {
    expect(botMentionParts('to @ads checker now', bots)).toEqual(['to ', { bot: ads, text: '@ads checker' }, ' now'])
  })
})
