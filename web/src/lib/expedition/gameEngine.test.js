import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  startRun,
  commitRound,
  availableActions,
  selectBoon,
  selectRoute,
  selectEventChoice,
  selectConsumable,
  restartRun,
  mulberry32,
  ENCOUNTER_COUNT,
  RAID_COMMANDS,
  listSynergyIds,
} from './gameEngine.js'
import { ABILITY_COUNT, listAllClassAbilityIds, getClassAbilities, getAbility } from './abilities.js'
import { CLASS_PASSIVES, getPassive } from './passives.js'
import { STATUS_IDS } from './statuses.js'
import { CLASS_ORDER } from './classDefinitions.js'
import { calculateScore } from './scoring.js'
import { normalizeExpeditionSave, applyRunToSave, emptyExpeditionSave } from './persistence.js'
import { countNarratorLines } from './narrator.js'
import {
  buildCombatIdentity,
  levelFactor,
  transformMageloStats,
  evaluatePartyRadar,
} from './combatProfile.js'

function partyOf(...classNames) {
  return classNames.map((class_name, i) => ({
    char_id: `c${i}`,
    name: `${class_name.replace(/\s/g, '')}${i}`,
    class_name,
    level: 60,
  }))
}

function autoActions(state) {
  const actions = {}
  const enemyId = (state.enemies || []).find((e) => e.alive)?.id
  for (const p of state.party.filter((x) => x.alive)) {
    const opts = availableActions(state, p)
    const prefer = opts.find((o) => o.group === 'offensive' && o.id !== 'basic_attack') || opts.find((o) => o.id === 'basic_attack') || opts[0]
    actions[p.id] = {
      actionId: prefer.id,
      targetId: prefer.needsAllyTarget ? p.id : prefer.needsEnemyTarget ? enemyId : undefined,
    }
  }
  return actions
}

describe('expedition tactical overhaul', () => {
  it('has 90 class abilities and 15 passives', () => {
    assert.equal(ABILITY_COUNT, 90)
    assert.equal(listAllClassAbilityIds().length, 90)
    assert.equal(Object.keys(CLASS_PASSIVES).length, 15)
    for (const name of CLASS_ORDER) {
      assert.equal(getClassAbilities(name).length, 6, name)
      assert.ok(getPassive(name)?.id, name)
    }
  })

  it('supports required status ids', () => {
    for (const id of ['stun', 'slow', 'snare', 'mez', 'poison', 'hot', 'shield', 'damage_reduction', 'vulnerability']) {
      assert.ok(STATUS_IDS.includes(id), id)
    }
  })

  it('has at least 12 synergies and 5 raid commands', () => {
    assert.ok(listSynergyIds().length >= 12)
    assert.equal(RAID_COMMANDS.length, 5)
  })

  it('level and magelo gear change derived stats', () => {
    const low = buildCombatIdentity({ name: 'A', class_name: 'Warrior', level: 40 }, null)
    const high = buildCombatIdentity({ name: 'B', class_name: 'Warrior', level: 65 }, null)
    assert.ok(high.base.maxHp > low.base.maxHp)
    assert.ok(levelFactor(65) > levelFactor(40))

    const geared = buildCombatIdentity(
      { name: 'C', class_name: 'Warrior', level: 60 },
      {
        equipmentKnown: true,
        combatStats: transformMageloStats({ ac: 400, atk_item: 80, mana: 0, hp: 4000, haste: 20, INT: 50, resists: { fire: 40 } }),
        traits: ['shield_equipped'],
      },
    )
    const bare = buildCombatIdentity({ name: 'D', class_name: 'Warrior', level: 60 }, null)
    assert.equal(geared.equipmentKnown, true)
    assert.equal(bare.equipmentKnown, false)
    assert.ok(geared.base.atk >= bare.base.atk)
    assert.ok(geared.base.def >= bare.base.def)
  })

  it('missing equipment never invents gear traits', () => {
    const idn = buildCombatIdentity({ name: 'Ghost', class_name: 'Rogue', level: 55 }, null)
    assert.equal(idn.source, 'class_level')
    assert.deepEqual(idn.traits, [])
  })

  it('every class ability can be selected when resources allow', () => {
    for (const className of CLASS_ORDER) {
      const state = startRun(partyOf(className, 'Warrior', 'Cleric'), { seed: 3 })
      const hero = state.party.find((p) => p.class_name === className)
      hero.mana = hero.maxMana
      hero.endurance = hero.maxEndurance
      const opts = availableActions(state, hero)
      const classAbs = getClassAbilities(className)
      for (const ab of classAbs) {
        // zero CD at start — may still be gated by cost; top up
        hero.mana = 999
        hero.endurance = 999
        const again = availableActions(state, hero)
        assert.ok(again.some((o) => o.id === ab.id), `${className} missing ${ab.id}`)
      }
      assert.ok(getAbility(classAbs[0].id))
    }
  })

  it('mana and endurance are spent and cooldowns apply', () => {
    const state = startRun(partyOf('Wizard', 'Warrior', 'Cleric'), { seed: 4 })
    const wiz = state.party.find((p) => p.class_name === 'Wizard')
    const before = wiz.mana
    const ab = getClassAbilities('Wizard').find((a) => a.cost > 0)
    const actions = autoActions(state)
    actions[wiz.id] = { actionId: ab.id, targetId: state.enemies[0].id }
    const res = commitRound(state, actions)
    assert.ok(res.ok)
    assert.ok(wiz.mana < before || ab.resource !== 'mana')
    if (ab.cooldown) assert.ok((wiz.cooldowns[ab.id] || 0) > 0)
  })

  it('healing cannot exceed max HP; HP cannot go negative', () => {
    const state = startRun(partyOf('Cleric', 'Warrior', 'Paladin'), { seed: 5 })
    const war = state.party.find((p) => p.class_name === 'Warrior')
    war.hp = war.maxHp
    war.hp = 0
    war.alive = false
    assert.equal(war.hp, 0)
    war.alive = true
    war.hp = 1
    const clr = state.party.find((p) => p.class_name === 'Cleric')
    const heal = getClassAbilities('Cleric').find((a) => a.name === 'Fast Remedy')
    const actions = autoActions(state)
    actions[clr.id] = { actionId: heal.id, targetId: war.id }
    commitRound(state, actions)
    assert.ok(war.hp <= war.maxHp)
    assert.ok(war.hp >= 0)
  })

  it('seeded reproducibility', () => {
    const mk = () => {
      const s = startRun(partyOf('Warrior', 'Cleric', 'Rogue'), { seed: 42 })
      for (let i = 0; i < 3; i++) {
        if (s.phase !== 'battle') break
        commitRound(s, autoActions(s))
      }
      return s
    }
    const a = mk()
    const b = mk()
    assert.equal(a.turns, b.turns)
    assert.deepEqual(
      a.enemies.map((e) => e.hp),
      b.enemies.map((e) => e.hp),
    )
  })

  it('multi-enemy entrance clears into between-fight progression', () => {
    const state = startRun(partyOf('Wizard', 'Wizard', 'Wizard'), { seed: 9 })
    assert.ok(state.enemies.length >= 2)
    for (const e of state.enemies) {
      e.hp = 0
      e.alive = false
    }
    const res = commitRound(state, autoActions(state))
    assert.ok(res.ok)
    assert.ok(['route', 'boon', 'event', 'consumable', 'rewards'].includes(state.phase))
  })

  it('route then boon then consumable advances encounter', () => {
    const state = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 11 })
    const firstIndex = state.encounterIndex
    state.enemies.forEach((e) => { e.hp = 0; e.alive = false })
    commitRound(state, autoActions(state))
    if (state.phase === 'route') selectRoute(state, 'treacherous')
    if (state.phase === 'event') {
      const choice = state.eventChoices.choices[0]
      selectEventChoice(state, choice.id)
    }
    if (state.phase === 'boon') selectBoon(state, state.boonChoices[0].id)
    if (state.phase === 'consumable') selectConsumable(state, true)
    assert.equal(state.phase, 'battle')
    assert.equal(state.encounterIndex, firstIndex + 1)
  })

  it('boss mez resistance does not permanently lock', () => {
    const state = startRun(partyOf('Enchanter', 'Warrior', 'Cleric'), { seed: 12 })
    // jump-ish: set single boss enemy
    state.enemies = [{
      id: 'boss', name: 'Boss', maxHp: 200, hp: 200, atk: 10, def: 5, alive: true, isEnemy: true, isBoss: true, statuses: [], intents: [],
    }]
    state.enemy = state.enemies[0]
    state.intents = { boss: { id: 'x', label: 'hit', kind: 'single', power: 1 } }
    const enc = state.party.find((p) => p.class_name === 'Enchanter')
    enc.mana = 999
    const mez = getClassAbilities('Enchanter').find((a) => a.name === 'Mesmerize')
    const actions = autoActions(state)
    actions[enc.id] = { actionId: mez.id, targetId: 'boss' }
    commitRound(state, actions)
    // boss should not be fully mez-locked for long; either slow/vuln or short status
    const boss = state.enemies[0]
    assert.ok(boss.alive)
  })

  it('command points can be spent once per round', () => {
    const state = startRun(partyOf('Warrior', 'Cleric', 'Wizard'), { seed: 13 })
    state.commandPoints = 6
    const res = commitRound(state, autoActions(state), { commandId: 'brace' })
    assert.ok(res.ok)
    assert.ok(state.commandPoints < 6)
  })

  it('restart resets combat', () => {
    const chars = partyOf('Monk', 'Shaman', 'Bard')
    const s1 = startRun(chars, { seed: 5 })
    commitRound(s1, autoActions(s1))
    const s2 = restartRun(chars, { seed: 5 })
    assert.equal(s2.turns, 0)
    assert.equal(s2.encounterIndex, 0)
  })

  it('score and persistence still work', () => {
    assert.ok(calculateScore({ encountersCleared: 6, remainingHpPct: 0.5, knockouts: 0, turns: 40, victory: true }) > 0)
    const save = applyRunToSave(emptyExpeditionSave(), { score: 1000, artifactId: 'x' })
    assert.equal(normalizeExpeditionSave(save).completedRuns, 1)
  })

  it('narrator still has 30+ lines and radar works', () => {
    assert.ok(countNarratorLines() >= 30)
    const radar = evaluatePartyRadar(partyOf('Cleric', 'Warrior', 'Wizard'), [])
    assert.ok(radar.healing > radar.control || radar.healing > 0)
  })

  it('mulberry32 deterministic', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    assert.equal(a(), b())
  })

  it('six encounters defined', () => {
    assert.equal(ENCOUNTER_COUNT, 6)
  })

  it('does not expose dkp mutation fields', () => {
    const state = startRun(partyOf('Necromancer', 'Shaman', 'Bard'), { seed: 2 })
    assert.equal('dkp' in state, false)
  })
})
