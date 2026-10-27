/**
 * Normalize expedition save payloads for usePersistedState.
 * @typedef {{
 *   version: number,
 *   personalBest: number,
 *   unlockedArtifacts: string[],
 *   completedRuns: number,
 * }} ExpeditionSave
 */

export const SAVE_VERSION = 1

/** @returns {ExpeditionSave} */
export function emptyExpeditionSave() {
  return {
    version: SAVE_VERSION,
    personalBest: 0,
    unlockedArtifacts: [],
    completedRuns: 0,
  }
}

/**
 * @param {unknown} parsed
 * @returns {ExpeditionSave}
 */
export function normalizeExpeditionSave(parsed) {
  const base = emptyExpeditionSave()
  if (!parsed || typeof parsed !== 'object') return base
  const p = /** @type {Record<string, unknown>} */ (parsed)
  const version = Number(p.version) || SAVE_VERSION
  const personalBest = Math.max(0, Math.floor(Number(p.personalBest) || 0))
  const completedRuns = Math.max(0, Math.floor(Number(p.completedRuns) || 0))
  const arts = Array.isArray(p.unlockedArtifacts)
    ? [...new Set(p.unlockedArtifacts.map((a) => String(a)).filter(Boolean))].slice(0, 40)
    : []
  return {
    version,
    personalBest,
    unlockedArtifacts: arts,
    completedRuns,
  }
}

/**
 * @param {ExpeditionSave} save
 * @param {{ score: number, artifactId?: string|null }} result
 * @returns {ExpeditionSave}
 */
export function applyRunToSave(save, result) {
  const next = normalizeExpeditionSave(save)
  next.completedRuns += 1
  next.personalBest = Math.max(next.personalBest, Math.max(0, result.score | 0))
  if (result.artifactId) {
    if (!next.unlockedArtifacts.includes(result.artifactId)) {
      next.unlockedArtifacts = [...next.unlockedArtifacts, result.artifactId].slice(0, 40)
    }
  }
  return next
}
