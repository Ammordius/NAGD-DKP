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

/**
 * Parse loot log by matching against known character names and item names.
 * Longest item match wins. Character names are matched only after the item text is removed.
 */
export function parseLootLogByMatch(paste, characterNamesList, itemNamesList) {
  const lines = (paste || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const results = []
  const chars = (characterNamesList || []).filter(Boolean).sort((a, b) => (b?.length || 0) - (a?.length || 0))
  const items = (itemNamesList || []).filter(Boolean).sort((a, b) => (b?.length || 0) - (a?.length || 0))
  for (const line of lines) {
    const quoted = (line.match(/'([^']+)'/)?.[1] || line).trim()
    if (!quoted) continue
    const lower = quoted.toLowerCase()
    let itemName = ''
    for (const name of items) {
      if (name && lower.includes(name.toLowerCase())) {
        itemName = name
        break
      }
    }
    const itemIndex = itemName ? lower.indexOf(itemName.toLowerCase()) : -1
    const lineWithoutItem = itemIndex >= 0
      ? (quoted.slice(0, itemIndex) + quoted.slice(itemIndex + itemName.length)).trim()
      : quoted
    const lowerWithoutItem = lineWithoutItem.toLowerCase()
    const characterNames = chars.filter((name) => name && lowerWithoutItem.includes(name.toLowerCase()))
    const dkpMatch = quoted.match(/(\d+)\s*dkp/i)
    const cost = dkpMatch ? parseInt(dkpMatch[1], 10) : 0
    const hasDkp = !!dkpMatch
    results.push({ rawLine: quoted, itemName, characterNames: [...characterNames], cost: isNaN(cost) ? 0 : cost, hasDkp })
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
