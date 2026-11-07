import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENEMY_SYMBOLS,
  isBossSprite,
  normalizeClassSpriteName,
  resolveClassSprite,
  resolveEnemyFallbackSymbol,
  resolveEnemySprite,
} from './assets.js'

describe('expedition assets', () => {
  it('maps known enemy ids to local public sprite paths', () => {
    assert.equal(resolveEnemySprite({ id: 'guard_a' }), '/expedition/assets/plane-guard.png')
    assert.equal(resolveEnemySprite({ id: 'guard_b' }), '/expedition/assets/plane-guard.png')
    assert.equal(resolveEnemySprite({ id: 'trash_1' }), '/expedition/assets/air-wisp.png')
    assert.equal(resolveEnemySprite({ id: 'trash_2' }), '/expedition/assets/earth-clod.png')
    assert.equal(resolveEnemySprite({ id: 'trash_3' }), '/expedition/assets/fire-spark.png')
    assert.equal(resolveEnemySprite({ id: 'mini' }), '/expedition/assets/overconfident-lieutenant.png')
    assert.equal(resolveEnemySprite({ id: 'loot_boss' }), '/expedition/assets/loot-officer.png')
    assert.equal(resolveEnemySprite({ id: 'loot_support' }), '/expedition/assets/junior-auditor.png')
    assert.equal(resolveEnemySprite({ id: 'prep_a' }), '/expedition/assets/attrition-elemental.png')
    assert.equal(resolveEnemySprite({ id: 'prep_b' }), '/expedition/assets/resource-leech.png')
    assert.equal(resolveEnemySprite({ id: 'quarm' }), '/expedition/assets/quarm.png')
  })

  it('returns null for unknown enemies', () => {
    assert.equal(resolveEnemySprite({ id: 'not_a_real_enemy' }), null)
    assert.equal(resolveEnemySprite(null), null)
  })

  it('preserves encounter emoji fallbacks', () => {
    assert.equal(resolveEnemyFallbackSymbol({ id: 'mini' }, 'mini_boss'), ENEMY_SYMBOLS.mini_boss)
    assert.equal(resolveEnemyFallbackSymbol({ id: 'loot_boss' }, 'loot_officer'), ENEMY_SYMBOLS.loot_officer)
    assert.equal(resolveEnemyFallbackSymbol({ id: 'unknown' }, null), '⚔')
  })

  it('flags Quarm as the larger boss sprite', () => {
    assert.equal(isBossSprite({ id: 'quarm' }), true)
    assert.equal(isBossSprite({ id: 'guard_a' }), false)
  })

  it('maps all 15 classes to local class sprite paths', () => {
    const expected = {
      Warrior: '/expedition/assets/classes/warrior.png',
      Paladin: '/expedition/assets/classes/paladin.png',
      'Shadow Knight': '/expedition/assets/classes/shadow-knight.png',
      Cleric: '/expedition/assets/classes/cleric.png',
      Druid: '/expedition/assets/classes/druid.png',
      Shaman: '/expedition/assets/classes/shaman.png',
      Enchanter: '/expedition/assets/classes/enchanter.png',
      Bard: '/expedition/assets/classes/bard.png',
      Wizard: '/expedition/assets/classes/wizard.png',
      Magician: '/expedition/assets/classes/magician.png',
      Necromancer: '/expedition/assets/classes/necromancer.png',
      Ranger: '/expedition/assets/classes/ranger.png',
      Rogue: '/expedition/assets/classes/rogue.png',
      Monk: '/expedition/assets/classes/monk.png',
      Beastlord: '/expedition/assets/classes/beastlord.png',
    }
    for (const [name, path] of Object.entries(expected)) {
      assert.equal(resolveClassSprite(name), path)
      assert.equal(resolveClassSprite({ class_name: name }), path)
      assert.equal(resolveClassSprite(name.toLowerCase()), path)
      assert.equal(normalizeClassSpriteName(name), name)
    }
    assert.equal(Object.keys(expected).length, 15)
  })

  it('returns null for unknown or missing classes', () => {
    assert.equal(resolveClassSprite('Not A Class'), null)
    assert.equal(resolveClassSprite({ class_name: 'Berserker' }), null)
    assert.equal(resolveClassSprite(null), null)
    assert.equal(resolveClassSprite(''), null)
    assert.equal(normalizeClassSpriteName('  '), null)
  })
})
