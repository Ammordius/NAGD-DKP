import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_SITE_TIME_ZONE,
  listTimeZoneOptions,
  profileTimeZone,
  timeZoneOptionLabel,
} from './siteTimeZone.js'

const october = new Date('2026-10-14T16:00:00Z')

describe('profileTimeZone', () => {
  it('defaults to Eastern and keeps a saved zone', () => {
    assert.equal(profileTimeZone(null), DEFAULT_SITE_TIME_ZONE)
    assert.equal(profileTimeZone({}), 'America/New_York')
    assert.equal(profileTimeZone({ timeZone: 'Pacific/Auckland' }), 'Pacific/Auckland')
    assert.equal(profileTimeZone({ timeZone: 'not a zone' }), 'America/New_York')
    assert.equal(profileTimeZone({ timeZone: true }), 'America/New_York')
  })
})

describe('timeZoneOptionLabel', () => {
  it('matches the offset, place, and DST caption used in the dropdown', () => {
    assert.equal(
      timeZoneOptionLabel('America/Indiana/Vincennes', october),
      '-04:00 GMT America, Indiana, Vincennes (DST Observed)',
    )
    assert.equal(
      timeZoneOptionLabel('America/New_York', october),
      '-04:00 GMT America, New York (DST Observed)',
    )
    assert.equal(timeZoneOptionLabel('Etc/GMT+5', october), '-05:00 GMT Etc, GMT+5')
    assert.equal(timeZoneOptionLabel('Pacific/Auckland', october).startsWith('+13:00 GMT Pacific, Auckland'), true)
    assert.equal(timeZoneOptionLabel('Pacific/Auckland', october).endsWith('(DST Observed)'), true)
  })

  it('sorts by the current offset', () => {
    const options = listTimeZoneOptions(october)
    const vincennes = options.find((option) => option.id === 'America/Indiana/Vincennes')
    const auckland = options.find((option) => option.id === 'Pacific/Auckland')
    assert.ok(vincennes)
    assert.ok(auckland)
    assert.ok(options.indexOf(vincennes) < options.indexOf(auckland))
    for (let i = 1; i < options.length; i++) {
      assert.ok(options[i - 1].offset <= options[i].offset)
    }
  })
})
