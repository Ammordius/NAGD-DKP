/**
 * Presentational battle UI helpers for Expedition.
 * Pure functions only — no engine mutation.
 */

import { availableActions } from './gameEngine.js'
import { getEncounter } from './encounterDefinitions.js'
import { STATUS_DEFS } from './statuses.js'
import { smartAllyTarget, smartEnemyTarget } from './targeting.js'

/**
 * @param {{ encounterIndex?: number }|null|undefined} state
 * @returns {string|null}
 */
export function getEncounterId(state) {
  if (state?.encounterIndex == null) return null
  return getEncounter(state.encounterIndex)?.id || null
}

/**
 * @param {{ id?: string }|string|null|undefined} status
 * @returns {string}
 */
export function statusLabel(status) {
  const id = typeof status === 'string' ? status : status?.id
  if (!id) return ''
  return STATUS_DEFS[id]?.name || id
}

/**
 * @param {{ id?: string }|string|null|undefined} status
 * @returns {string}
 */
export function statusCategory(status) {
  const id = typeof status === 'string' ? status : status?.id
  if (!id) return 'unknown'
  return STATUS_DEFS[id]?.category || 'unknown'
}

/** Short non-color markers for status chips (accessible labels stay on the chip). */
const STATUS_MARKERS = {
  poison: '●',
  disease: '●',
  stun: '★',
  mez: '◈',
  shield: '◇',
  haste: '»',
  slow: '«',
  snare: '«',
  fear: '!',
  silence: '⊘',
  hot: '+',
}

/**
 * @param {{ id?: string }|string|null|undefined} status
 * @returns {string}
 */
export function statusMarker(status) {
  const id = typeof status === 'string' ? status : status?.id
  if (!id) return '•'
  return STATUS_MARKERS[id] || '•'
}

/**
 * @param {{ remaining?: number }|string|null|undefined} status
 * @returns {number|null}
 */
export function statusRemaining(status) {
  if (!status || typeof status === 'string') return null
  return typeof status.remaining === 'number' ? status.remaining : null
}

/**
 * CSS modifier flags for class/enemy portrait overlays from live battle state.
 * Pure presentation — no timers or engine mutation.
 *
 * @param {{ alive?: boolean, casting?: unknown, statuses?: Array<{ id?: string, remaining?: number }> }|null|undefined} unit
 * @returns {string[]}
 */
export function derivePortraitStatusFlags(unit) {
  /** @type {string[]} */
  const flags = []
  if (!unit) return flags
  if (unit.alive === false) flags.push('is-down')
  if (unit.casting) flags.push('is-casting')

  const active = (unit.statuses || []).filter(
    (s) => s?.id && (typeof s.remaining !== 'number' || s.remaining > 0),
  )
  const ids = new Set(active.map((s) => s.id))

  if (ids.has('poison') || ids.has('disease')) flags.push('has-sick')
  if (ids.has('stun')) flags.push('has-stun')
  if (ids.has('mez')) flags.push('has-mez')
  if (ids.has('shield')) flags.push('has-shield')
  if (ids.has('haste')) flags.push('has-haste')
  if (ids.has('slow') || ids.has('snare')) flags.push('has-slow')
  if (ids.has('fear') || ids.has('silence')) flags.push('has-warn')
  if (ids.has('hot')) flags.push('has-regen')

  return flags
}

/**
 * True when every living party member has an action assigned in the draft.
 * @param {{ party?: Array<{ id: string, alive?: boolean }> }|null|undefined} state
 * @param {Record<string, { actionId?: string }>|null|undefined} draft
 * @returns {boolean}
 */
export function isDraftReady(state, draft) {
  const living = (state?.party || []).filter((p) => p.alive)
  if (!living.length) return false
  return living.every((p) => Boolean(draft?.[p.id]?.actionId))
}

/**
 * Default draft entry for one living party member (mirrors BattleScreen initialDraft).
 * @param {object} state
 * @param {object} partyMember
 * @returns {{ actionId: string, targetId?: string }|null}
 */
export function defaultDraftEntry(state, partyMember) {
  if (!partyMember?.alive) return null
  const opts = availableActions(state, partyMember)
  const first = opts.find((o) => o.id === 'basic_attack') || opts[0]
  if (!first) return null
  return {
    actionId: first.id,
    targetId: first.needsAllyTarget
      ? smartAllyTarget(state.party, partyMember.id, { dead: first.needsDeadAlly })
      : first.needsEnemyTarget
        ? smartEnemyTarget(state.enemies, undefined)
        : undefined,
  }
}

/**
 * @param {object} state
 * @returns {Record<string, { actionId: string, targetId?: string }>}
 */
export function buildDefaultDraft(state) {
  const d = {}
  for (const p of (state.party || []).filter((x) => x.alive)) {
    const entry = defaultDraftEntry(state, p)
    if (entry) d[p.id] = entry
  }
  return d
}

/**
 * @param {{ actionId?: string, targetId?: string }|null|undefined} draftEntry
 * @param {{ actionId?: string, targetId?: string }|null|undefined} defaultEntry
 * @returns {boolean}
 */
export function isDeliberateSelection(draftEntry, defaultEntry) {
  if (!draftEntry?.actionId) return false
  if (!defaultEntry?.actionId) return Boolean(draftEntry.actionId)
  if (draftEntry.actionId !== defaultEntry.actionId) return true
  const a = draftEntry.targetId || ''
  const b = defaultEntry.targetId || ''
  return a !== b
}

/**
 * @param {object} state
 * @param {string} partyId
 * @param {Record<string, { actionId?: string }>|null|undefined} draft
 * @returns {string}
 */
export function queuedActionLabel(state, partyId, draft) {
  const entry = draft?.[partyId]
  if (!entry?.actionId) return 'No action'
  const member = (state.party || []).find((p) => p.id === partyId)
  if (!member) return entry.actionId
  const match = availableActions(state, member).find(
    (o) => o.id === entry.actionId || o.abilityId === entry.actionId,
  )
  return match?.name || entry.actionId
}

/**
 * @param {{
 *   enemy: object,
 *   intent?: { label?: string, interruptible?: boolean }|null,
 *   draftTargetId?: string|null,
 *   activeAction?: { needsEnemyTarget?: boolean }|null,
 * }} args
 */
export function deriveEnemyCardState({ enemy, intent, draftTargetId, activeAction }) {
  const alive = Boolean(enemy?.alive)
  const casting = Boolean(enemy?.casting)
  const interruptible = Boolean(
    intent?.interruptible || enemy?.casting?.interruptible,
  )
  const phase = enemy?.phases ? enemy.phases[enemy.phaseIndex || 0] : null
  const isTargetable = Boolean(alive && activeAction?.needsEnemyTarget)
  const isTargeted = Boolean(
    alive && activeAction?.needsEnemyTarget && draftTargetId && draftTargetId === enemy?.id,
  )
  return {
    isDown: !alive,
    isCasting: casting,
    isInterruptible: interruptible,
    isTargetable,
    isTargeted,
    phase,
    intentLabel: intent?.label || '…',
    castName: enemy?.casting?.castName || null,
  }
}

/**
 * @param {{
 *   member: object,
 *   activeId?: string|null,
 *   draft?: Record<string, { actionId?: string, targetId?: string }>,
 *   defaultDraft?: Record<string, { actionId?: string, targetId?: string }>,
 *   activeAction?: { needsAllyTarget?: boolean, needsDeadAlly?: boolean, needsEnemyTarget?: boolean }|null,
 *   state: object,
 * }} args
 */
export function derivePartyCardState({
  member,
  activeId,
  draft,
  defaultDraft,
  activeAction,
  state,
}) {
  const alive = Boolean(member?.alive)
  const entry = draft?.[member.id]
  const defaultEntry = defaultDraft?.[member.id]
  const isAutoQueued = alive && Boolean(entry?.actionId) && !isDeliberateSelection(entry, defaultEntry)
  const isActivePlanner = activeId === member.id
  const needsDead = Boolean(activeAction?.needsDeadAlly)
  const needsAlly = Boolean(activeAction?.needsAllyTarget)
  const isTargetable = Boolean(
    needsAlly && ((needsDead && !alive) || (!needsDead && alive)),
  )
  const isTargeted = Boolean(
    needsAlly && draft?.[activeId]?.targetId === member.id,
  )
  return {
    isDown: !alive,
    isCasting: Boolean(member?.casting),
    isActivePlanner,
    isTargetable,
    isTargeted,
    isAutoQueued,
    queueLabel: alive ? queuedActionLabel(state, member.id, draft) : 'KO',
  }
}

/**
 * Decouple planner selection from targeting.
 * When the active action needs an ally/dead target and the clicked member is a valid
 * *different* target, retarget only. Otherwise switch active planner (never retarget).
 *
 * @param {{
 *   member: { id: string, alive?: boolean },
 *   activeId?: string|null,
 *   activeAction?: { needsAllyTarget?: boolean, needsDeadAlly?: boolean }|null,
 * }} args
 * @returns {{ type: 'setActive', activeId: string } | { type: 'setTarget', targetId: string } | { type: 'noop' }}
 */
export function partyClickEffect({ member, activeId, activeAction }) {
  if (!member?.id) return { type: 'noop' }

  const needsAlly = Boolean(activeAction?.needsAllyTarget)
  const needsDead = Boolean(activeAction?.needsDeadAlly)

  if (needsAlly) {
    const validTarget = needsDead ? !member.alive : Boolean(member.alive)
    if (validTarget && member.id !== activeId) {
      return { type: 'setTarget', targetId: member.id }
    }
    // Clicking the active planner (or invalid for current target mode) switches planner
    // only when the click is on a living member for planner edit — dead members stay rez-target only.
    if (!needsDead && member.alive) {
      return { type: 'setActive', activeId: member.id }
    }
    if (needsDead && !member.alive) {
      // Already active's target candidate but same id as active shouldn't happen for dead;
      // treat as setTarget to self-id of dead ally.
      return { type: 'setTarget', targetId: member.id }
    }
    return { type: 'noop' }
  }

  if (!member.alive) return { type: 'noop' }
  return { type: 'setActive', activeId: member.id }
}

/**
 * @param {Array<{ id: string, hp?: number }>|null|undefined} prevUnits
 * @param {Array<{ id: string, hp?: number }>|null|undefined} nextUnits
 * @returns {Record<string, 'is-flash-dmg'|'is-flash-heal'>}
 */
export function diffFlashClasses(prevUnits, nextUnits) {
  /** @type {Record<string, 'is-flash-dmg'|'is-flash-heal'>} */
  const out = {}
  const prevMap = new Map((prevUnits || []).map((u) => [u.id, u.hp]))
  for (const u of nextUnits || []) {
    if (!u?.id) continue
    if (!prevMap.has(u.id)) continue
    const prevHp = prevMap.get(u.id)
    if (typeof prevHp !== 'number' || typeof u.hp !== 'number') continue
    if (u.hp < prevHp) out[u.id] = 'is-flash-dmg'
    else if (u.hp > prevHp) out[u.id] = 'is-flash-heal'
  }
  return out
}

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isLogHeaderLine(line) {
  if (typeof line !== 'string') return false
  const t = line.trim()
  return t.startsWith('—') || t.startsWith('–') || t.startsWith('-')
}
