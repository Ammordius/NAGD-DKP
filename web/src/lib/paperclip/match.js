/**
 * Intent-aware redirect matcher for Paperclip.
 * Entity senses + domain cues first; catalog score + fuzzy second.
 * Never answers guide substance.
 */

import { KIND, RESOURCES, getResourceById } from './catalog.js'
import {
  detectDomainCues,
  detectEntities,
  detectFlagMobMention,
  isCapabilitiesQuery,
  normalizeQuery,
  resolveEntitySenses,
} from './entities.js'
import { editDistance, maxEditsForLength } from '../roastBot/discovery/fuzzy.js'

export { normalizeQuery }

/**
 * @param {import('./catalog.js').Resource} resource
 */
export function kindPhrase(resource) {
  if (resource.kind === KIND.DOC) return 'look at this'
  if (resource.kind === KIND.POST) return 'this post'
  return 'some information'
}

/**
 * @param {import('./catalog.js').Resource} resource
 */
export function formatRedirect(resource) {
  if (resource.kind === KIND.DOC) {
    return `You wanted to know about ${resource.topicLabel}, look at this`
  }
  if (resource.kind === KIND.POST) {
    return `You asked about ${resource.topicLabel}, here is this post`
  }
  return `You asked about ${resource.topicLabel}, here is some information`
}

/**
 * @param {string} displayName
 * @param {import('./entities.js').EntitySense[]} senses
 */
export function formatDisambiguation(displayName, senses) {
  const parts = senses.map((s) => s.label)
  if (parts.length === 2) {
    return `You asked about ${displayName} — did you mean ${parts[0]}, or ${parts[1]}?`
  }
  return `You asked about ${displayName} — which did you mean?\n${parts.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
}

/**
 * Soft-match query token(s) against an alias (roastBot-style edits).
 * @param {string} query
 * @param {string} alias
 */
function fuzzyAliasBoost(query, alias) {
  const a = normalizeQuery(alias)
  if (!a || a.length < 4) return 0
  if (query.includes(a) || a.includes(query)) return 0 // exact path handles these
  const dist = editDistance(query, a)
  const max = Math.max(maxEditsForLength(query.length), maxEditsForLength(a.length))
  if (dist > 0 && dist <= max) return 70 - dist * 5

  const qTokens = query.split(' ').filter(Boolean)
  const aTokens = a.split(' ').filter(Boolean)
  if (qTokens.length === aTokens.length && qTokens.length >= 1) {
    let sum = 0
    for (let i = 0; i < qTokens.length; i++) {
      const d = editDistance(qTokens[i], aTokens[i])
      if (d > 1) return 0
      sum += d
    }
    if (sum > 0 && sum <= 2) return 65 - sum * 5
  }
  return 0
}

/**
 * @param {string} query
 * @param {string} alias
 */
function scoreAlias(query, alias) {
  const a = normalizeQuery(alias)
  if (!a || !query) return 0
  if (query === a) return 100 + a.length
  if (query.includes(a)) return 80 + a.length
  if (a.includes(query) && query.length >= 4) return 55 + query.length

  const fuzzy = fuzzyAliasBoost(query, a)
  if (fuzzy) return fuzzy

  const qTokens = query.split(' ').filter(Boolean)
  const aTokens = a.split(' ').filter(Boolean)
  if (!aTokens.length) return 0

  let hit = 0
  for (const t of aTokens) {
    if (t.length < 2) continue
    if (qTokens.includes(t) || query.includes(t)) hit += 1
  }
  if (hit === 0) return 0
  const coverage = hit / aTokens.length
  if (coverage < 0.5 && aTokens.length > 1) return 0
  return Math.round(40 * coverage + hit * 3 + a.length * 0.5)
}

/**
 * @param {string} query
 * @param {import('./catalog.js').Resource} resource
 */
export function scoreResource(query, resource) {
  const q = normalizeQuery(query)
  if (!q) return 0
  let best = 0
  for (const alias of resource.aliases || []) {
    best = Math.max(best, scoreAlias(q, alias))
  }
  best = Math.max(best, scoreAlias(q, resource.topicLabel))
  return best
}

/**
 * @param {string} message
 * @param {{ catalog?: import('./catalog.js').Resource[], limit?: number }} [opts]
 */
export function matchResources(message, opts = {}) {
  const catalog = opts.catalog || RESOURCES
  const limit = opts.limit ?? 3
  const q = normalizeQuery(message)
  if (!q || q.length < 2) {
    return { status: 'none', matches: [] }
  }

  /** @type {Array<{ resource: import('./catalog.js').Resource, score: number }>} */
  const scored = []
  for (const resource of catalog) {
    const score = scoreResource(q, resource)
    if (score >= 40) scored.push({ resource, score })
  }
  scored.sort((a, b) => b.score - a.score || a.resource.id.localeCompare(b.resource.id))

  if (!scored.length) return { status: 'none', matches: [] }

  const top = scored[0]
  const close = scored.filter((s) => s.score >= top.score - 12).slice(0, limit)

  if (close.length === 1) {
    return { status: 'match', matches: close }
  }

  const urls = new Set(close.map((c) => c.resource.url || c.resource.id))
  if (urls.size === 1 && close.every((c) => c.resource.kind === close[0].resource.kind)) {
    return { status: 'match', matches: [close[0]] }
  }

  const distinctIds = new Set(close.map((c) => c.resource.id))
  if (distinctIds.size > 1 && close[1].score >= Math.min(50, top.score - 5)) {
    return { status: 'ambiguous', matches: close.slice(0, limit) }
  }

  return { status: 'match', matches: [top] }
}

/** PoTime raiding always surfaces both the logistics post and the fight guide. */
export const POTIME_BUNDLE_IDS = ['doc-potime', 'post-potime-overview']

/**
 * @param {import('./catalog.js').Resource | null | undefined} resource
 */
function isPotimeRaidingResource(resource) {
  if (!resource) return false
  return (
    resource.domain === 'potime' ||
    resource.domain === 'potime-logistics' ||
    POTIME_BUNDLE_IDS.includes(resource.id)
  )
}

/**
 * @param {string[]} ids
 * @param {import('./catalog.js').Resource[]} catalog
 * @param {string} [primaryId]
 */
function orderedPotimeIds(ids, catalog, primaryId) {
  const set = new Set(ids)
  for (const id of POTIME_BUNDLE_IDS) set.add(id)
  const ordered = []
  if (primaryId && set.has(primaryId)) {
    ordered.push(primaryId)
    set.delete(primaryId)
  }
  for (const id of POTIME_BUNDLE_IDS) {
    if (set.has(id)) {
      ordered.push(id)
      set.delete(id)
    }
  }
  for (const id of set) ordered.push(id)
  return ordered.filter((id) => getResourceById(id, catalog))
}

/**
 * @param {string[]} ids
 * @param {import('./catalog.js').Resource[]} catalog
 */
function linksForIds(ids, catalog) {
  /** @type {Array<{ type: string, href: string, label: string }>} */
  const links = []
  const seen = new Set()
  for (const id of ids) {
    const r = getResourceById(id, catalog)
    if (!r?.url || seen.has(r.url)) continue
    seen.add(r.url)
    links.push({ type: 'external', href: r.url, label: r.topicLabel })
  }
  return links
}

/**
 * @param {import('./catalog.js').Resource} resource
 * @param {import('./catalog.js').Resource[]} catalog
 */
function replyForResource(resource, catalog) {
  const text = formatRedirect(resource)
  if (isPotimeRaidingResource(resource)) {
    const matchIds = orderedPotimeIds([resource.id], catalog, resource.id)
    return {
      text,
      links: linksForIds(matchIds, catalog),
      suggestions: [],
      matchIds,
      status: /** @type {const} */ ('match'),
    }
  }
  const links = resource.url
    ? [{ type: 'external', href: resource.url, label: resource.topicLabel }]
    : []
  return {
    text,
    links,
    suggestions: [],
    matchIds: [resource.id],
    status: /** @type {const} */ ('match'),
  }
}

/**
 * @param {string} displayName
 * @param {import('./entities.js').EntitySense[]} senses
 * @param {import('./catalog.js').Resource[]} catalog
 */
function replyForDisambiguation(displayName, senses, catalog) {
  /** @type {string[]} */
  const matchIds = []
  for (const s of senses) {
    const r = getResourceById(s.resourceId, catalog)
    if (isPotimeRaidingResource(r)) {
      for (const id of orderedPotimeIds([s.resourceId], catalog, s.resourceId)) {
        if (!matchIds.includes(id)) matchIds.push(id)
      }
    } else if (!matchIds.includes(s.resourceId)) {
      matchIds.push(s.resourceId)
    }
  }
  return {
    text: formatDisambiguation(displayName, senses),
    links: linksForIds(matchIds, catalog),
    suggestions: senses.map((s) => s.label),
    matchIds,
    status: /** @type {const} */ ('ambiguous'),
  }
}

/**
 * Domain-only shortcuts (no named multi-sense entity).
 * @param {Set<import('./entities.js').Domain>} cues
 * @param {import('./catalog.js').Resource[]} catalog
 */
function matchFromDomainCues(cues, catalog) {
  if (cues.has('flagging') && !cues.has('potime') && !cues.has('forum-strat')) {
    const r = getResourceById('doc-flags', catalog)
    if (r) return { status: 'match', matches: [{ resource: r, score: 90 }] }
  }
  if (cues.has('potime-logistics') && !cues.has('potime')) {
    const r = getResourceById('post-potime-overview', catalog)
    if (r) return { status: 'match', matches: [{ resource: r, score: 90 }] }
  }
  if (cues.has('potime') && !cues.has('flagging')) {
    // p1–p6 alone may be logistics; if also logistics cues, prefer overview
    if (cues.has('potime-logistics')) {
      const r = getResourceById('post-potime-overview', catalog)
      if (r) return { status: 'match', matches: [{ resource: r, score: 88 }] }
    }
    const r = getResourceById('doc-potime', catalog)
    if (r) return { status: 'match', matches: [{ resource: r, score: 90 }] }
  }
  return null
}

/**
 * Full intent → redirect reply. Never includes guide substance.
 * @param {string} message
 * @param {{ catalog?: import('./catalog.js').Resource[] }} [opts]
 */
export function buildRedirectReply(message, opts = {}) {
  const catalog = opts.catalog || RESOURCES
  const q = normalizeQuery(message)

  if (isCapabilitiesQuery(q)) {
    return {
      text: 'I point you at the right guild resource (flags, Plane of Time raids, member/DKP topics, or forum guides). Name a boss, flag, bid rule, or raid topic — I do not answer the content here.',
      links: [],
      suggestions: [],
      matchIds: [],
      status: 'none',
    }
  }

  const cues = detectDomainCues(q)
  const entityHits = detectEntities(message)

  // Named entity with sense resolution
  if (entityHits.length) {
    const { entity } = entityHits[0]
    const resolved = resolveEntitySenses(entity, cues, q)
    if (resolved.status === 'match') {
      const resource = getResourceById(resolved.sense.resourceId, catalog)
      if (resource) return replyForResource(resource, catalog)
    }
    if (resolved.status === 'ambiguous') {
      return replyForDisambiguation(entity.displayName, resolved.senses, catalog)
    }
  }

  // Flag-mob mention without a registered multi-sense entity → flags
  if (detectFlagMobMention(message) && !cues.has('forum-strat') && !cues.has('potime')) {
    const flags = getResourceById('doc-flags', catalog)
    if (flags) return replyForResource(flags, catalog)
  }

  // Bare domain cues (e.g. "backflagging", "potime resists")
  const domainHit = matchFromDomainCues(cues, catalog)
  if (domainHit?.status === 'match') {
    return replyForResource(domainHit.matches[0].resource, catalog)
  }

  // Catalog fallback (forum-strat, guild sections, etc.)
  const result = matchResources(message, { catalog })
  if (result.status === 'none' || !result.matches.length) {
    return {
      text: "I don't have a resource for that. Try a boss name, flags, Plane of Time, bidding, or a guide topic.",
      links: [],
      suggestions: [],
      matchIds: [],
      status: 'none',
    }
  }

  if (result.status === 'ambiguous') {
    const senses = result.matches.map((m) => ({
      id: m.resource.id,
      domain: m.resource.domain,
      resourceId: m.resource.id,
      label: m.resource.topicLabel,
    }))
    return {
      text: `A few resources might fit — which did you mean?\n${senses.map((s, i) => `${i + 1}. ${s.label}`).join('\n')}`,
      links: result.matches
        .filter((m) => m.resource.url)
        .map((m) => ({
          type: 'external',
          href: m.resource.url,
          label: m.resource.topicLabel,
        })),
      suggestions: senses.map((s) => s.label),
      matchIds: senses.map((s) => s.resourceId),
      status: 'ambiguous',
    }
  }

  return replyForResource(result.matches[0].resource, catalog)
}

export function greetingMessage() {
  return {
    text: 'Ask about flags, Plane of Time raids, guild/DKP topics, or a guide boss. I will route you to the right link — I do not answer the content here.',
    links: [],
    suggestions: [],
    matchIds: [],
    status: 'none',
  }
}
