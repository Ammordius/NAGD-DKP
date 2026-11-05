/**
 * Conservative 1–2 character soft match against in-memory JSON catalog names.
 * Not for Supabase / SQL paths.
 */

/**
 * Levenshtein edit distance.
 * @param {string} a
 * @param {string} b
 */
export function editDistance(a, b) {
  const s = String(a || '')
  const t = String(b || '')
  if (s === t) return 0
  const n = s.length
  const m = t.length
  if (!n) return m
  if (!m) return n
  /** @type {number[]} */
  let prev = Array.from({ length: m + 1 }, (_, j) => j)
  for (let i = 1; i <= n; i++) {
    /** @type {number[]} */
    const cur = [i]
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[m]
}

/**
 * Max allowed edits for a string length.
 * @param {number} len
 */
export function maxEditsForLength(len) {
  if (len < 4) return 0
  if (len <= 7) return 1
  return 2
}

/**
 * Soft-match a query against candidate names (1–2 char miss/swap).
 * @param {string} hint
 * @param {Array<{ name: string, itemId?: string|number|null, id?: string|number|null }|string>} candidates
 * @returns {{
 *   unique?: { name: string, itemId?: string|number|null },
 *   ambiguous?: Array<{ name: string, itemId?: string|number|null }>,
 * }|null}
 */
export function softMatchNames(hint, candidates) {
  const q = String(hint || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!q || q.length < 4) return null

  /** @type {Map<string, { name: string, itemId?: string|number|null, dist: number }>} */
  const hits = new Map()

  for (const c of candidates || []) {
    const name = typeof c === 'string' ? c : c?.name
    if (!name) continue
    const n = String(name)
      .trim()
      .toLowerCase()
      .replace(/[^\w\s'-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!n) continue

    let dist = editDistance(q, n)
    const maxWhole = Math.max(maxEditsForLength(q.length), maxEditsForLength(n.length))
    let ok = dist > 0 && dist <= maxWhole

    // Token-aware: same token count, each token within 1 edit (or exact), total ≤ 2
    if (!ok) {
      const qt = q.split(/\s+/).filter(Boolean)
      const nt = n.split(/\s+/).filter(Boolean)
      if (qt.length === nt.length && qt.length >= 2) {
        let sum = 0
        let tokenOk = true
        for (let i = 0; i < qt.length; i++) {
          const d = editDistance(qt[i], nt[i])
          if (d > 1) {
            tokenOk = false
            break
          }
          sum += d
        }
        if (tokenOk && sum > 0 && sum <= 2) {
          ok = true
          dist = sum
        }
      }
    }

    if (!ok) continue
    const itemId = typeof c === 'string' ? null : (c.itemId ?? c.id ?? null)
    const prev = hits.get(n)
    if (!prev || dist < prev.dist) {
      hits.set(n, { name: String(name).trim(), itemId, dist })
    }
  }

  const list = [...hits.values()].sort((a, b) => a.dist - b.dist || a.name.localeCompare(b.name))
  if (!list.length) return null
  const best = list[0].dist
  const top = list.filter((h) => h.dist === best)
  if (top.length === 1) {
    return { unique: { name: top[0].name, itemId: top[0].itemId ?? null } }
  }
  return {
    ambiguous: top.slice(0, 8).map((h) => ({ name: h.name, itemId: h.itemId ?? null })),
  }
}
