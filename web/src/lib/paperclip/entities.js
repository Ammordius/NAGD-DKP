/**
 * Entity registry + domain cues for Paperclip intent routing.
 * Entities may have multiple senses (e.g. Bertoxx flag vs PoTime).
 */

import { editDistance, maxEditsForLength } from '../roastBot/discovery/fuzzy.js'

/** @typedef {'flagging' | 'potime' | 'potime-logistics' | 'guild' | 'forum-strat'} Domain */

/**
 * @typedef {object} EntitySense
 * @property {string} id - stable sense id
 * @property {Domain} domain
 * @property {string} resourceId - catalog resource id
 * @property {string} label - short label for disambiguation chips
 * @property {string} [contextHint] - shown in clarifying question
 * @property {string[]} [cueBoost] - extra cue phrases that pick this sense
 */

/**
 * @typedef {object} Entity
 * @property {string} id
 * @property {string} displayName
 * @property {string[]} names - match phrases (normalized later)
 * @property {EntitySense[]} senses
 */

/**
 * Domain cue patterns (tested against normalized query).
 * @type {Record<Domain, RegExp[]>}
 */
export const DOMAIN_CUES = {
  flagging: [
    /\bflag(?:s|ging|ged)?\b/,
    /\bbackflag(?:ging|s)?\b/,
    /\bcrypt of decay\b/,
    /\bcod\b/,
    /\bplane of disease\b/,
    /\bpod\b/,
    /\bneed access\b/,
    /\bnot flagged\b/,
    /\bpop flags?\b/,
    /\bflag share(?:ing)?\b/,
    /\bflagging raid\b/,
    /\bback ?flag\b/,
  ],
  potime: [
    /\bpotime\b/,
    /\bpo time\b/,
    /\bplane of time\b/,
    /\btime raid\b/,
    /\bgod fight\b/,
    /\bgina\b/,
    /\bquarm\b/,
    /\bp[1-6]\b/,
    /\btime resists?\b/,
    /\bpotime resists?\b/,
  ],
  'potime-logistics': [
    /\btime a\b/,
    /\btime b\b/,
    /\blockout\b/,
    /\bphases?\b/,
    /\b60(?:\s|-)?(?:cap|limit|character)/,
    /\bpotime logistics\b/,
    /\bhow (?:does|do) (?:plane of )?time work/,
  ],
  guild: [
    /\bbid(?:ding|s)?\b/,
    /\bdkp\b/,
    /\bwts\b/,
    /\bcoth\b/,
    /\braid channels?\b/,
    /\braid schedule\b/,
    /\bguild bank\b/,
    /\bselling loot\b/,
    /\bmember guide\b/,
    /\bnew member\b/,
    /\bonboarding\b/,
  ],
  'forum-strat': [
    /\blow numbers?\b/,
    /\bln strat\b/,
    /\blow[- ]man\b/,
  ],
}

/** @type {Entity[]} */
export const ENTITIES = [
  {
    id: 'bertoxx',
    displayName: 'Bertoxxulous',
    names: ['bertoxxulous', 'bertoxx', 'bert'],
    senses: [
      {
        id: 'bertoxx-flag',
        domain: 'flagging',
        resourceId: 'doc-flags',
        label: 'Bertoxx in Crypt of Decay (flagging)',
        contextHint: 'Crypt of Decay / disease flag path',
        cueBoost: ['crypt of decay', 'cod', 'disease'],
      },
      {
        id: 'bertoxx-potime',
        domain: 'potime',
        resourceId: 'doc-potime',
        label: 'Bertoxx in Plane of Time (raid guide)',
        contextHint: 'Plane of Time raid fight',
        cueBoost: ['potime', 'po time', 'plane of time', 'time raid', 'gina'],
      },
    ],
  },
  {
    id: 'innoruuk',
    displayName: 'Innoruuk',
    names: ['innoruuk', 'innoruk'],
    senses: [
      {
        id: 'innoruuk-flag',
        domain: 'flagging',
        resourceId: 'doc-flags',
        label: 'Innoruuk for flagging',
        contextHint: 'flag / progression access',
        cueBoost: ['flag', 'backflag', 'flagging'],
      },
      {
        id: 'innoruuk-potime',
        domain: 'potime',
        resourceId: 'doc-potime',
        label: 'Innoruuk in Plane of Time (raid guide)',
        contextHint: 'Plane of Time raid fight',
        cueBoost: ['potime', 'po time', 'plane of time', 'god fight'],
      },
      {
        id: 'innoruuk-ln',
        domain: 'forum-strat',
        resourceId: 'post-innoruuk-ln',
        label: 'Innoruuk low numbers strat (forum post)',
        contextHint: 'low numbers writeup',
        cueBoost: ['low numbers', 'ln strat', 'low man'],
      },
    ],
  },
  {
    id: 'cazic',
    displayName: 'Cazic Thule',
    names: ['cazic thule', 'cazic'],
    senses: [
      {
        id: 'cazic-flag',
        domain: 'flagging',
        resourceId: 'doc-flags',
        label: 'Cazic for flagging',
        contextHint: 'flag / progression',
        cueBoost: ['flag', 'backflag', 'flagging', 'fear'],
      },
      {
        id: 'cazic-potime',
        domain: 'potime',
        resourceId: 'doc-potime',
        label: 'Cazic in Plane of Time (raid guide)',
        contextHint: 'Plane of Time raid fight',
        cueBoost: ['potime', 'po time', 'plane of time', 'gina', 'god fight'],
      },
    ],
  },
  {
    id: 'terris',
    displayName: 'Terris Thule',
    names: ['terris thule', 'terris'],
    senses: [
      {
        id: 'terris-flag',
        domain: 'flagging',
        resourceId: 'doc-flags',
        label: 'Terris for flagging',
        contextHint: 'flag / Nightmare access',
        cueBoost: ['flag', 'backflag', 'flagging', 'nightmare'],
      },
      {
        id: 'terris-potime',
        domain: 'potime',
        resourceId: 'doc-potime',
        label: 'Terris in Plane of Time (raid guide)',
        contextHint: 'Plane of Time raid fight',
        cueBoost: ['potime', 'po time', 'plane of time', 'god fight'],
      },
    ],
  },
  {
    id: 'saryrn',
    displayName: 'Saryrn',
    names: ['saryrn'],
    senses: [
      {
        id: 'saryrn-flag',
        domain: 'flagging',
        resourceId: 'doc-flags',
        label: 'Saryrn for flagging',
        contextHint: 'flag / Torment access',
        cueBoost: ['flag', 'backflag', 'flagging', 'torment'],
      },
      {
        id: 'saryrn-potime',
        domain: 'potime',
        resourceId: 'doc-potime',
        label: 'Saryrn in Plane of Time (raid guide)',
        contextHint: 'Plane of Time raid fight',
        cueBoost: ['potime', 'po time', 'plane of time', 'god fight'],
      },
    ],
  },
  {
    id: 'grummus',
    displayName: 'Grummus',
    names: ['grummus'],
    senses: [
      {
        id: 'grummus-flag',
        domain: 'flagging',
        resourceId: 'doc-flags',
        label: 'Grummus (flagging)',
        contextHint: 'Plane of Disease flag path',
        cueBoost: ['flag', 'backflag', 'flagging', 'plane of disease', 'pod'],
      },
      {
        id: 'grummus-ln',
        domain: 'forum-strat',
        resourceId: 'post-grummus',
        label: 'Grummus low numbers strat (forum post)',
        contextHint: 'low numbers writeup',
        cueBoost: ['low numbers', 'ln strat', 'low man'],
      },
    ],
  },
  // PoTime-only gods / fights
  {
    id: 'quarm',
    displayName: 'Quarm',
    names: ['quarm'],
    senses: [
      {
        id: 'quarm-potime',
        domain: 'potime',
        resourceId: 'doc-potime',
        label: 'Quarm (Plane of Time raid guide)',
        contextHint: 'Plane of Time',
      },
    ],
  },
  {
    id: 'tallon',
    displayName: 'Tallon Zek',
    names: ['tallon zek', 'tallon'],
    senses: [
      {
        id: 'tallon-potime',
        domain: 'potime',
        resourceId: 'doc-potime',
        label: 'Tallon Zek (Plane of Time raid guide)',
        contextHint: 'Plane of Time',
      },
    ],
  },
  {
    id: 'vallon',
    displayName: 'Vallon Zek',
    names: ['vallon zek', 'vallon'],
    senses: [
      {
        id: 'vallon-potime',
        domain: 'potime',
        resourceId: 'doc-potime',
        label: 'Vallon Zek (Plane of Time raid guide)',
        contextHint: 'Plane of Time',
      },
    ],
  },
  {
    id: 'rallos',
    displayName: 'Rallos Zek',
    names: ['rallos zek', 'rallos'],
    senses: [
      {
        id: 'rallos-potime',
        domain: 'potime',
        resourceId: 'doc-potime',
        label: 'Rallos Zek (Plane of Time raid guide)',
        contextHint: 'Plane of Time',
      },
    ],
  },
  // Flag-path / progression mobs (single sense → flags) unless LN explicitly asked via forum resource aliases
  {
    id: 'flag-generic',
    displayName: 'flagging',
    names: [],
    senses: [
      {
        id: 'flags-doc',
        domain: 'flagging',
        resourceId: 'doc-flags',
        label: 'flagging guide',
        contextHint: 'flags',
      },
    ],
  },
]

/** Additional flag-path mob names that always map to flagging (unless low-numbers forum cue wins via catalog). */
export const FLAG_MOB_NAMES = [
  'grummus',
  'beryx',
  'keeper',
  'hedge',
  'construct of nightmares',
  'thelin',
  'adler',
  'maareq',
  'amygdalan',
  'aeldor',
  'txevu',
  'cod bert',
  'crypt bert',
]

/**
 * @param {string} text
 */
export function normalizeQuery(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[`']/g, '')
    .replace(/[^a-z0-9\s+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {string} query normalized
 * @returns {Set<Domain>}
 */
export function detectDomainCues(query) {
  /** @type {Set<Domain>} */
  const hit = new Set()
  for (const [domain, patterns] of Object.entries(DOMAIN_CUES)) {
    for (const re of patterns) {
      if (re.test(query)) {
        hit.add(/** @type {Domain} */ (domain))
        break
      }
    }
  }
  return hit
}

/**
 * Exact or fuzzy name hit inside query.
 * @param {string} query
 * @param {string} name
 */
function nameHitsQuery(query, name) {
  const n = normalizeQuery(name)
  if (!n || !query) return false
  if (query === n) return true

  const tokens = query.split(' ').filter(Boolean)

  // Multi-word name: require contiguous phrase (or fuzzy whole query)
  if (n.includes(' ')) {
    if (query.includes(n)) return true
    const dist = editDistance(query, n)
    const max = Math.max(maxEditsForLength(query.length), maxEditsForLength(n.length))
    if (query.length <= n.length + 3 && dist > 0 && dist <= max) return true
    return false
  }

  // Single-token: whole-token match only (avoid "bert" inside "albert")
  for (const t of tokens) {
    if (t === n) return true
    if (n.length >= 4) {
      const dist = editDistance(t, n)
      const max = Math.max(maxEditsForLength(t.length), maxEditsForLength(n.length))
      if (dist > 0 && dist <= max) return true
    }
  }
  return false
}

/**
 * @param {string} message
 * @returns {Array<{ entity: Entity, matchedName: string }>}
 */
export function detectEntities(message) {
  const q = normalizeQuery(message)
  if (!q) return []
  /** @type {Array<{ entity: Entity, matchedName: string, nameLen: number }>} */
  const hits = []
  for (const entity of ENTITIES) {
    if (!entity.names.length) continue
    // Prefer longest matching name
    const names = [...entity.names].sort((a, b) => b.length - a.length)
    for (const name of names) {
      if (nameHitsQuery(q, name)) {
        hits.push({ entity, matchedName: name, nameLen: name.length })
        break
      }
    }
  }
  // Also: flag-mob list → synthetic grummus-style flagging via FLAG_MOB_NAMES (non-entity)
  return hits.sort((a, b) => b.nameLen - a.nameLen)
}

/**
 * @param {string} message
 * @returns {boolean}
 */
export function detectFlagMobMention(message) {
  const q = normalizeQuery(message)
  for (const name of FLAG_MOB_NAMES) {
    if (nameHitsQuery(q, name)) return true
  }
  return false
}

/**
 * Resolve entity senses using domain cues.
 * @param {Entity} entity
 * @param {Set<Domain>} cues
 * @param {string} query
 * @returns {{ status: 'match', sense: EntitySense } | { status: 'ambiguous', senses: EntitySense[] } | { status: 'none' }}
 */
export function resolveEntitySenses(entity, cues, query) {
  const senses = entity.senses || []
  if (!senses.length) return { status: 'none' }
  if (senses.length === 1) return { status: 'match', sense: senses[0] }

  /** @type {EntitySense[]} */
  const boosted = []
  for (const sense of senses) {
    if (cues.has(sense.domain)) {
      boosted.push(sense)
      continue
    }
    for (const phrase of sense.cueBoost || []) {
      if (query.includes(normalizeQuery(phrase))) {
        boosted.push(sense)
        break
      }
    }
  }

  if (boosted.length === 1) return { status: 'match', sense: boosted[0] }
  if (boosted.length > 1) {
    // Prefer forum-strat only when explicitly cued; else prefer flagging/potime over ln
    const withoutLn = boosted.filter((s) => s.domain !== 'forum-strat')
    if (withoutLn.length === 1) return { status: 'match', sense: withoutLn[0] }
    if (withoutLn.length > 1) {
      return { status: 'ambiguous', senses: withoutLn }
    }
    return { status: 'ambiguous', senses: boosted }
  }

  // No cues: multi-sense → ask (but drop forum-strat from default ambiguity unless only senses)
  const primary = senses.filter((s) => s.domain !== 'forum-strat')
  if (primary.length === 1) return { status: 'match', sense: primary[0] }
  if (primary.length > 1) return { status: 'ambiguous', senses: primary }
  return { status: 'ambiguous', senses }
}

/**
 * Capabilities / help intents — not a topic menu.
 * @param {string} query
 */
export function isCapabilitiesQuery(query) {
  const q = normalizeQuery(query)
  return (
    /^(help|hi|hello)\b/.test(q) ||
    /\bwhat can you (help|do|point)\b/.test(q) ||
    /\bwhat do you (know|cover)\b/.test(q) ||
    /\bhow (do|does) (this|paperclip) work\b/.test(q)
  )
}
