/**
 * Curated resource catalog for the Paperclip redirect bot.
 * Domains: flagging | potime | potime-logistics | guild | forum-strat
 * Forum post URLs filled later via guildtagUrls.js.
 */

import { GUILDTAG_URLS } from './guildtagUrls.js'

export const BOT_NAME = 'Paperclip'
export const BOT_TAGLINE =
  'Routes you to guild guides and docs by what you mean. Does not answer them here.'

export const KIND = {
  POST: 'post',
  DOC: 'doc',
  INFO: 'info',
}

export const DOMAIN = {
  FLAGGING: 'flagging',
  POTIME: 'potime',
  POTIME_LOGISTICS: 'potime-logistics',
  GUILD: 'guild',
  FORUM_STRAT: 'forum-strat',
}

/** @typedef {'post' | 'doc' | 'info'} ResourceKind */
/** @typedef {'flagging' | 'potime' | 'potime-logistics' | 'guild' | 'forum-strat'} Domain */

/**
 * @typedef {object} Resource
 * @property {string} id
 * @property {string} topicLabel
 * @property {string} url
 * @property {ResourceKind} kind
 * @property {Domain} domain
 * @property {string[]} aliases
 */

export const GOOGLE_DOCS = {
  potime: 'https://docs.google.com/document/d/1S_WxAXO5fDIUqcC94vfs1smkYMArZzCK/edit',
  member: 'https://docs.google.com/document/d/1KHcB8FQaUjAzMeM0dezS4BPzxaiAas1N/edit',
  flags: 'https://docs.google.com/document/d/12AUlb1t_YP9fahF6T3n06EJM32s_DBLHr4fQtnuVyxQ/edit?tab=t.0',
}

export const GUILDTAG_FORUMS = 'https://nagd.guildtag.com/forums'

/**
 * @param {string} topicLabel
 * @param {string[]} [extra]
 */
function aliasesFromLabel(topicLabel, extra = []) {
  const base = String(topicLabel || '')
    .toLowerCase()
    .replace(/[`']/g, '')
  const tokens = base
    .replace(/[^a-z0-9\s+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const parts = new Set([
    tokens,
    ...extra.map((a) => String(a).toLowerCase().trim()).filter(Boolean),
  ])
  return [...parts]
}

/**
 * @param {Partial<Resource> & { id: string, topicLabel: string, kind: ResourceKind, domain: Domain }} row
 * @returns {Resource}
 */
function resource(row) {
  return {
    id: row.id,
    topicLabel: row.topicLabel,
    url: row.url || '',
    kind: row.kind,
    domain: row.domain,
    aliases: aliasesFromLabel(row.topicLabel, row.aliases || []),
  }
}

/** @type {Resource[]} */
const RESOURCE_SEED = [
  // --- Core docs ---
  resource({
    id: 'doc-flags',
    topicLabel: 'flags',
    url: GOOGLE_DOCS.flags,
    kind: KIND.DOC,
    domain: DOMAIN.FLAGGING,
    aliases: [
      'flag',
      'flagging',
      'flag share',
      'flag sharing',
      'getting flagged',
      'plane flags',
      'pop flags',
      'how do i get flags',
      'backflag',
      'backflagging',
      'back flag',
      'flagging guide',
      'pop flagging',
    ],
  }),
  resource({
    id: 'doc-potime',
    topicLabel: 'Plane of Time raid fights',
    url: GOOGLE_DOCS.potime,
    kind: KIND.DOC,
    domain: DOMAIN.POTIME,
    aliases: [
      'potime',
      'po time',
      'plane of time raid',
      'time raid guide',
      'potime raid guide',
      'potime guide',
      'gina trigger',
      'gina triggers',
      'potime resists',
      'time resists',
      'god fights',
      'all fights',
      'empty buff slots',
    ],
  }),
  resource({
    id: 'doc-member',
    topicLabel: 'the member guide',
    url: GOOGLE_DOCS.member,
    kind: KIND.DOC,
    domain: DOMAIN.GUILD,
    aliases: ['member guide', 'new member', 'new member guide', 'onboarding', 'guild guide'],
  }),

  // --- Guild sections (same member Doc URL) ---
  resource({
    id: 'guild-getting-started',
    topicLabel: 'getting started',
    url: GOOGLE_DOCS.member,
    kind: KIND.DOC,
    domain: DOMAIN.GUILD,
    aliases: ['getting started', 'discord nickname', 'join nagd', 'autojoin', '/join nagd'],
  }),
  resource({
    id: 'guild-raid-channels',
    topicLabel: 'raid channels',
    url: GOOGLE_DOCS.member,
    kind: KIND.DOC,
    domain: DOMAIN.GUILD,
    aliases: [
      'raid channels',
      'class channels',
      'naggdru',
      'nagdclr',
      'raid channel',
      'class channel',
    ],
  }),
  resource({
    id: 'guild-raiding-rules',
    topicLabel: 'raiding rules',
    url: GOOGLE_DOCS.member,
    kind: KIND.DOC,
    domain: DOMAIN.GUILD,
    aliases: [
      'raiding rules',
      'raid requirements',
      'assist messages',
      'debuffs',
      'raid schedule',
      'class specific roles',
    ],
  }),
  resource({
    id: 'guild-bidding',
    topicLabel: 'DKP bidding',
    url: GOOGLE_DOCS.member,
    kind: KIND.DOC,
    domain: DOMAIN.GUILD,
    aliases: [
      'bidding',
      'how to bid',
      'dkp rules',
      'earning dkp',
      'winning an item',
      'rotting items',
      'collusion',
      'bid',
      'historical dkp',
    ],
  }),
  resource({
    id: 'guild-selling-loot',
    topicLabel: 'selling raid loot',
    url: GOOGLE_DOCS.member,
    kind: KIND.DOC,
    domain: DOMAIN.GUILD,
    aliases: ['selling loot', 'wts', 'sell loot', 'advertise loot', 'wts post'],
  }),
  resource({
    id: 'guild-coth-bank',
    topicLabel: 'COTH and guild bank',
    url: GOOGLE_DOCS.member,
    kind: KIND.DOC,
    domain: DOMAIN.GUILD,
    aliases: [
      'coth',
      'guild bank',
      'shared guild characters',
      'raid hounds',
      'call of the hero',
    ],
  }),

  // --- PoTime logistics (forum overview; URL later) ---
  resource({
    id: 'post-potime-overview',
    topicLabel: 'Raiding in Plane of Time',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.POTIME_LOGISTICS,
    aliases: [
      'plane of time overview',
      'time phases',
      'time lockout',
      'time a',
      'time b',
      'potime logistics',
      'how plane of time works',
      '60 character limit',
      '60 cap',
    ],
  }),

  // --- Forum strats (guildtag later). Flag/PoTime overlaps prefer docs unless LN cues. ---
  resource({
    id: 'post-cleric-raid',
    topicLabel: 'Cleric Raid Guide',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: [
      'cleric guide',
      'cleric raid',
      'clr guide',
      'ch chain',
      'ch chains',
      'complete heal',
      'complete heal chain',
    ],
  }),
  resource({
    id: 'post-ac-augs',
    topicLabel: 'AC augs in LDoN, GoD, and OoW',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: [
      'ac augs',
      'ac aug',
      'ldon augs',
      'god augs',
      'oow augs',
      'augmentation ac',
      'ac augmentations',
      'reference for ac augs',
    ],
  }),
  resource({
    id: 'post-resists',
    topicLabel: 'resist calculations',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: [
      'resist',
      'resists',
      'how do resists work',
      'needed resist',
      'resist calc',
      'calculate resist',
      'resist calculations',
    ],
  }),
  resource({
    id: 'post-grummus',
    topicLabel: 'Grummus low numbers',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['grummus low numbers', 'grummus ln', 'grummus strat'],
  }),
  resource({
    id: 'post-yelwinz',
    topicLabel: 'Disciple Yelwinz',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['yelwinz', 'farming disciple yelwinz', 'disciple yelwinz'],
  }),
  resource({
    id: 'post-phinigel',
    topicLabel: 'Phinigel Autropos',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['phinigel', 'phinny', 'kedge'],
  }),
  resource({
    id: 'post-stanos',
    topicLabel: 'Stanos Herkanor',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['stanos', 'stanos herkanor'],
  }),
  resource({
    id: 'post-powater-charm',
    topicLabel: 'exp and charming in Plane of Water',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['plane of water', 'powater', 'water charming', 'charming water'],
  }),
  resource({
    id: 'post-myral',
    topicLabel: 'Praetorian Myral',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['myral', 'praetorian myral'],
  }),
  resource({
    id: 'post-innoruuk-ln',
    topicLabel: 'Innoruuk low numbers',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['innoruuk low numbers', 'innoruuk ln', 'innoruuk low numbers strat'],
  }),
  resource({
    id: 'post-coirnav',
    topicLabel: 'swimming to Coirnav',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['coirnav', 'swim to coirnav'],
  }),
  resource({
    id: 'post-coldain-ring',
    topicLabel: 'the Coldain ring',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['coldain ring', 'coldain ring 10', 'ring 10', 'cr10', 'coldain war', 'ring war'],
  }),
  resource({
    id: 'post-tormax',
    topicLabel: 'King Tormax sneak turn-in',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['tormax', 'king tormax', 'tormax turn in'],
  }),
  resource({
    id: 'post-trakanon',
    topicLabel: 'Trakanon',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['trakanon', 'trakk'],
  }),
  resource({
    id: 'post-glykus',
    topicLabel: 'Glykus Helmir ornate boot farming',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['glykus', 'glykus helmir', 'ornate boots'],
  }),
  resource({
    id: 'post-mischief-flowers',
    topicLabel: 'farming Plane of Mischief flowers',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['mischief flowers', 'plane of mischief', 'pom flowers'],
  }),
  resource({
    id: 'post-yelinak',
    topicLabel: 'Lord Yelinak',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['yelinak', 'lord yelinak'],
  }),
  resource({
    id: 'post-pofire-tables',
    topicLabel: 'running to Plane of Fire tables',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['plane of fire', 'pofire', 'fire tables'],
  }),
  resource({
    id: 'post-enraged-disciple',
    topicLabel: 'An Enraged Disciple',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['enraged disciple', 'disciple pull'],
  }),
  resource({
    id: 'post-vadyn',
    topicLabel: 'the Va Dyn',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['vadyn', 'va dyn', "va'dyn", 'the va dyn'],
  }),
  resource({
    id: 'post-tfd',
    topicLabel: 'Terror, Fright and Dread',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['terror fright dread', 'tfd', 'terror fright and dread'],
  }),
  resource({
    id: 'post-velketor',
    topicLabel: 'Velketor the Sorcerer',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['velketor', 'velk'],
  }),
  resource({
    id: 'post-coldain-shawl',
    topicLabel: 'Coldain Prayer Shawl',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['prayer shawl', 'coldain shawl', 'shawl multiquest', 'shawl mq'],
  }),
  resource({
    id: 'post-spell-gems',
    topicLabel: 'spell gem colors',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['spell gem', 'spell gems', 'gem color', 'gem colors'],
  }),
  resource({
    id: 'post-atk-dmg-shield',
    topicLabel: 'ATK and DMG shield stacking',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['atk stacking', 'dmg shield', 'damage shield stacking'],
  }),
  resource({
    id: 'post-agro-weapons',
    topicLabel: 'agro weapons calculations',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['agro weapons', 'aggro weapons', 'hate weapons'],
  }),
  resource({
    id: 'post-poair-neck',
    topicLabel: 'Plane of Air gate neck piece',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['plane of air', 'poair', 'air neck', 'gate neck', 'air gate neck'],
  }),
  resource({
    id: 'post-aa',
    topicLabel: 'Alternate Advancement',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['aa guide', 'alternate advancement', 'aas', 'aa'],
  }),
  resource({
    id: 'post-luclin',
    topicLabel: 'Luclin info',
    url: '',
    kind: KIND.POST,
    domain: DOMAIN.FORUM_STRAT,
    aliases: ['luclin', 'luclin info'],
  }),
]

/**
 * @param {Record<string, string>} urlById
 * @param {Resource[]} [base]
 */
export function withGuildtagUrls(urlById, base = RESOURCE_SEED) {
  const map = urlById && typeof urlById === 'object' ? urlById : {}
  return base.map((r) => {
    const next = map[r.id]
    if (!next) return { ...r, aliases: [...r.aliases] }
    return { ...r, url: String(next), aliases: [...r.aliases] }
  })
}

export const RESOURCES = withGuildtagUrls(GUILDTAG_URLS)

/**
 * @param {string} id
 * @param {Resource[]} [catalog]
 */
export function getResourceById(id, catalog = RESOURCES) {
  return catalog.find((r) => r.id === id) || null
}
