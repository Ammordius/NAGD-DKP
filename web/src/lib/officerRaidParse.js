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

/** Parse channel member list lines; returns { eventTime, names[] } (trimmed, order kept, repeats kept). */
export function parseChannelList(paste) {
  const lines = (paste || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let eventTime = ''
  const names = []
  for (const line of lines) {
    const tsMatch = line.match(/^\[([^\]]+)\]/)
    if (tsMatch) {
      const ts = tsMatch[1].trim()
      if (!eventTime) eventTime = ts
      if (/members:\s*$/i.test(line)) continue
      const rest = line.replace(/^\[[^\]]+\]\s*/, '').trim()
      rest.split(',').forEach((n) => {
        const name = n.trim()
        if (name && !/^\d+$/.test(name)) names.push(name)
      })
    }
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
