// Keep in sync with public.siteadmin_delete_user in docs/supabase-schema-full.sql.

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase()
}

/**
 * Why this actor cannot remove this profile, or '' when removal is allowed.
 * Officers may remove players. Site admins may remove players and officers.
 * Nobody may remove a site admin or themselves.
 */
export function removalBlockReason(actor, target) {
  if (!actor?.id || !target?.id) return ''
  if (String(actor.id).toLowerCase() === String(target.id).toLowerCase()) {
    return 'You cannot remove yourself'
  }
  const actorRole = normalizeRole(actor.role)
  const targetRole = normalizeRole(target.role) || 'player'
  if (actorRole !== 'officer' && actorRole !== 'siteadmin') {
    return 'Only officers and site admins can remove a user'
  }
  if (targetRole === 'siteadmin') return 'Site admins cannot be removed'
  if (actorRole === 'officer' && targetRole !== 'player') {
    return 'Officers cannot remove other officers'
  }
  if (targetRole !== 'player' && targetRole !== 'officer') {
    return 'This user cannot be removed'
  }
  return ''
}

export function canRemoveSiteUser(actor, target) {
  if (!actor?.id || !target?.id) return false
  return removalBlockReason(actor, target) === ''
}
