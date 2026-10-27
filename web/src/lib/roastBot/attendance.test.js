import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAccountAttendanceFacts,
  attendanceRoastEligibility,
  responseImpliesCharacterAbsence,
} from './attendance.js'
import { handleMessage, createConversationState } from './conversation.js'
import { buildAccountFacts } from './facts.js'

const warrior = { char_id: 'w1', name: 'Zender', class_name: 'Warrior' }
const cleric = { char_id: 'c1', name: 'Zenderheals', class_name: 'Cleric' }
const wizard = { char_id: 'z1', name: 'Zenderwiz', class_name: 'Wizard' }

function baseFacts(attendanceRows, extras = {}) {
  return buildAccountFacts({
    accountId: 'acct-1',
    accountName: 'ZenderAcct',
    currentDkp: 100,
    characters: extras.characters || [warrior, cleric],
    characterAccount: [
      { char_id: 'w1', account_id: 'acct-1' },
      { char_id: 'c1', account_id: 'acct-1' },
      ...(extras.extraLinks || []),
    ],
    attendanceRows,
    raidsById: extras.raidsById || {
      pot: { raid_id: 'pot', raid_name: 'Plane of Time', date_iso: '2026-10-01' },
    },
    guildRaidCountInWindow: extras.guildRaidCountInWindow ?? 20,
    lootRows: extras.lootRows || [],
    now: extras.now || new Date('2026-10-20T12:00:00Z'),
  })
}

describe('roastBot attendance semantics', () => {
  it('Test A: warrior attendance ⇒ account attended; no cleric-absence accusation', () => {
    const facts = baseFacts([
      { raid_id: 'pot', char_id: 'w1', character_name: 'Zender', account_id: 'acct-1' },
    ])
    assert.equal(facts.accountRaidCount, 1)
    assert.equal(facts.lastAccountRaid.raidName, 'Plane of Time')

    const { response } = handleMessage({
      text: "How's my raiding?",
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(
      responseImpliesCharacterAbsence(response.text, ['Zenderheals', 'cleric']),
      false,
      response.text,
    )
    assert.equal(facts.attendanceEligibility.canRoastCharacterAbsence, false)
  })

  it('Test B: cleric attendance ⇒ account attended; no warrior-absence accusation', () => {
    const facts = baseFacts([
      { raid_id: 'pot', char_id: 'c1', character_name: 'Zenderheals', account_id: 'acct-1' },
    ])
    assert.equal(facts.accountRaidCount, 1)
    const { response } = handleMessage({
      text: "How's my raiding?",
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(
      responseImpliesCharacterAbsence(response.text, ['Zender', 'warrior']),
      false,
      response.text,
    )
  })

  it('Test C: only warrior on ten raids ⇒ ten account raids; zero class-absence conclusions', () => {
    const raidsById = {}
    const attendanceRows = []
    for (let i = 1; i <= 10; i++) {
      const id = `r${i}`
      const day = String(i).padStart(2, '0')
      raidsById[id] = { raid_id: id, raid_name: `Raid ${i}`, date_iso: `2026-09-${day}` }
      attendanceRows.push({ raid_id: id, char_id: 'w1', character_name: 'Zender', account_id: 'acct-1' })
    }
    const facts = baseFacts(attendanceRows, {
      characters: [warrior, cleric, wizard],
      extraLinks: [{ char_id: 'z1', account_id: 'acct-1' }],
      raidsById,
      now: new Date('2026-10-15T12:00:00Z'),
      guildRaidCountInWindow: 20,
    })
    assert.equal(facts.accountRaidCount, 10)
    assert.equal(facts.attendanceEligibility.canRoastCharacterAbsence, false)
    const { response } = handleMessage({
      text: 'Why dont you think I bring my cleric?',
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(responseImpliesCharacterAbsence(response.text, ['Zenderheals', 'Zenderwiz', 'cleric', 'wizard']), false, response.text)
  })

  it('Test D: no attendance in partially populated window ⇒ unknown/insufficient; no absence roast', () => {
    const facts = baseFacts([], { guildRaidCountInWindow: 2 })
    assert.ok(['unknown', 'insufficient'].includes(facts.dataCoverage.attendance))
    assert.equal(facts.attendanceEligibility.canRoastSparse, false)
    const att = buildAccountAttendanceFacts({
      accountId: 'acct-1',
      characters: [warrior, cleric],
      attendanceRows: [],
      raidsById: {},
      guildRaidCountInWindow: 2,
      now: new Date('2026-10-20T12:00:00Z'),
    })
    assert.equal(att.dataCoverage, 'insufficient')
  })

  it('Test E: genuine zero attendance with sufficient coverage ⇒ account-level inactivity OK', () => {
    const facts = baseFacts([], {
      guildRaidCountInWindow: 20,
      now: new Date('2026-10-20T12:00:00Z'),
    })
    // no last raid → daysSince null; sparse via count===0 with sufficient coverage
    assert.equal(facts.dataCoverage.attendance, 'sufficient')
    assert.equal(facts.attendanceEligibility.canRoastSparse, true)
    const { response } = handleMessage({
      text: "How's my raiding?",
      facts,
      state: createConversationState(),
      rng: () => 0,
    })
    assert.equal(responseImpliesCharacterAbsence(response.text, ['Zender', 'Zenderheals']), false, response.text)
    assert.match(response.text, /account|raid|attendance|quiet|sparse|calendar|loot table|days/i)
  })

  it('Test F: multiple character attendance rows for one raid ⇒ one account participation', () => {
    const facts = baseFacts([
      { raid_id: 'pot', char_id: 'w1', character_name: 'Zender', account_id: 'acct-1' },
      { raid_id: 'pot', char_id: 'c1', character_name: 'Zenderheals', account_id: 'acct-1' },
    ])
    assert.equal(facts.accountRaidCount, 1)
  })

  it('dedupes and never enables character-absence eligibility', () => {
    const elig = attendanceRoastEligibility({
      dataCoverage: 'sufficient',
      accountRaidCount: 10,
      daysSince: 2,
      returnGapDays: null,
    })
    assert.equal(elig.canRoastCharacterAbsence, false)
    assert.equal(elig.canRoastFrequent, true)
  })
})
