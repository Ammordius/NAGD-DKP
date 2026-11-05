/** Run scoring and fictional artifacts. */

export const ARTIFACTS = [
  { id: 'questionable_helm', name: 'Questionable Helm of Leadership', minScore: 0 },
  { id: 'cloak_dubious', name: 'Cloak of Dubious Decisions', minScore: 2500 },
  { id: 'boots_running', name: 'Boots of Running Away', minScore: 3500 },
  { id: 'ring_confidence', name: 'Ring of Unjustified Confidence', minScore: 4500 },
  { id: 'sword_finance', name: 'Sword of Poor Financial Planning', minScore: 5500 },
  { id: 'audit_seal', name: 'Seal of Surviving the Audit', minScore: 6500 },
]

/**
 * @param {{
 *   encountersCleared: number,
 *   totalEncounters?: number,
 *   remainingHpPct: number,
 *   knockouts: number,
 *   turns: number,
 *   victory: boolean,
 *   scoreMult?: number,
 *   riskBonus?: number,
 *   abilityCasts?: number,
 *   supportActions?: number,
 * }} input
 */
export function calculateScore(input) {
  const cleared = Math.max(0, input.encountersCleared | 0)
  const hpPct = Math.max(0, Math.min(1, Number(input.remainingHpPct) || 0))
  const kos = Math.max(0, input.knockouts | 0)
  const turns = Math.max(1, input.turns | 0)
  const victory = Boolean(input.victory)
  const scoreMult = Math.max(0, Number(input.scoreMult) || 1)
  const riskBonus = Math.max(0, Number(input.riskBonus) || 0)
  const abilityCasts = Math.max(0, input.abilityCasts | 0)
  const supportActions = Math.max(0, input.supportActions | 0)

  let score = cleared * 800
  score += Math.round(hpPct * 1200)
  score -= kos * 250
  // Efficiency: fewer turns is better (baseline ~7 turns per fight * cleared)
  const expected = Math.max(1, cleared * 7)
  const efficiency = Math.max(0, expected - turns)
  score += efficiency * 25
  if (victory) score += 2000
  score += Math.min(600, abilityCasts * 25)
  score += Math.min(480, supportActions * 40)
  score += riskBonus
  return Math.max(0, Math.round(score * scoreMult))
}

/**
 * @param {number} score
 * @param {boolean} victory
 */
export function pickArtifact(score, victory) {
  if (!victory) {
    return { id: 'participation_memo', name: 'Memo of Participation (Unsigned)' }
  }
  let chosen = ARTIFACTS[0]
  for (const a of ARTIFACTS) {
    if (score >= a.minScore) chosen = a
  }
  return { id: chosen.id, name: chosen.name }
}

/**
 * @param {number} score
 * @param {boolean} victory
 * @param {number} survivors
 */
export function sarcasticAssessment(score, victory, survivors) {
  if (!victory) {
    if (score < 500) return 'Catastrophic. The audit board requests you never lead again.'
    return 'Defeat acknowledged. Your confidence remains inexplicably intact.'
  }
  if (survivors <= 1) return 'Victory with one survivor. I am filing a bug report.'
  if (score >= 6500) return 'Disturbingly competent. Under investigation.'
  if (score >= 4500) return 'Adequate. Do not let it become a habit.'
  return 'You won. The loot is imaginary, which makes it safer in your hands.'
}
