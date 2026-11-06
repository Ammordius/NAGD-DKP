/**
 * Render DiscoveryResult → AnswerFacts for the existing response pipeline.
 * Award lists use a structured `table` (React Link cells); not markdown URLs.
 */

import { buildLinks, formatDkp } from '../formatting.js'
import { INTENTS } from '../intents.js'

const MAX_LINES = 40

const AWARD_COLUMNS = ['Item', 'Toon', 'Class', 'Date', 'Raid', 'DKP']
const RECIPIENT_COLUMNS = ['Toon', 'Class', 'Date', 'DKP']
const CATALOG_COLUMNS = ['Item']
const UNASSIGNED_NOTE =
  'Toon assignment is Magelo/manual best-effort; Unassigned means no confirmed toon.'

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @returns {object} AnswerFacts
 */
export function renderDiscovery(result) {
  if (result?.ambiguous?.kind === 'item') {
    const spelling = Boolean(result.ambiguous.spelling)
    return {
      intent: INTENTS.LOOT_DISCOVERY,
      category: 'general',
      factText: result.ambiguous.message,
      requiredClaims: ['need_item'],
      placeholders: {},
      referenced: { characters: [], items: result.ambiguous.candidates.slice(0, 5), raids: [] },
      links: [],
      table: null,
      reasonCode: 'need_item',
      // Roast the typo when soft-match left multiple candidates
      allowFlavor: spelling,
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
      table: null,
      reasonCode: 'loot_discovery',
      allowFlavor: false,
      templateId: 'LOOT_DISCOVERY',
    }
  }

  const family = result?.family || result?.query?.family
  let factText = ''
  /** @type {ReturnType<typeof buildLinks>} */
  let links = []
  /** @type {{ columns: string[], rows: object[] }|null} */
  let table = null
  const referenced = emptyRefs()

  switch (family) {
    case 'boss_catalog':
      ;({ factText, links, table } = renderCatalog(result, referenced))
      break
    case 'raid_loot':
    case 'boss_raid_loot':
      ;({ factText, links, table } = renderRaidLoot(result, referenced))
      break
    case 'item_last':
      ;({ factText, links, table } = renderLastAward(result, referenced))
      break
    case 'item_recipients':
    case 'has_won':
      ;({ factText, links, table } = renderRecipients(result, referenced))
      break
    case 'item_count':
      ;({ factText, links, table } = renderCount(result, referenced))
      break
    case 'character_awards':
      ;({ factText, links, table } = renderCharacterAwards(result, referenced))
      break
    default:
      factText = 'I could not build a discovery answer for that phrasing.'
  }

  const correction = result?.itemCorrection
  if (correction?.from && correction?.to) {
    const preface = `Assuming you meant ${correction.to} (not "${correction.from}").`
    factText = factText ? `${preface} ${factText}` : preface
  }

  const extras = [
    ...(result?.gaps || []),
    // Soft methodology notes only when we actually found a raid (avoid double-failure walls of text)
    ...(result?.raid ? result.notes || [] : []),
  ].filter(Boolean)
  if (extras.length) {
    const unique = [...new Set(extras)].slice(0, 2)
    factText = `${factText}\n\nNote: ${unique.join(' ')}`.trim()
  }

  return {
    intent: INTENTS.LOOT_DISCOVERY,
    category: 'general',
    factText: factText.trim() || 'No recorded awards matched that query.',
    requiredClaims: ['loot_discovery'],
    placeholders: {},
    referenced,
    links,
    table,
    reasonCode: 'loot_discovery',
    // Enable roast flavor when we had to correct their spelling
    allowFlavor: Boolean(correction?.from && correction?.to),
    templateId: 'LOOT_DISCOVERY',
    itemCorrection: correction || null,
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

  if (!raid?.raidId) {
    return {
      factText: result.query?.phase
        ? `No raid with identifiable ${result.query.phase} awards was found (join of item_sources labels to recorded loot).`
        : `No qualifying raid was found${result.query?.zone ? ` for ${result.query.zone}` : ''}.`,
      links: [],
      table: null,
    }
  }

  referenced.raids.push({ id: raid.raidId, name: raid.raidName || raid.raidId })
  const raidLinks = buildLinks({ raidId: raid.raidId, raidName: raid.raidName || `Raid ${raid.raidId}` })

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
      links: raidLinks,
      table: null,
    }
  }

  const rows = awards.slice(0, MAX_LINES).map((a) => formatAwardRow(a, referenced))
  const total = result.totalCount ?? awards.length
  const trunc =
    result.truncated || awards.length > MAX_LINES
      ? `\nShowing ${Math.min(awards.length, MAX_LINES)} of ${total} recorded loot awards.`
      : `\n${total} recorded loot award${total === 1 ? '' : 's'}.`

  return {
    factText: withAssignmentNote(`${header}${trunc}`, awards),
    links: [],
    table: { columns: AWARD_COLUMNS, rows },
  }
}

/**
 * Singular-first answer for "who got the last / most recent X".
 * @param {import('./types.js').DiscoveryResult} result
 * @param {object} referenced
 */
function renderLastAward(result, referenced) {
  const awards = result.awards || []
  const item = result.query?.itemQuery || awards[0]?.itemName || 'item'
  referenced.items.push(item)
  const itemLinks = buildLinks({ itemName: item })

  // Boss/zone + slot multi-item last awards (compositional selector)
  const multiFilter =
    (result.query?.boss || result.query?.zone || result.query?.phase) &&
    result.query?.slot &&
    !lookupNamedItem(result.query?.itemQuery)

  if (multiFilter) {
    return renderCatalogWindowAwards(result, referenced)
  }

  if (!awards.length) {
    return {
      factText: `No recorded awards found for ${item}.`,
      links: itemLinks,
      table: null,
    }
  }

  const most = awards[0]
  const recipient = toonDisplay(most).label
  if (most.raidId) referenced.raids.push({ id: most.raidId, name: most.raidName || most.raidId })

  let factText = `Last recorded award of ${item}: ${recipient} on ${truncateDateIso(most.dateIso)}`
  if (most.raidName || most.raidId) {
    factText += ` (${most.raidName || most.raidId})`
  }
  factText += '.'

  // Optional short history after the singular answer — not the primary framing.
  const prior = awards.slice(1, 4)
  /** @type {ReturnType<typeof formatRecipientRow>[]} */
  const rows = [formatRecipientRow(most, referenced), ...prior.map((a) => formatRecipientRow(a, referenced))]
  if (prior.length) {
    factText += `\nEarlier recorded awards:`
  }
  factText +=
    '\nThese are recorded DKP awards/recipients, not independently proven in-game drop events.'

  return {
    factText: withAssignmentNote(factText, awards),
    links: itemLinks,
    table: { columns: RECIPIENT_COLUMNS, rows },
  }
}

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @param {object} referenced
 */
function renderRecipients(result, referenced) {
  const awards = result.awards || []
  const item = result.query?.itemQuery || awards[0]?.itemName || 'item'
  referenced.items.push(item)
  const itemLinks = buildLinks({ itemName: item })

  if (result.query?.family === 'has_won') {
    const char = result.query.character
    if (!awards.length) {
      return {
        factText: `No recorded award of ${item} to ${char} was found. This is absence from DKP award records, not proof they never saw the item in-game.`,
        links: itemLinks,
        table: null,
      }
    }
    const rows = awards.slice(0, 5).map((a) => formatAwardRow(a, referenced))
    return {
      factText: withAssignmentNote(`Yes — ${char} has recorded award(s) of ${item}:`, awards),
      links: [],
      table: { columns: AWARD_COLUMNS, rows },
    }
  }

  // Boss/zone + slot multi-item last awards (compositional selector)
  const multiFilter =
    (result.query?.boss || result.query?.zone || result.query?.phase) &&
    result.query?.slot &&
    !lookupNamedItem(result.query?.itemQuery)

  if (multiFilter) {
    return renderCatalogWindowAwards(result, referenced)
  }

  if (!awards.length) {
    return {
      factText: `No recorded awards found for ${item}.`,
      links: itemLinks,
      table: null,
    }
  }

  const most = awards[0]
  const recipient = toonDisplay(most).label
  if (most.raidId) referenced.raids.push({ id: most.raidId, name: most.raidName || most.raidId })

  const others = awards.slice(0, 8)
  const rows = others.map((a) => formatRecipientRow(a, referenced))

  let factText = `Who got ${item}?\nMost recent recorded recipient: ${recipient} on ${
    truncateDateIso(most.dateIso)
  }`
  if (rows.length) {
    factText += `\nRecorded recipients:`
  }
  factText +=
    '\nThese are recorded DKP awards/recipients, not independently proven in-game drop events.'

  return {
    factText: withAssignmentNote(factText, awards),
    links: itemLinks,
    table: { columns: RECIPIENT_COLUMNS, rows },
  }
}

function lookupNamedItem(itemQuery) {
  const q = String(itemQuery || '').trim()
  if (!q) return false
  return q.split(/\s+/).length >= 2
}

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @param {object} referenced
 */
function renderCatalogWindowAwards(result, referenced) {
  const awards = result.awards || []
  const boss = result.query?.boss ? prettyBoss(result.query.boss) : null
  const slot = result.query?.slot ? String(result.query.slot).toLowerCase() : null
  const phase = result.query?.phase || null
  const zone = result.query?.zone || null
  const where = boss
    ? boss
    : phase
      ? `${phase}`
      : zone || 'catalog'
  const slotBit = slot ? ` ${slot}` : ''
  const header = `Last recorded${slotBit} awards for ${where}`

  if (!awards.length) {
    const gapHint = (result.gaps || []).some((g) => /catalog|classification|mapped/i.test(g))
      ? ' Catalog mapping for that boss/slot may be incomplete.'
      : ''
    return {
      factText: `${header}: no recorded awards matched.${gapHint}\nAbsence from DKP award history is not proof the item never dropped in-game.`,
      links: [],
      table: null,
    }
  }

  const rows = awards.slice(0, MAX_LINES).map((a) => formatAwardRow(a, referenced))
  const most = awards[0]
  const factText = `${header} (most recent ${truncateDateIso(most.dateIso)}):\nThese are recorded DKP awards joined via item_sources labels, not independently proven in-game drop events.`
  return {
    factText: withAssignmentNote(factText, awards),
    links: [],
    table: { columns: AWARD_COLUMNS, rows },
  }
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
  if (!recent.length) {
    return { factText, links: dedupeLinks(links), table: null }
  }
  const rows = recent.map((a) => formatRecipientRow(a, referenced))
  return {
    factText: withAssignmentNote(`${factText}\nMost recent:`, recent),
    links: [],
    table: { columns: RECIPIENT_COLUMNS, rows },
  }
}

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @param {object} referenced
 */
function renderCharacterAwards(result, referenced) {
  const char = result.query?.character || 'character'
  referenced.characters.push(char)
  const charLinks = buildLinks({ characterName: char })
  const awards = result.awards || []
  const window = result.query?.timeRange?.label ? ` ${result.query.timeRange.label}` : ''
  if (!awards.length) {
    return {
      factText: `No recorded awards for ${char}${window}.`,
      links: charLinks,
      table: null,
    }
  }
  const rows = awards.slice(0, MAX_LINES).map((a) => formatAwardRow(a, referenced))
  const trunc = result.truncated
    ? `\nShowing ${Math.min(awards.length, MAX_LINES)} recorded awards (truncated).`
    : `\n${awards.length} recorded award${awards.length === 1 ? '' : 's'}.`
  return {
    factText: withAssignmentNote(`Recorded awards for ${char}${window}:${trunc}`, awards),
    links: [],
    table: { columns: AWARD_COLUMNS, rows },
  }
}

/**
 * @param {import('./types.js').DiscoveryResult} result
 * @param {object} referenced
 */
function renderCatalog(result, referenced) {
  const boss = prettyBoss(result.query?.boss || 'boss')
  const items = result.catalogItems || []
  if (!items.length) {
    return {
      factText: `No authoritative catalog drops listed for ${boss}. (This is "what can drop," not a historical kill.)`,
      links: [],
      table: null,
    }
  }
  const rows = items.slice(0, MAX_LINES).map((it) => {
    referenced.items.push(it.name)
    const [item] = buildLinks({ itemName: it.name, itemId: it.itemId })
    return { item: item || { type: 'text', label: it.name } }
  })
  return {
    factText: `Catalog drops for ${boss} (item_sources / classification; not a historical kill list):`,
    links: [],
    table: { columns: CATALOG_COLUMNS, rows },
  }
}

/**
 * Prefer assigned toon; annotate DKP buyer when it differs.
 * @param {import('./types.js').LedgerAward} a
 * @returns {{ name: string|null, label: string, linkName: string|null, buyer: string|null }}
 */
function toonDisplay(a) {
  const toon = String(a?.assignedCharacterName || '').trim() || null
  const buyer = String(a?.characterName || '').trim() || null
  if (!toon) {
    return { name: null, label: 'Unassigned', linkName: null, buyer }
  }
  const buyerDiffers = Boolean(buyer && toon.toLowerCase() !== buyer.toLowerCase())
  return {
    name: toon,
    label: buyerDiffers ? `${toon} (buyer ${buyer})` : toon,
    linkName: toon,
    buyer,
  }
}

/**
 * @param {string} factText
 * @param {import('./types.js').LedgerAward[]} awards
 */
function withAssignmentNote(factText, awards) {
  const hasUnassigned = (awards || []).some((a) => !String(a?.assignedCharacterName || '').trim())
  if (!hasUnassigned) return factText
  if (String(factText || '').includes(UNASSIGNED_NOTE)) return factText
  return `${factText}\n${UNASSIGNED_NOTE}`
}

/**
 * @param {import('./types.js').LedgerAward} a
 * @param {object} referenced
 */
function formatAwardRow(a, referenced) {
  const display = toonDisplay(a)
  const dateLabel = truncateDateIso(a.dateIso)
  referenced.items.push(a.itemName)
  if (display.linkName) referenced.characters.push(display.linkName)
  if (display.buyer && display.linkName && display.buyer.toLowerCase() !== display.linkName.toLowerCase()) {
    referenced.characters.push(display.buyer)
  }
  if (a.raidId) {
    referenced.raids.push({ id: a.raidId, name: a.raidName || a.raidId })
  }

  const built = buildLinks({
    itemName: a.itemName,
    characterName: display.linkName || undefined,
    raidId: a.raidId,
    raidName: a.raidName || a.raidId,
  })
  const item = built.find((l) => l.type === 'item') || { type: 'text', label: a.itemName || 'unknown' }
  const linked = built.find((l) => l.type === 'character')
  const toon = linked
    ? { ...linked, label: display.label }
    : { type: 'text', label: display.label }
  const raid = built.find((l) => l.type === 'raid') || null
  const classLabel = String(a.className || '').trim() || '—'

  return {
    item,
    toon,
    class: classLabel,
    date: dateLabel,
    raid,
    dkp: formatDkp(a.cost) ?? '—',
  }
}

/**
 * Recipient-only row (item already named in header / count text).
 * Raid cell uses truncated date as the link label (not raid name).
 * @param {import('./types.js').LedgerAward} a
 * @param {object} referenced
 */
function formatRecipientRow(a, referenced) {
  const display = toonDisplay(a)
  const dateLabel = truncateDateIso(a.dateIso)
  if (display.linkName) referenced.characters.push(display.linkName)
  if (display.buyer && display.linkName && display.buyer.toLowerCase() !== display.linkName.toLowerCase()) {
    referenced.characters.push(display.buyer)
  }
  if (a.raidId) {
    referenced.raids.push({ id: a.raidId, name: a.raidName || a.raidId })
  }
  const built = buildLinks({
    characterName: display.linkName || undefined,
    raidId: a.raidId,
    raidName: dateLabel,
  })
  const linked = built.find((l) => l.type === 'character')
  const toon = linked
    ? { ...linked, label: display.label }
    : { type: 'text', label: display.label }
  const classLabel = String(a.className || '').trim() || '—'
  return {
    toon,
    class: classLabel,
    date: built.find((l) => l.type === 'raid') || { type: 'text', label: dateLabel },
    dkp: formatDkp(a.cost) ?? '—',
  }
}

/** Prefer YYYY-MM-DD when dateIso is a full timestamp. */
function truncateDateIso(dateIso) {
  const s = String(dateIso || '').trim()
  if (!s) return 'unknown date'
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : s
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
