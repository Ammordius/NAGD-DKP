import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canRemoveSiteUser, removalBlockReason } from './siteAdminRemoveUser.js'

const player = { id: '11111111-1111-1111-1111-111111111111', role: 'player' }
const player2 = { id: '22222222-2222-2222-2222-222222222222', role: 'player' }
const officer = { id: '33333333-3333-3333-3333-333333333333', role: 'officer' }
const officer2 = { id: '44444444-4444-4444-4444-444444444444', role: 'officer' }
const admin = { id: '55555555-5555-5555-5555-555555555555', role: 'siteadmin' }
const admin2 = { id: '66666666-6666-6666-6666-666666666666', role: 'siteadmin' }

describe('canRemoveSiteUser', () => {
  it('lets an officer remove a player', () => {
    assert.equal(canRemoveSiteUser(officer, player), true)
    assert.equal(removalBlockReason(officer, player), '')
  })

  it('lets a site admin remove a player or an officer', () => {
    assert.equal(canRemoveSiteUser(admin, player), true)
    assert.equal(canRemoveSiteUser(admin, officer), true)
  })

  it('does not let an officer remove another officer or a site admin', () => {
    assert.equal(canRemoveSiteUser(officer, officer2), false)
    assert.equal(removalBlockReason(officer, officer2), 'Officers cannot remove other officers')
    assert.equal(canRemoveSiteUser(officer, admin), false)
    assert.equal(removalBlockReason(officer, admin), 'Site admins cannot be removed')
  })

  it('does not let a site admin remove another site admin', () => {
    assert.equal(canRemoveSiteUser(admin, admin2), false)
    assert.equal(removalBlockReason(admin, admin2), 'Site admins cannot be removed')
  })

  it('does not let anyone remove themselves', () => {
    assert.equal(canRemoveSiteUser(player, player), false)
    assert.equal(canRemoveSiteUser(officer, { ...officer }), false)
    assert.equal(canRemoveSiteUser(admin, { id: admin.id.toUpperCase(), role: 'siteadmin' }), false)
    assert.equal(removalBlockReason(admin, admin), 'You cannot remove yourself')
  })

  it('does not let a player remove anyone', () => {
    assert.equal(canRemoveSiteUser(player, player2), false)
    assert.equal(removalBlockReason(player, player2), 'Only officers and site admins can remove a user')
  })

  it('treats a blank target role as a player', () => {
    assert.equal(canRemoveSiteUser(officer, { id: player.id, role: '' }), true)
    assert.equal(canRemoveSiteUser(officer, { id: player.id }), true)
  })

  it('does not treat a missing profile id as allowed', () => {
    assert.equal(canRemoveSiteUser(admin, { role: 'player' }), false)
    assert.equal(removalBlockReason(admin, { role: 'player' }), 'Profile is required')
    assert.equal(removalBlockReason({ role: 'siteadmin' }, player), 'Profile is required')
  })
})
