import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOT_NAME,
  DOMAIN,
  GOOGLE_DOCS,
  RESOURCES,
  formatRedirect,
  buildRedirectReply,
  matchResources,
  withGuildtagUrls,
} from './index.js'

describe('paperclip catalog', () => {
  it('exposes redirect-only branding and domains', () => {
    assert.equal(BOT_NAME, 'Paperclip')
    assert.ok(RESOURCES.length >= 30)
    assert.ok(RESOURCES.every((r) => r.domain && Object.values(DOMAIN).includes(r.domain)))
  })

  it('keeps Google Doc destinations for flags, member, and potime', () => {
    assert.equal(RESOURCES.find((r) => r.id === 'doc-flags').url, GOOGLE_DOCS.flags)
    assert.equal(RESOURCES.find((r) => r.id === 'doc-member').url, GOOGLE_DOCS.member)
    assert.equal(RESOURCES.find((r) => r.id === 'doc-potime').url, GOOGLE_DOCS.potime)
  })

  it('applies guildtag crawl urls by id', () => {
    const next = withGuildtagUrls({
      'post-velketor': 'https://nagd.guildtag.com/forum-thread/velketor/1/',
    })
    assert.equal(next.find((r) => r.id === 'post-velketor').url, 'https://nagd.guildtag.com/forum-thread/velketor/1/')
  })

  it('ships live guildtag urls for mapped forum posts', () => {
    assert.match(
      RESOURCES.find((r) => r.id === 'post-grummus').url,
      /grummus-low-numbers-strat\/374050/,
    )
    assert.match(RESOURCES.find((r) => r.id === 'post-ac-augs').url, /ac-augs.*374051/)
    assert.match(RESOURCES.find((r) => r.id === 'post-resists').url, /374022/)
  })
})

describe('paperclip match helpers', () => {
  it('formatRedirect never embeds a url in the text line', () => {
    const flags = RESOURCES.find((r) => r.id === 'doc-flags')
    assert.doesNotMatch(formatRedirect(flags), /https?:\/\//)
  })

  it('matchResources scores velketor above unrelated bosses', () => {
    const { status, matches } = matchResources('Velketor zone pull')
    assert.equal(status, 'match')
    assert.equal(matches[0].resource.id, 'post-velketor')
  })

  it('returns none for unrelated queries', () => {
    const reply = buildRedirectReply('what is the weather in freeport')
    assert.equal(reply.status, 'none')
    assert.equal(reply.links.length, 0)
  })
})
