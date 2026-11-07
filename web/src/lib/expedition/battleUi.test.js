import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startRun, availableActions } from './gameEngine.js'
import {
  getEncounterId,
  statusLabel,
  statusCategory,
  statusMarker,
  statusRemaining,
  defaultDraftEntry,
  buildDefaultDraft,
  isDeliberateSelection,
  isDraftReady,
  queuedActionLabel,
  deriveEnemyCardState,
  derivePartyCardState,
  derivePortraitStatusFlags,
  partyClickEffect,
  diffFlashClasses,
  isLogHeaderLine,
} from './battleUi.js'

function partyOf(...classNames) {
  return classNames.map((class_name, i) => ({
    char_id: `c${i}`,
    name: `${class_name.replace(/\s/g, '')}${i}`,
    class_name,
    level: 60,
  }))
}

describe('battleUi helpers', () => {
  it('resolves encounter id from encounterIndex', () => {
    const state = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 1 })
    assert.equal(getEncounterId(state), 'entrance_guards')
    assert.equal(getEncounterId({ encounterIndex: 5 }), 'quarm')
    assert.equal(getEncounterId({}), null)
  })

  it('maps status ids to display names and categories', () => {
    assert.equal(statusLabel('stun'), 'Stunned')
    assert.equal(statusLabel({ id: 'hot' }), 'Regeneration')
    assert.equal(statusCategory('poison'), 'dot')
    assert.equal(statusCategory({ id: 'shield' }), 'defense')
    assert.equal(statusLabel('not_a_real_status'), 'not_a_real_status')
  })

  it('builds default draft with basic_attack when available', () => {
    const state = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 2 })
    const draft = buildDefaultDraft(state)
    for (const p of state.party.filter((x) => x.alive)) {
      assert.ok(draft[p.id]?.actionId)
      const entry = defaultDraftEntry(state, p)
      assert.equal(entry.actionId, draft[p.id].actionId)
    }
    const warrior = state.party[0]
    assert.equal(draft[warrior.id].actionId, 'basic_attack')
  })

  it('detects deliberate vs auto action selection', () => {
    const def = { actionId: 'basic_attack', targetId: 'e1' }
    assert.equal(isDeliberateSelection(def, def), false)
    assert.equal(isDeliberateSelection({ actionId: 'basic_attack', targetId: 'e2' }, def), true)
    assert.equal(isDeliberateSelection({ actionId: 'kick', targetId: 'e1' }, def), true)
    assert.equal(isDeliberateSelection(null, def), false)
  })

  it('labels queued actions from availableActions', () => {
    const state = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 3 })
    const p = state.party[0]
    const draft = { [p.id]: { actionId: 'basic_attack' } }
    assert.equal(queuedActionLabel(state, p.id, draft), 'Basic Attack')
    assert.equal(queuedActionLabel(state, p.id, {}), 'No action')
  })

  it('derives enemy card targeting and interruptible cast flags', () => {
    const enemy = {
      id: 'guard_a',
      alive: true,
      casting: { castName: 'Heavy Strike', interruptible: true },
      phases: null,
    }
    const s = deriveEnemyCardState({
      enemy,
      intent: { label: 'Heavy strike', interruptible: true },
      draftTargetId: 'guard_a',
      activeAction: { needsEnemyTarget: true },
    })
    assert.equal(s.isTargetable, true)
    assert.equal(s.isTargeted, true)
    assert.equal(s.isCasting, true)
    assert.equal(s.isInterruptible, true)
    assert.equal(s.castName, 'Heavy Strike')

    const dead = deriveEnemyCardState({
      enemy: { ...enemy, alive: false },
      draftTargetId: 'guard_a',
      activeAction: { needsEnemyTarget: true },
    })
    assert.equal(dead.isTargetable, false)
    assert.equal(dead.isTargeted, false)
    assert.equal(dead.isDown, true)
  })

  it('derives party card planner vs target vs auto queue', () => {
    const state = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 4 })
    const [w, c] = state.party
    const defaultDraft = buildDefaultDraft(state)
    const draft = {
      ...defaultDraft,
      [c.id]: { actionId: 'basic_attack', targetId: state.enemies[0].id },
    }
    // Force deliberate on cleric by changing action if a heal exists, else change target
    const clericOpts = availableActions(state, c)
    const heal = clericOpts.find((o) => o.needsAllyTarget && !o.needsDeadAlly)
    if (heal) {
      draft[c.id] = { actionId: heal.id, targetId: w.id }
    }

    const activeAction = heal || { needsAllyTarget: true }
    const warriorCard = derivePartyCardState({
      member: w,
      activeId: c.id,
      draft,
      defaultDraft,
      activeAction,
      state,
    })
    assert.equal(warriorCard.isActivePlanner, false)
    assert.equal(warriorCard.isTargetable, true)
    if (heal) assert.equal(warriorCard.isTargeted, true)

    const clericCard = derivePartyCardState({
      member: c,
      activeId: c.id,
      draft,
      defaultDraft,
      activeAction,
      state,
    })
    assert.equal(clericCard.isActivePlanner, true)
    if (heal) assert.equal(clericCard.isAutoQueued, false)
  })

  it('partyClickEffect decouples active switch from retarget', () => {
    const activeAction = null
    assert.deepEqual(
      partyClickEffect({ member: { id: 'p2', alive: true }, activeId: 'p1', activeAction }),
      { type: 'setActive', activeId: 'p2' },
    )

    const healAction = { needsAllyTarget: true, needsDeadAlly: false }
    assert.deepEqual(
      partyClickEffect({ member: { id: 'p2', alive: true }, activeId: 'p1', activeAction: healAction }),
      { type: 'setTarget', targetId: 'p2' },
    )
    // Clicking active planner while healing switches nothing for target; sets active (same id)
    assert.deepEqual(
      partyClickEffect({ member: { id: 'p1', alive: true }, activeId: 'p1', activeAction: healAction }),
      { type: 'setActive', activeId: 'p1' },
    )

    const rezAction = { needsAllyTarget: true, needsDeadAlly: true }
    assert.deepEqual(
      partyClickEffect({ member: { id: 'p3', alive: false }, activeId: 'p1', activeAction: rezAction }),
      { type: 'setTarget', targetId: 'p3' },
    )
    assert.deepEqual(
      partyClickEffect({ member: { id: 'p2', alive: true }, activeId: 'p1', activeAction: rezAction }),
      { type: 'noop' },
    )

    assert.deepEqual(
      partyClickEffect({ member: { id: 'p2', alive: false }, activeId: 'p1', activeAction: null }),
      { type: 'noop' },
    )
  })

  it('diffFlashClasses maps HP deltas to flash classes', () => {
    const prev = [
      { id: 'a', hp: 100 },
      { id: 'b', hp: 50 },
      { id: 'c', hp: 80 },
    ]
    const next = [
      { id: 'a', hp: 70 },
      { id: 'b', hp: 65 },
      { id: 'c', hp: 80 },
    ]
    assert.deepEqual(diffFlashClasses(prev, next), {
      a: 'is-flash-dmg',
      b: 'is-flash-heal',
    })
    assert.deepEqual(diffFlashClasses(null, next), {})
  })

  it('detects log header lines', () => {
    assert.equal(isLogHeaderLine('— The Entrance Guards —'), true)
    assert.equal(isLogHeaderLine('Warrior0 hits Guard'), false)
  })

  it('disabled / non-targetable when action does not need enemy', () => {
    const s = deriveEnemyCardState({
      enemy: { id: 'e1', alive: true },
      draftTargetId: 'e1',
      activeAction: { needsEnemyTarget: false },
    })
    assert.equal(s.isTargetable, false)
    assert.equal(s.isTargeted, false)
  })

  it('derives portrait status flags including multi-status, casting, and KO', () => {
    const flags = derivePortraitStatusFlags({
      alive: true,
      casting: { abilityName: 'Heal' },
      statuses: [
        { id: 'poison', remaining: 2 },
        { id: 'stun', remaining: 1 },
        { id: 'shield', remaining: 3 },
        { id: 'haste', remaining: 2 },
        { id: 'hot', remaining: 2 },
      ],
    })
    assert.ok(flags.includes('is-casting'))
    assert.ok(flags.includes('has-sick'))
    assert.ok(flags.includes('has-stun'))
    assert.ok(flags.includes('has-shield'))
    assert.ok(flags.includes('has-haste'))
    assert.ok(flags.includes('has-regen'))
    assert.equal(flags.includes('is-down'), false)

    const ko = derivePortraitStatusFlags({ alive: false, statuses: [{ id: 'poison', remaining: 1 }] })
    assert.ok(ko.includes('is-down'))
    assert.ok(ko.includes('has-sick'))

    const expired = derivePortraitStatusFlags({
      alive: true,
      statuses: [{ id: 'stun', remaining: 0 }],
    })
    assert.equal(expired.includes('has-stun'), false)

    assert.deepEqual(derivePortraitStatusFlags(null), [])
  })

  it('maps status markers and remaining durations', () => {
    assert.equal(statusMarker('stun'), '★')
    assert.equal(statusMarker({ id: 'hot' }), '+')
    assert.equal(statusRemaining({ id: 'poison', remaining: 3 }), 3)
    assert.equal(statusRemaining('poison'), null)
  })

  it('isDraftReady when every living member has an action', () => {
    const state = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 5 })
    const draft = buildDefaultDraft(state)
    assert.equal(isDraftReady(state, draft), true)

    const incomplete = { ...draft }
    delete incomplete[state.party[0].id]
    assert.equal(isDraftReady(state, incomplete), false)

    const withDead = {
      party: [
        { id: 'a', alive: true },
        { id: 'b', alive: false },
      ],
    }
    assert.equal(isDraftReady(withDead, { a: { actionId: 'basic_attack' } }), true)
    assert.equal(isDraftReady({ party: [] }, {}), false)
  })
})
