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
}) {
  const cutBits =
    viabilityCut != null && greenCut != null
      ? ` Raid-ready >${viabilityCut}%; green >${greenCut}%.`
      : ''
  let status
  if (viable && green) {
    status = `${name} is ${pctLabel} (${classLabel}) — raid-ready and green.${cutBits} The ranking won't heal you through skipped buttons.`
  } else if (viable) {
    status = `${name} is ${pctLabel} (${classLabel}) — raid-ready, not green.${cutBits} Clear the bar, then try remembering the fight.`
  } else {
    status = `${name} is ${pctLabel} (${classLabel}) — below raid-ready.${cutBits} Ambition is free; coverage is not.`
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
