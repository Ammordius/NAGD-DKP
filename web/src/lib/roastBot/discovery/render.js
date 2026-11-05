/**
 * Render DiscoveryResult → AnswerFacts for the existing response pipeline.
 * Uses structured links (raid / item / character), not markdown URLs.
 */

import { buildLinks } from '../formatting.js'
import { INTENTS } from '../intents.js'

const MAX_LINES = 40

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @returns {object} AnswerFacts
 */
export function renderDiscovery(result) {
  if (result?.ambiguous?.kind === 'item') {
    return {
      intent: INTENTS.LOOT_DISCOVERY,
      category: 'general',
      factText: result.ambiguous.message,
      requiredClaims: ['need_item'],
      placeholders: {},
      referenced: { characters: [], items: result.ambiguous.candidates.slice(0, 5), raids: [] },
      links: [],
      reasonCode: 'need_item',
      allowFlavor: false,
      templateId: 'NEED_ITEM',
      clarification: {
        slot: 'item',
        message: result.ambiguous.message,
        pendingIntent: INTENTS.LOOT_DISCOVERY,
      },
    }
  }

  if (!result?.ok && result?.error) {
    return {
      intent: INTENTS.LOOT_DISCOVERY,
      category: 'general',
      factText: `Discovery lookup failed: ${result.error}. No numbers were invented.`,
      requiredClaims: ['discovery_error'],
      placeholders: {},
      referenced: emptyRefs(),
      links: [],
      reasonCode: 'loot_discovery',
      allowFlavor: false,
      templateId: 'LOOT_DISCOVERY',
    }
  }

  const family = result?.family || result?.query?.family
  let factText = ''
  /** @type {ReturnType<typeof buildLinks>} */
  let links = []
  const referenced = emptyRefs()

  switch (family) {
    case 'boss_catalog':
      ({ factText, links } = renderCatalog(result, referenced))
      break
    case 'raid_loot':
    case 'boss_raid_loot':
      ({ factText, links } = renderRaidLoot(result, referenced))
      break
    case 'item_recipients':
    case 'item_last':
    case 'has_won':
      ({ factText, links } = renderRecipients(result, referenced))
      break
    case 'item_count':
      ({ factText, links } = renderCount(result, referenced))
      break
    case 'character_awards':
      ({ factText, links } = renderCharacterAwards(result, referenced))
      break
    default:
      factText = 'I could not build a discovery answer for that phrasing.'
  }

  if (result?.gaps?.length) {
    const gapLines = result.gaps.filter(Boolean)
    // Avoid duplicating long phase notes already inlined
    const unique = [...new Set(gapLines)].slice(0, 3)
    if (unique.length) factText = `${factText}\n\nNote: ${unique.join(' ')}`.trim()
  }

  return {
    intent: INTENTS.LOOT_DISCOVERY,
    category: 'general',
    factText: factText.trim() || 'No recorded awards matched that query.',
    requiredClaims: ['loot_discovery'],
    placeholders: {},
    referenced,
    links,
    reasonCode: 'loot_discovery',
    allowFlavor: false,
    templateId: 'LOOT_DISCOVERY',
  }
}

function emptyRefs() {
  return { characters: [], items: [], raids: [] }
}

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @param {object} referenced
 */
function renderRaidLoot(result, referenced) {
  const raid = result.raid
  const awards = result.awards || []
  /** @type {ReturnType<typeof buildLinks>} */
  const links = []

  if (!raid?.raidId) {
    return {
      factText: result.query?.phase
        ? `No raid with identifiable ${result.query.phase} activity was found in raid_classifications.`
        : `No qualifying raid was found${result.query?.zone ? ` for ${result.query.zone}` : ''}.`,
      links,
    }
  }

  referenced.raids.push({ id: raid.raidId, name: raid.raidName || raid.raidId })
  links.push(...buildLinks({ raidId: raid.raidId, raidName: raid.raidName || `Raid ${raid.raidId}` }))

  const phaseNote = result.query?.phase
    ? ` (identifiable ${result.query.phase} awards only; other PoTime loot excluded)`
    : ''
  const bossNote =
    result.query?.family === 'boss_raid_loot' && result.query?.boss
      ? ` associated with ${prettyBoss(result.query.boss)}`
      : ''

  const header = `Last${result.query?.zone ? ` ${result.query.zone}` : ''}${
    result.query?.phase ? ` ${result.query.phase}` : ''
  } raid${bossNote} — ${raid.dateIso || 'unknown date'}${phaseNote}`

  if (!awards.length) {
    return {
      factText: `${header}\nNo recorded loot awards for this qualifying set (empty awards ≠ missing raid).`,
      links,
    }
  }

  const lines = awards.slice(0, MAX_LINES).map((a) => formatAwardLine(a, referenced, links))
  const total = result.totalCount ?? awards.length
  const trunc =
    result.truncated || awards.length > MAX_LINES
      ? `\nShowing ${Math.min(awards.length, MAX_LINES)} of ${total} recorded loot awards.`
      : `\n${total} recorded loot award${total === 1 ? '' : 's'}.`

  return { factText: `${header}\n${lines.join('\n')}${trunc}`, links: dedupeLinks(links) }
}

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @param {object} referenced
 */
function renderRecipients(result, referenced) {
  const awards = result.awards || []
  const item = result.query?.itemQuery || awards[0]?.itemName || 'item'
  /** @type {ReturnType<typeof buildLinks>} */
  const links = []
  links.push(...buildLinks({ itemName: item }))
  referenced.items.push(item)

  if (result.query?.family === 'has_won') {
    const char = result.query.character
    if (!awards.length) {
      return {
        factText: `No recorded award of ${item} to ${char} was found. This is absence from DKP award records, not proof they never saw the item in-game.`,
        links: dedupeLinks(links),
      }
    }
    const lines = awards.slice(0, 5).map((a) => formatAwardLine(a, referenced, links))
    return {
      factText: `Yes — ${char} has recorded award(s) of ${item}:\n${lines.join('\n')}`,
      links: dedupeLinks(links),
    }
  }

  if (!awards.length) {
    return {
      factText: `No recorded awards found for ${item}.`,
      links: dedupeLinks(links),
    }
  }

  const most = awards[0]
  const recipient = most.characterName || most.assignedCharacterName || 'unknown'
  if (most.characterName) referenced.characters.push(most.characterName)
  links.push(...buildLinks({ characterName: recipient, raidId: most.raidId, raidName: most.raidName }))
  if (most.raidId) referenced.raids.push({ id: most.raidId, name: most.raidName || most.raidId })

  const others = awards.slice(1, 8)
  const otherLines = others.map((a) => {
    const who = a.characterName || a.assignedCharacterName || 'unknown'
    if (a.characterName) referenced.characters.push(a.characterName)
    if (a.raidId) {
      referenced.raids.push({ id: a.raidId, name: a.raidName || a.raidId })
      links.push(...buildLinks({ raidId: a.raidId, raidName: a.raidName || a.raidId }))
    }
    links.push(...buildLinks({ characterName: who }))
    return `- ${who} on ${a.dateIso || 'unknown date'}`
  })

  let factText = `Who got ${item}?\nMost recent recorded recipient: ${recipient} on ${
    most.dateIso || 'unknown date'
  }`
  if (otherLines.length) {
    factText += `\nOther recorded recipients:\n${otherLines.join('\n')}`
  }
  factText +=
    '\nThese are recorded DKP awards/recipients, not independently proven in-game drop events.'

  return { factText, links: dedupeLinks(links) }
}

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @param {object} referenced
 */
function renderCount(result, referenced) {
  const item = result.query?.itemQuery || 'item'
  referenced.items.push(item)
  const links = buildLinks({ itemName: item })
  const n = result.totalCount
  const factText =
    n == null
      ? `Could not count recorded awards for ${item}.`
      : `${item} has ${n} recorded award${n === 1 ? '' : 's'} in DKP loot history.`
  const recent = (result.awards || []).slice(0, 3)
  const extra = recent.length
    ? `\nMost recent: ${recent
        .map((a) => `${a.characterName || 'unknown'} on ${a.dateIso || 'unknown date'}`)
        .join('; ')}.`
    : ''
  for (const a of recent) {
    if (a.characterName) referenced.characters.push(a.characterName)
    if (a.raidId) {
      referenced.raids.push({ id: a.raidId, name: a.raidName || a.raidId })
      links.push(...buildLinks({ raidId: a.raidId, raidName: a.raidName }))
    }
  }
  return { factText: factText + extra, links: dedupeLinks(links) }
}

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @param {object} referenced
 */
function renderCharacterAwards(result, referenced) {
  const char = result.query?.character || 'character'
  referenced.characters.push(char)
  const links = buildLinks({ characterName: char })
  const awards = result.awards || []
  const window = result.query?.timeRange?.label ? ` ${result.query.timeRange.label}` : ''
  if (!awards.length) {
    return {
      factText: `No recorded awards for ${char}${window}.`,
      links,
    }
  }
  const lines = awards.slice(0, MAX_LINES).map((a) => formatAwardLine(a, referenced, links))
  const trunc = result.truncated
    ? `\nShowing ${Math.min(awards.length, MAX_LINES)} recorded awards (truncated).`
    : `\n${awards.length} recorded award${awards.length === 1 ? '' : 's'}.`
  return {
    factText: `Recorded awards for ${char}${window}:\n${lines.join('\n')}${trunc}`,
    links: dedupeLinks(links),
  }
}

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @param {object} referenced
 */
function renderCatalog(result, referenced) {
  const boss = prettyBoss(result.query?.boss || 'boss')
  const items = result.catalogItems || []
  const links = []
  if (!items.length) {
    return {
      factText: `No authoritative catalog drops listed for ${boss}. (This is "what can drop," not a historical kill.)`,
      links,
    }
  }
  for (const it of items.slice(0, MAX_LINES)) {
    referenced.items.push(it.name)
    links.push(...buildLinks({ itemName: it.name, itemId: it.itemId }))
  }
  return {
    factText: `Catalog drops for ${boss} (item_sources / classification; not a historical kill list):\n${items
      .slice(0, MAX_LINES)
      .map((i) => `- ${i.name}`)
      .join('\n')}`,
    links: dedupeLinks(links),
  }
}

/**
 * @param {import('./types.js').LedgerAward} a
 * @param {object} referenced
 * @param {object[]} links
 */
function formatAwardLine(a, referenced, links) {
  const who = a.characterName || a.assignedCharacterName || 'unknown'
  referenced.items.push(a.itemName)
  if (a.characterName) referenced.characters.push(a.characterName)
  links.push(...buildLinks({ itemName: a.itemName, characterName: who }))
  if (a.raidId) {
    referenced.raids.push({ id: a.raidId, name: a.raidName || a.raidId })
    links.push(...buildLinks({ raidId: a.raidId, raidName: a.raidName || a.raidId }))
  }
  const date = a.dateIso ? `, ${a.dateIso}` : ''
  return `- ${a.itemName} → ${who}${date}`
}

function prettyBoss(boss) {
  return String(boss || '').replace(/_/g, ' ')
}

function dedupeLinks(links) {
  const seen = new Set()
  const out = []
  for (const l of links || []) {
    const key = `${l.type}:${l.to}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(l)
  }
  return out
}
