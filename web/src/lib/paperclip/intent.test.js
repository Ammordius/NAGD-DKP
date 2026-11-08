import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  GOOGLE_DOCS,
  buildRedirectReply,
  formatDisambiguation,
} from './index.js'

describe('paperclip intent routing', () => {
  it('routes backflag / flag language to the flags doc', () => {
    const reply = buildRedirectReply('how do I get flags?')
    assert.equal(reply.status, 'match')
    assert.deepEqual(reply.matchIds, ['doc-flags'])
    assert.equal(reply.links[0]?.href, GOOGLE_DOCS.flags)
    assert.doesNotMatch(reply.text, /flag sharing|welcome to NAGD|officer should have invited/i)
  })

  it('routes flag mob mentions to flagging', () => {
    const reply = buildRedirectReply('I need Grummus for flags')
    assert.equal(reply.status, 'match')
    assert.deepEqual(reply.matchIds, ['doc-flags'])
  })

  it('routes bare Grummus to flagging (not the forum LN post)', () => {
    const reply = buildRedirectReply('Grummus')
    assert.equal(reply.status, 'match')
    assert.deepEqual(reply.matchIds, ['doc-flags'])
  })

  it('routes Grummus low numbers to the forum post', () => {
    const reply = buildRedirectReply('Grummus low numbers')
    assert.equal(reply.status, 'match')
    assert.deepEqual(reply.matchIds, ['post-grummus'])
  })

  it('routes PoTime fight / Quarm / Gina with both potime resources linked', () => {
    const overview =
      'https://nagd.guildtag.com/forum-thread/raiding-in-plane-of-time/374020/'
    for (const q of ['quarm', 'quarm AE', 'gina triggers for potime', 'potime resists']) {
      const reply = buildRedirectReply(q)
      assert.equal(reply.status, 'match', q)
      assert.ok(reply.matchIds.includes('doc-potime'), q)
      assert.ok(reply.matchIds.includes('post-potime-overview'), q)
      const hrefs = reply.links.map((l) => l.href)
      assert.ok(hrefs.includes(GOOGLE_DOCS.potime), q)
      assert.ok(hrefs.includes(overview), q)
      assert.doesNotMatch(reply.text, /do not die|empty buff slots|500sv/i)
    }
  })

  it('routes potime logistics overview with the fight guide linked too', () => {
    const reply = buildRedirectReply('time lockout')
    assert.equal(reply.status, 'match')
    assert.ok(reply.matchIds.includes('post-potime-overview'))
    assert.ok(reply.matchIds.includes('doc-potime'))
    assert.equal(reply.links.length, 2)
  })

  it('asks when Bertoxxulous is ambiguous (flag vs potime)', () => {
    const reply = buildRedirectReply('bertoxx')
    assert.equal(reply.status, 'ambiguous')
    assert.ok(reply.matchIds.includes('doc-flags'))
    assert.ok(reply.matchIds.includes('doc-potime'))
    assert.match(reply.text, /Crypt of Decay|flagging/i)
    assert.match(reply.text, /Plane of Time/i)
  })

  it('routes bert + flag cues to flags; bert + potime to raid guide', () => {
    const flagReply = buildRedirectReply('bert crypt of decay')
    assert.equal(flagReply.status, 'match')
    assert.deepEqual(flagReply.matchIds, ['doc-flags'])

    const timeReply = buildRedirectReply('bert potime')
    assert.equal(timeReply.status, 'match')
    assert.ok(timeReply.matchIds.includes('doc-potime'))
    assert.ok(timeReply.matchIds.includes('post-potime-overview'))
  })

  it('asks when bare Innoruuk is ambiguous', () => {
    const reply = buildRedirectReply('innoruuk')
    assert.equal(reply.status, 'ambiguous')
    assert.ok(reply.matchIds.includes('doc-flags'))
    assert.ok(reply.matchIds.includes('doc-potime'))
  })

  it('routes Innoruuk low numbers to the forum post', () => {
    const reply = buildRedirectReply('innoruuk low numbers strat')
    assert.equal(reply.status, 'match')
    assert.deepEqual(reply.matchIds, ['post-innoruuk-ln'])
  })

  it('routes guild bidding / WTS / COTH / channels', () => {
    assert.deepEqual(buildRedirectReply('how to bid').matchIds, ['guild-bidding'])
    assert.deepEqual(buildRedirectReply('wts loot rules').matchIds, ['guild-selling-loot'])
    assert.deepEqual(buildRedirectReply('coth request').matchIds, ['guild-coth-bank'])
    assert.deepEqual(buildRedirectReply('raid channels').matchIds, ['guild-raid-channels'])
  })

  it('routes forum-only topics', () => {
    assert.deepEqual(buildRedirectReply('velketor').matchIds, ['post-velketor'])
    assert.deepEqual(buildRedirectReply('coldain ring').matchIds, ['post-coldain-ring'])
    assert.deepEqual(buildRedirectReply('ch chains').matchIds, ['post-cleric-raid'])
  })

  it('fuzzy-matches common typos to the right domain', () => {
    const grumus = buildRedirectReply('grumus')
    assert.equal(grumus.status, 'match')
    assert.deepEqual(grumus.matchIds, ['doc-flags'])

    const yelinak = buildRedirectReply('yelinak')
    assert.equal(yelinak.status, 'match')
    assert.deepEqual(yelinak.matchIds, ['post-yelinak'])
  })

  it('capabilities reply does not dump a question menu or guide text', () => {
    const reply = buildRedirectReply('what can you help with')
    assert.match(reply.text, /point you at the right guild resource/i)
    assert.doesNotMatch(reply.text, /1\.|Grummus low numbers|Welcome to NAGD/)
  })

  it('formatDisambiguation stays redirect-only', () => {
    const text = formatDisambiguation('Bertoxxulous', [
      {
        id: 'a',
        domain: 'flagging',
        resourceId: 'doc-flags',
        label: 'Bertoxx in Crypt of Decay (flagging)',
      },
      {
        id: 'b',
        domain: 'potime',
        resourceId: 'doc-potime',
        label: 'Bertoxx in Plane of Time (raid guide)',
      },
    ])
    assert.match(text, /did you mean/)
    assert.doesNotMatch(text, /https?:\/\//)
  })
})
