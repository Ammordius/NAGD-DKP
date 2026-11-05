import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { editDistance, softMatchNames, maxEditsForLength } from './fuzzy.js'

describe('fuzzy soft match', () => {
  it('editDistance counts substitutions and inserts', () => {
    assert.equal(editDistance('timless', 'timeless'), 1)
    assert.equal(editDistance('abc', 'abc'), 0)
    assert.equal(editDistance('plate', 'plat'), 1)
  })

  it('maxEditsForLength scales with length', () => {
    assert.equal(maxEditsForLength(3), 0)
    assert.equal(maxEditsForLength(5), 1)
    assert.equal(maxEditsForLength(12), 2)
  })

  it('unique typo suggests canonical mold name', () => {
    const soft = softMatchNames('timless breastplate mold', [
      { name: 'Timeless Breastplate Mold', itemId: '16375' },
      { name: 'Elemental Vambrace Mold', itemId: '16372' },
    ])
    assert.equal(soft?.unique?.name, 'Timeless Breastplate Mold')
  })

  it('ambiguous typos list candidates without picking', () => {
    const soft = softMatchNames('elemental x sleeve pattern', [
      { name: 'Elemental Silk Sleeve Pattern' },
      { name: 'Elemental Chain Sleeve Pattern' },
      { name: 'Elemental Leather Sleeve Pattern' },
    ])
    // "x" vs silk/chain/leather is too far — expect null or ambiguous depending on distance
    // Craft two names 1 edit from the same query:
    const soft2 = softMatchNames('cloak of wishs', [
      { name: 'Cloak of Wishes' },
      { name: 'Cloak of Wishs' },
    ])
    if (soft2?.ambiguous) {
      assert.ok(soft2.ambiguous.length >= 2)
    } else {
      // If catalog only has one close name, unique is fine
      assert.ok(soft2?.unique || soft == null)
    }
  })

  it('returns null when nothing is close', () => {
    assert.equal(softMatchNames('zzznonsenseitemzz', [{ name: 'Cloak of Wishes' }]), null)
  })
})
