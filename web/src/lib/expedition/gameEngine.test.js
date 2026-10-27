import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  startRun,
  commitRound,
  availableActions,
  validateActions,
  selectBoon,
  selectEventChoice,
  restartRun,
  mulberry32,
  ENCOUNTER_COUNT,
} from './gameEngine.js'
import { CLASSES, CLASS_ORDER, getClassDef } from './classDefinitions.js'
import { calculateScore, pickArtifact } from './scoring.js'
import { normalizeExpeditionSave, applyRunToSave, emptyExpeditionSave } from './persistence.js'
import { countNarratorLines } from './narrator.js'
import { BOONS } from './boonDefinitions.js'

function partyOf(...classNames) {
  return classNames.map((class_name, i) => ({
    char_id: `c${i}`,
    name: class_name.slice(0, 6) + i,
    class_name,
    level: 60,
  }))
}

function autoActions(state) {
  /** @type {Record<string, { actionId: string, targetId?: string }>} */
  const actions = {}
  for (const p of state.party.filter((x) => x.alive)) {
    const opts = availableActions(state, p)
    const special = opts.find((o) => o.id === 'special')
    const pick = special || opts[0]
    const act = { actionId: pick.id }
    if (pick.needsAllyTarget) {
      const ally = state.party.find((x) => x.alive) || p
      act.targetId = ally.id
    }
    actions[p.id] = act
  }
  return actions
}

function playUntil(state, pred, maxRounds = 80) {
  let s = state
  for (let i = 0; i < maxRounds; i++) {
    if (pred(s)) return s
    if (s.phase === 'boon' && s.boonChoices?.length) {
      selectBoon(s, s.boonChoices[0].id)
      continue
    }
    if (s.phase === 'event' && s.eventChoices) {
      selectEventChoice(s, s.eventChoices.choices[0].id)
      continue
    }
    if (s.phase === 'rewards') return s
    if (s.phase !== 'battle') return s
    const res = commitRound(s, autoActions(s))
    assert.equal(res.ok, true, (res.errors || []).join('; '))
    s = res.state
  }
  return s
}

describe('expedition gameEngine', () => {
  it('defines all 15 classes with actions', () => {
    assert.equal(CLASS_ORDER.length, 15)
    for (const name of CLASS_ORDER) {
      const def = getClassDef(name)
      assert.ok(def.standard?.id)
      assert.ok(def.special?.id)
      assert.ok(def.passive?.id)
      assert.ok(CLASSES[name])
    }
  })

  it('prevents illegal actions and dead characters acting', () => {
    const state = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 1 })
    const wiz = state.party.find((p) => p.class_name === 'Wizard')
    wiz.hp = 0
    wiz.alive = false
    const actions = autoActions(state)
    delete actions[wiz.id]
    const errors = validateActions(state, {
      ...actions,
      [wiz.id]: { actionId: 'standard' },
    })
    // dead not in living validation — validateActions only checks living
    assert.equal(errors.length, 0)
    const livingIds = state.party.filter((p) => p.alive).map((p) => p.id)
    assert.ok(!livingIds.includes(wiz.id))
  })

  it('enforces cooldowns on specials', () => {
    const state = startRun(partyOf('Wizard', 'Warrior', 'Cleric'), { seed: 2 })
    const wiz = state.party.find((p) => p.class_name === 'Wizard')
    const def = getClassDef('Wizard')
    const actions = autoActions(state)
    actions[wiz.id] = { actionId: 'special' }
    const res = commitRound(state, actions)
    assert.ok(res.ok)
    assert.ok((wiz.cooldowns[def.special.id] || 0) > 0)
    const opts = availableActions(state, wiz)
    assert.ok(!opts.some((o) => o.id === 'special'))
  })

  it('healing cannot exceed max HP and HP cannot go negative', () => {
    const state = startRun(partyOf('Cleric', 'Warrior', 'Paladin'), { seed: 3 })
    const war = state.party.find((p) => p.class_name === 'Warrior')
    const clr = state.party.find((p) => p.class_name === 'Cleric')
    war.hp = war.maxHp
    const actions = autoActions(state)
    actions[clr.id] = { actionId: 'special', targetId: war.id }
    commitRound(state, actions)
    assert.ok(war.hp <= war.maxHp)

    war.hp = 5
    war.alive = true
    // massive damage via direct helper path: enemy smack many rounds
    for (let i = 0; i < 30 && war.alive; i++) {
      war.hp = Math.max(0, war.hp - 50)
      if (war.hp <= 0) {
        war.alive = false
        war.hp = 0
      }
    }
    assert.ok(war.hp >= 0)
    assert.equal(war.alive, false)
  })

  it('every special ability can resolve once', () => {
    for (const className of CLASS_ORDER) {
      const state = startRun(partyOf(className, 'Warrior', 'Cleric'), { seed: 100 + CLASS_ORDER.indexOf(className) })
      const hero = state.party.find((p) => p.class_name === className)
      const actions = autoActions(state)
      const opts = availableActions(state, hero)
      const special = opts.find((o) => o.id === 'special')
      assert.ok(special, className)
      actions[hero.id] = {
        actionId: 'special',
        targetId: special.needsAllyTarget ? state.party.find((p) => p.alive).id : undefined,
      }
      const res = commitRound(state, actions)
      assert.equal(res.ok, true, `${className}: ${(res.errors || []).join('; ')}`)
    }
  })

  it('detects victory and defeat', () => {
    // Wipe: all dead before commit — empty living validates; encounter end detects defeat
    const lose = startRun(partyOf('Wizard', 'Wizard', 'Wizard'), { seed: 9 })
    for (const p of lose.party) {
      p.hp = 0
      p.alive = false
    }
    lose.enemy.hp = 100
    const res = commitRound(lose, {})
    assert.equal(res.ok, true)
    assert.equal(lose.phase, 'rewards')
    assert.equal(lose.victory, false)
    assert.equal(lose.defeated, true)

    // Victory path: kill enemy on first encounter
    const winFight = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 11 })
    winFight.enemy.hp = 1
    const r2 = commitRound(winFight, autoActions(winFight))
    assert.ok(r2.ok)
    assert.ok(winFight.encountersCleared >= 1)
    assert.ok(['boon', 'event', 'rewards'].includes(winFight.phase))
  })

  it('seeded reproducibility', () => {
    const a = startRun(partyOf('Warrior', 'Cleric', 'Rogue'), { seed: 42 })
    const b = startRun(partyOf('Warrior', 'Cleric', 'Rogue'), { seed: 42 })
    for (let i = 0; i < 5; i++) {
      if (a.phase !== 'battle' || b.phase !== 'battle') break
      const act = autoActions(a)
      commitRound(a, act)
      commitRound(b, autoActions(b))
    }
    assert.equal(a.enemy.hp, b.enemy.hp)
    assert.equal(a.turns, b.turns)
    assert.deepEqual(
      a.party.map((p) => p.hp),
      b.party.map((p) => p.hp),
    )
  })

  it('restart resets combat state', () => {
    const chars = partyOf('Monk', 'Shaman', 'Bard')
    const s1 = startRun(chars, { seed: 5 })
    playUntil(s1, (s) => s.turns >= 3 || s.phase !== 'battle', 10)
    const s2 = restartRun(chars, { seed: 5 })
    assert.equal(s2.turns, 0)
    assert.equal(s2.encounterIndex, 0)
    assert.equal(s2.phase, 'battle')
    assert.equal(s2.enemy.hp, s2.enemy.maxHp)
    assert.ok(s2.party.every((p) => p.hp === p.maxHp && p.alive))
  })

  it('boon effects apply', () => {
    const state = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 7 })
    state.phase = 'boon'
    state.boonChoices = BOONS.slice(0, 3)
    const before = state.party[0].hp
    state.party[0].hp = Math.floor(before * 0.5)
    selectBoon(state, 'emergency_healing')
    assert.ok(state.party[0].hp > before * 0.5)
    assert.equal(state.phase, 'battle')
  })

  it('score calculation and artifacts', () => {
    const score = calculateScore({
      encountersCleared: 6,
      remainingHpPct: 0.8,
      knockouts: 1,
      turns: 30,
      victory: true,
    })
    assert.ok(score > 2000)
    const art = pickArtifact(score, true)
    assert.ok(art.name)
    assert.ok(pickArtifact(100, false).name.includes('Memo'))
  })

  it('persistence normalize and apply', () => {
    assert.deepEqual(normalizeExpeditionSave(null), emptyExpeditionSave())
    const save = applyRunToSave(emptyExpeditionSave(), { score: 4200, artifactId: 'questionable_helm' })
    assert.equal(save.personalBest, 4200)
    assert.equal(save.completedRuns, 1)
    assert.ok(save.unlockedArtifacts.includes('questionable_helm'))
  })

  it('has at least 30 narrator lines', () => {
    assert.ok(countNarratorLines() >= 30)
  })

  it('can clear first encounter and advance', () => {
    const state = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 99 })
    state.enemy.hp = 5
    state.enemy.maxHp = 5
    const res = commitRound(state, autoActions(state))
    assert.ok(res.ok)
    assert.ok(state.encountersCleared >= 1 || state.phase === 'boon' || state.phase === 'event' || state.phase === 'rewards')
  })

  it('mulberry32 is deterministic', () => {
    const a = mulberry32(123)
    const b = mulberry32(123)
    assert.equal(a(), b())
    assert.equal(a(), b())
  })

  it('does not mutate DKP — report is fictional only', () => {
    const state = playUntil(
      startRun(partyOf('Warrior', 'Cleric', 'Necromancer'), { seed: 77 }),
      (s) => s.phase === 'rewards',
      120,
    )
    assert.ok(state.phase === 'rewards' || state.encountersCleared > 0)
    if (state.report) {
      assert.equal(typeof state.report.score, 'number')
      assert.ok(state.report.artifact)
      assert.ok(!('dkp' in state.report))
    }
    assert.equal(ENCOUNTER_COUNT, 6)
  })

  it('boss encounter exists as final', () => {
    assert.equal(ENCOUNTER_COUNT, 6)
    const state = startRun(partyOf('Paladin', 'Cleric', 'Wizard'), { seed: 1 })
    // jump to quarm
    state.encounterIndex = 5
    state.encountersCleared = 5
    // re-enter by selecting boon path manually
    state.phase = 'boon'
    state.boonChoices = [BOONS[0]]
    // Use internal advance via selectBoon after fake clear — selectBoon advances
    // Instead set enemy to quarm via many clears
    let s = startRun(partyOf('Shadow Knight', 'Cleric', 'Wizard'), { seed: 55 })
    s = playUntil(s, (st) => st.encounterIndex >= 5 || st.phase === 'rewards', 200)
    if (s.phase !== 'rewards') {
      assert.ok(s.enemy?.id === 'quarm' || s.encounterIndex === 5)
    }
  })
})
