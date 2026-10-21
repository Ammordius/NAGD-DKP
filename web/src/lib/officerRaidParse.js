/** Parse Discord-style raid string e.g. "Thursday 02/12 9pm est: Water Minis + Cursed/Emp - February 12, 2026 8:00 PM" */
export function parseRaidString(str) {
  const s = (str || '').trim()
  let raidName = ''
  let dateIso = ''
  const dashMatch = s.match(/\s+-\s+([^-]+)$/)
  if (dashMatch) {
    const datePart = dashMatch[1].trim()
    raidName = s.replace(/\s+-\s+[^-]+$/, '').replace(/^.*:\s*/, '').trim()
    const d = new Date(datePart)
    if (!isNaN(d.getTime())) {
      dateIso = d.toISOString().slice(0, 19).replace('T', ' ')
    }
  }
  if (!raidName && s) {
    const colonIdx = s.indexOf(':')
    if (colonIdx > 0) raidName = s.slice(colonIdx + 1).trim()
    else raidName = s
  }
  return { raidName, dateIso }
}

function pushNameTokens(chunk, names) {
  String(chunk || '').split(',').forEach((n) => {
    const name = n.trim()
    if (!name || /^\d+$/.test(name) || /members:\s*$/i.test(name)) return
    names.push(name)
  })
}

/** Parse channel member list lines; returns { eventTime, names[] } (trimmed, order kept, repeats kept).
 *  Accepts an EverQuest channel log, one name per line, or a comma-separated list. */
export function parseChannelList(paste) {
  const lines = (paste || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let eventTime = ''
  const names = []
  for (const line of lines) {
    if (/members:\s*$/i.test(line)) {
      const tsMatch = line.match(/^\[([^\]]+)\]/)
      if (tsMatch && !eventTime) eventTime = tsMatch[1].trim()
      continue
    }
    const tsMatch = line.match(/^\[([^\]]+)\]/)
    if (tsMatch) {
      if (!eventTime) eventTime = tsMatch[1].trim()
      pushNameTokens(line.replace(/^\[[^\]]+\]\s*/, ''), names)
      continue
    }
    pushNameTokens(line, names)
  }
  return { eventTime, names }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Index of name as its own token. A shorter name inside a longer one does not match. */
function wholeTokenIndex(haystack, token) {
  const source = String(haystack ?? '')
  const needle = String(token ?? '')
  if (!needle) return -1
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(needle)}(?![A-Za-z0-9])`, 'i')
  const match = re.exec(source)
  if (!match) return -1
  return match.index + match[1].length
}

function blankSpan(text, index, length) {
  return text.slice(0, index) + ' '.repeat(length) + text.slice(index + length)
}

/** Every "N dkp" amount, left to right. "5dkp" and "6 dkp" both count, including 0. */
function findDkpPrices(text) {
  const prices = []
  const re = /(\d+)\s*dkp/gi
  let match
  while ((match = re.exec(text)) !== null) {
    const cost = parseInt(match[1], 10)
    prices.push({
      cost: Number.isNaN(cost) ? 0 : cost,
      index: match.index,
      length: match[0].length,
    })
  }
  return prices
}

/**
 * Pair names and prices in the order they are written.
 * The first name gets the first amount, the second name the second amount, and so on.
 * An item between a name and its amount does not change that pairing.
 * When the line has one amount for several names, each name gets that amount.
 * Further names past the last amount also get that last amount.
 */

function assignCharacterPrices(nameHits, prices) {
  const ordered = [...nameHits].sort(
    (a, b) => a.index - b.index || b.length - a.length
  )

  if (!ordered.length) return []

  if (!prices.length) {
    return ordered.map((hit) => ({
      characterName: hit.name,
      cost: 0,
      hasDkp: false,
    }))
  }

  // Determine whether prices generally appear before or after names.
  const pricesLead = prices[0].index < ordered[0].index

  return ordered.map((hit) => {
    const price = pricesLead
      ? [...prices].reverse().find((p) => p.index < hit.index) ?? prices[0]
      : prices.find((p) => p.index > hit.index) ?? prices.at(-1)

    return {
      characterName: hit.name,
      cost: price.cost,
      hasDkp: true,
    }
  })
}


/**
 * Parse loot log by matching against known character names and item names.
 * Longest whole item match wins. Character names are matched only after the item
 * text is removed, and only as whole tokens, so "deepmind" does not also add "mind".
 * Names and DKP amounts are paired in written order: the first name gets the
 * first amount, the second name gets the second amount, and so on.
 */
export function parseLootLogByMatch(paste, characterNamesList, itemNamesList) {
  const lines = (paste || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const results = []
  const chars = (characterNamesList || []).filter(Boolean).sort((a, b) => (b?.length || 0) - (a?.length || 0))
  const items = (itemNamesList || []).filter(Boolean).sort((a, b) => (b?.length || 0) - (a?.length || 0))
  for (const line of lines) {
    const quoted = (line.match(/'([^']+)'/)?.[1] || line).trim()
    if (!quoted) continue
    let itemName = ''
    let itemIndex = -1
    for (const name of items) {
      const idx = wholeTokenIndex(quoted, name)
      if (idx >= 0) {
        itemName = name
        itemIndex = idx
        break
      }
    }
    let search = itemIndex >= 0
      ? blankSpan(quoted, itemIndex, itemName.length)
      : quoted
    const prices = findDkpPrices(search)
    const nameHits = []
    for (const name of chars) {
      const idx = wholeTokenIndex(search, name)
      if (idx < 0) continue
      nameHits.push({ name, index: idx, length: name.length })
      search = blankSpan(search, idx, name.length)
    }
    const awards = assignCharacterPrices(nameHits, prices)
    const characterNames = awards.map((award) => award.characterName)
    const cost = prices.length ? prices[0].cost : 0
    const hasDkp = prices.length > 0
    results.push({ rawLine: quoted, itemName, characterNames, awards, cost, hasDkp })
  }
  return results
}

/** Generate event_id for a tic (use timestamp from log or now). */
export function generateEventId(eventTimeStr) {
  if (eventTimeStr) {
    const d = new Date(eventTimeStr)
    if (!isNaN(d.getTime())) return `tic-${d.getTime()}`
  }
  return `tic-${Date.now()}`
}

/**
 * Match pasted names to the DKP character list.
 * Exact, case-insensitive. One credit per character and per account.
 * @param {string[]} names
 * @param {{ nameToChar: Record<string, { char_id: string, name: string }>, charIdToAccountId: Record<string, string> }} lookup
 */
export function resolveTicNames(names, { nameToChar, charIdToAccountId }) {
  const matched = []
  const unmatched = []
  const duplicates = []
  const sameAccount = []
  const seenCharId = new Set()
  const seenAccountKey = new Set()
  for (const n of names || []) {
    const key = String(n).toLowerCase().trim()
    const char = nameToChar[key]
    if (!char) {
      unmatched.push(n)
      continue
    }
    if (seenCharId.has(char.char_id)) {
      duplicates.push(n)
      continue
    }
    const accountId = charIdToAccountId[char.char_id] || null
    const accountKey = accountId != null ? String(accountId) : char.char_id
    if (seenAccountKey.has(accountKey)) {
      sameAccount.push(n)
      continue
    }
    seenCharId.add(char.char_id)
    seenAccountKey.add(accountKey)
    matched.push({ char_id: char.char_id, character_name: char.name })
  }
  return {
    matched,
    unmatched,
    duplicates,
    sameAccount,
    noTic: matched.length === 0,
  }
}

/** Group characters by lowercase name. More than one row for a name is ambiguous. */
export function indexCharactersByName(characters) {
  const nameToChars = {}
  for (const c of characters || []) {
    const name = (c?.name || '').trim()
    const charId = c?.char_id != null ? String(c.char_id).trim() : ''
    if (!name || !charId) continue
    const key = name.toLowerCase()
    if (!nameToChars[key]) nameToChars[key] = []
    if (!nameToChars[key].some((row) => row.char_id === charId)) {
      nameToChars[key].push({ char_id: charId, name })
    }
  }
  return nameToChars
}

function accountKeyFor(charId, charIdToAccountId) {
  const accountId = charIdToAccountId?.[charId] ?? null
  if (accountId != null && String(accountId) !== '') return String(accountId)
  return String(charId)
}

/**
 * Classify a pasted name list before creating a tic or appending to one.
 * Unique names are selected by default. Ambiguous names stay out until
 * `resolutions` picks a char_id. Existing attendees are never part of `toAdd`.
 * @param {string[]} names
 * @param {{
 *   nameToChars: Record<string, Array<{ char_id: string, name: string }>>,
 *   charIdToAccountId: Record<string, string>,
 *   existingAttendees?: Array<{ char_id?: string, account_id?: string }>,
 *   resolutions?: Record<string, string>,
 *   excludedCharIds?: string[],
 *   explicitChars?: Array<{ char_id: string, name?: string, character_name?: string }>,
 * }} lookup
 */
export function classifyTicAttendance(names, {
  nameToChars = {},
  charIdToAccountId = {},
  existingAttendees = [],
  resolutions = {},
  excludedCharIds = [],
  explicitChars = [],
} = {}) {
  const excluded = new Set((excludedCharIds || []).map((id) => String(id)))
  const onTicCharIds = new Set()
  const onTicAccountKeys = new Set()
  for (const row of existingAttendees || []) {
    const cid = String(row?.char_id ?? '').trim()
    if (!cid) continue
    onTicCharIds.add(cid)
    const accountId = charIdToAccountId[cid] ?? row.account_id ?? null
    onTicAccountKeys.add(accountId != null && String(accountId) !== '' ? String(accountId) : cid)
  }

  const resolved = []
  const ambiguous = []
  const unmatched = []
  const duplicates = []
  const sameAccount = []
  const alreadyPresent = []
  const seenCharId = new Set()
  const seenAccountKey = new Set()
  const seenAmbiguous = new Set()

  function placeChar(pasteName, char) {
    if (seenCharId.has(char.char_id)) {
      duplicates.push(pasteName)
      return
    }
    const accountKey = accountKeyFor(char.char_id, charIdToAccountId)
    if (onTicCharIds.has(char.char_id)) {
      seenCharId.add(char.char_id)
      seenAccountKey.add(accountKey)
      alreadyPresent.push({ pasteName, char_id: char.char_id, character_name: char.name })
      return
    }
    if (seenAccountKey.has(accountKey) || onTicAccountKeys.has(accountKey)) {
      seenCharId.add(char.char_id)
      sameAccount.push({ pasteName, char_id: char.char_id, character_name: char.name })
      return
    }
    seenCharId.add(char.char_id)
    seenAccountKey.add(accountKey)
    resolved.push({
      pasteName,
      char_id: char.char_id,
      character_name: char.name,
      selected: !excluded.has(char.char_id),
    })
  }

  for (const n of names || []) {
    const pasteName = String(n)
    const key = pasteName.toLowerCase().trim()
    if (!key) continue
    const candidates = []
    const seenCandidate = new Set()
    for (const c of nameToChars[key] || []) {
      const charId = c?.char_id != null ? String(c.char_id).trim() : ''
      if (!charId || seenCandidate.has(charId)) continue
      seenCandidate.add(charId)
      candidates.push({ char_id: charId, name: (c.name || '').trim() || charId })
    }
    if (candidates.length === 0) {
      unmatched.push(pasteName)
      continue
    }

    let char = candidates.length === 1 ? candidates[0] : null
    if (candidates.length > 1) {
      const chosen = resolutions[key] != null ? String(resolutions[key]) : ''
      char = candidates.find((c) => c.char_id === chosen) || null
      if (!char) {
        if (seenAmbiguous.has(key)) duplicates.push(pasteName)
        else {
          seenAmbiguous.add(key)
          ambiguous.push({ pasteName, candidates })
        }
        continue
      }
    }

    placeChar(pasteName, char)
  }

  for (const picked of explicitChars || []) {
    const charId = picked?.char_id != null ? String(picked.char_id).trim() : ''
    if (!charId) continue
    const name = (picked.name || picked.character_name || '').trim() || charId
    placeChar(name, { char_id: charId, name })
  }

  const toAdd = resolved
    .filter((row) => row.selected)
    .map(({ char_id, character_name }) => ({ char_id, character_name }))

  return {
    toAdd,
    resolved,
    ambiguous,
    unmatched,
    duplicates,
    sameAccount,
    alreadyPresent,
  }
}

/** Earned from a tic (one credit per matched attendee) and loot spent on that raid. */
export function raidDkpDelta({ creditedCount = 0, ticValue = 0, lootCost = 0 } = {}) {
  const earned = Number(creditedCount) * Number(ticValue)
  const spent = Number(lootCost) || 0
  return { earned, spent, net: earned - spent }
}

/** Apply a raid delta to an account snapshot. */
export function accountDkpAfterRaidChange(before, delta) {
  return {
    earned: Number(before?.earned || 0) + Number(delta?.earned || 0),
    spent: Number(before?.spent || 0) + Number(delta?.spent || 0),
  }
}

/** Remove a raid delta. The result is the pre-raid snapshot when the delta is the whole test raid. */
export function accountDkpAfterRaidDelete(during, delta) {
  return {
    earned: Number(during?.earned || 0) - Number(delta?.earned || 0),
    spent: Number(during?.spent || 0) - Number(delta?.spent || 0),
  }
}

export function accountDkpMatches(a, b) {
  return Number(a?.earned) === Number(b?.earned) && Number(a?.spent) === Number(b?.spent)
}
