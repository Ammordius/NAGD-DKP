import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { mod2UpgradeAdjustment } from './mageloUpgradeEngine.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const mageloData = path.resolve(here, '../../../../magelo/data')
const config = JSON.parse(fs.readFileSync(path.join(mageloData, 'mod2_config.json'), 'utf8'))
const table = JSON.parse(fs.readFileSync(path.join(mageloData, 'item_mod2.json'), 'utf8'))

const equipped = [{ slot_id: 18, item_id: 1, item_name: 'Plain Legs' }]

test('mod2 flag off leaves the upgrade delta at zero', () => {
  const delta = mod2UpgradeAdjustment('Warrior', equipped, 18, 28650, false, {
    mod2: false,
    mod2Config: config,
    mod2Table: table,
  })
  assert.equal(delta, 0)
})

test('mod2 flag on scores a shielding replacement independently of dkp', () => {
  const ctx = { mod2: true, mod2Config: config, mod2Table: table }
  const up = mod2UpgradeAdjustment('Warrior', equipped, 18, 28650, false, ctx)
  const down = mod2UpgradeAdjustment('Warrior', [{ slot_id: 18, item_id: 28650 }], 18, 1, false, ctx)
  assert.ok(up > 0)
  assert.ok(down < 0)
})
