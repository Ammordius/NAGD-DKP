/**
 * Topic-matched roast-first lines for data paths that bypass the A–J template bank.
 * Voice matches templates.js: bureaucratic mockery, praise-then-punch when the player is doing well.
 */

/**
 * @param {'strong'|'viable'|'under'} band
 * @param {{ name: string, pct: number }} args
 */
export function gearBandRoast(band, { name, pct }) {
  const pctLabel = Number.isFinite(pct) ? `${pct}%` : 'unknown %'
  if (band === 'strong') {
    return `${name} is ${pctLabel} — gear looks great. That still won't guarantee you'll hit your damned buttons.`
  }
  if (band === 'viable') {
    return `${name} is ${pctLabel} — acceptably geared. Acceptable still includes forgetting half the rotation.`
  }
  return `${name} is ${pctLabel} — under-geared versus the class bar. The shopping list is longer than your excuses.`
}

/**
 * @param {number} total
 * @param {string} name
 * @param {(n: number) => string} formatDkp
 */
export function characterSpendRoast(total, name, formatDkp) {
  const formatted = formatDkp(total)
  if (total >= 2000) {
    return `Recorded ${formatted} DKP spent on ${name}. Expensive armor still doesn't press your keys.`
  }
  if (total >= 500) {
    return `Recorded ${formatted} DKP spent on ${name}. A respectable invoice — judgment remains extra.`
  }
  if (total > 0) {
    return `Recorded ${formatted} DKP spent on ${name}. Modest spending, immodest confidence.`
  }
  return `Recorded 0 DKP spent on ${name}. Either restraint or an empty auction history — charming either way.`
}

/** @type {Record<'tank'|'priest'|'caster'|'melee', { green: string, viable: string, under: string }>} */
const RAID_READY_PUNCHLINES = {
  tank: {
    green: "The ranking won't hold aggro when you face the wrong way.",
    viable: "Clear the bar, then try remembering which mob you're tanking.",
    under: 'Ambition is free; a real AC stack is not.',
  },
  priest: {
    green: "The ranking won't heal the raid through skipped buttons.",
    viable: 'Clear the bar, then try remembering who needs the heal.',
    under: 'Ambition is free; mana and coverage are not.',
  },
  caster: {
    green: "The ranking won't land the nuke you forgot to cast.",
    viable: 'Clear the bar, then try remembering the nuke order.',
    under: 'Ambition is free; focus and coverage are not.',
  },
  melee: {
    green: "The ranking won't press your rotation for you.",
    viable: 'Clear the bar, then try remembering the fight.',
    under: 'Ambition is free; coverage is not.',
  },
}

/**
 * @param {{
 *   name: string,
 *   pctLabel: string,
 *   classLabel: string,
 *   viable: boolean,
 *   green: boolean,
 *   viabilityCut: number|null|undefined,
 *   greenCut: number|null|undefined,
 *   sheetBits?: string|null,
 *   role?: 'tank'|'priest'|'caster'|'melee'|null,
 * }} args
 */
export function raidReadyRoast({
  name,
  pctLabel,
  classLabel,
  viable,
  green,
  viabilityCut,
  greenCut,
  sheetBits = null,
  role = 'melee',
}) {
  const cutBits =
    viabilityCut != null && greenCut != null
      ? ` Raid-ready >${viabilityCut}%; green >${greenCut}%.`
      : ''
  const lines = RAID_READY_PUNCHLINES[role] || RAID_READY_PUNCHLINES.melee
  let punch
  if (viable && green) punch = lines.green
  else if (viable) punch = lines.viable
  else punch = lines.under

  let status
  if (viable && green) {
    status = `${name} is ${pctLabel} (${classLabel}) — raid-ready and green.${cutBits} ${punch}`
  } else if (viable) {
    status = `${name} is ${pctLabel} (${classLabel}) — raid-ready, not green.${cutBits} ${punch}`
  } else {
    status = `${name} is ${pctLabel} (${classLabel}) — below raid-ready.${cutBits} ${punch}`
  }
  if (sheetBits) return `${status}\n${sheetBits}.`
  return status
}

/**
 * Roast opener + newline-broken Magelo sheet lines.
 * @param {string} name
 * @param {string} classLabel
 * @param {string[]} bodyLines
 */
export function characterStatsRoast(name, classLabel, bodyLines) {
  const opener = `Here are ${name}'s Magelo numbers (${classLabel || 'unknown class'}). They remain unused until you remember the rotation.`
  const body = (bodyLines || []).filter(Boolean)
  return body.length ? `${opener}\n${body.join('\n')}` : opener
}
