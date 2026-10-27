import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  TEMPLATES,
  TEMPLATE_BY_ID,
  extractPlaceholders,
  fillTemplate,
  KNOWN_PLACEHOLDERS,
} from './templates.js'

describe('roastBot templates', () => {
  it('registers exactly 150 templates', () => {
    assert.equal(TEMPLATES.length, 150)
  })

  it('has unique stable IDs A01–J15', () => {
    const ids = TEMPLATES.map((t) => t.id)
    assert.equal(new Set(ids).size, 150)
    const expected = []
    for (const letter of 'ABCDEFGHIJ') {
      for (let n = 1; n <= 15; n++) {
        expected.push(`${letter}${String(n).padStart(2, '0')}`)
      }
    }
    assert.deepEqual([...ids].sort(), [...expected].sort())
    for (const id of expected) {
      assert.ok(TEMPLATE_BY_ID[id], `missing ${id}`)
    }
  })

  it('declares every placeholder used and only known ones', () => {
    for (const t of TEMPLATES) {
      const used = extractPlaceholders(t.text)
      for (const p of used) {
        assert.ok(KNOWN_PLACEHOLDERS.includes(p), `${t.id} unknown placeholder {${p}}`)
        assert.ok(
          t.requiredFacts.includes(p),
          `${t.id} uses {${p}} but does not declare it in requiredFacts`,
        )
      }
      for (const req of t.requiredFacts) {
        assert.ok(used.includes(req), `${t.id} declares ${req} but text does not use it`)
      }
    }
  })

  it('never leaves unresolved placeholders after fill with complete values', () => {
    const values = Object.fromEntries(KNOWN_PLACEHOLDERS.map((k) => [k, `X_${k}`]))
    for (const t of TEMPLATES) {
      const filled = fillTemplate(t.text, values)
      assert.ok(filled, `${t.id} should fill`)
      assert.equal(filled.includes('{'), false, `${t.id} leftover brace: ${filled}`)
    }
  })

  it('returns null when a required placeholder is missing', () => {
    assert.equal(fillTemplate('You have {balance} DKP.', {}), null)
    assert.equal(fillTemplate('You have {balance} DKP.', { balance: 12 }), 'You have 12 DKP.')
  })

  it('every template includes sarcasm or mockery cues', () => {
    // Every authored line is an insult or includes an insult; reject bare neutral FAQ phrasing.
    const neutralOnly =
      /^(The item drops in .+|Your balance is \d+ DKP\.|Last sold for \d+\.?)$/i
    for (const t of TEMPLATES) {
      assert.ok(t.text.length > 40, `${t.id} too short to carry tone`)
      assert.equal(neutralOnly.test(t.text), false, `${t.id} looks purely neutral`)
      // Must not be generic positivity
      assert.doesNotMatch(t.text, /^(Great job|Well done|You're doing amazing)/i)
    }
  })

  it('exposes no personality configuration API on templates module', async () => {
    const mod = await import('./templates.js')
    assert.equal(mod.setSarcasmLevel, undefined)
    assert.equal(mod.personalitySettings, undefined)
    assert.equal(mod.ROAST_PREFERENCES, undefined)
  })
})
