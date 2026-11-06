/**
 * Minimal chainable Supabase mock for discovery fetch tests.
 */

import {
  FIXTURE_RAIDS,
  FIXTURE_CLASSIFICATIONS,
  FIXTURE_LOOT_BY_RAID,
  FIXTURE_CHARACTERS,
  fixtureHistoryRows,
} from './fixtures.js'

/**
 * @param {{ callLog?: object[], classifications?: object[]|null }} [opts]
 */
export function createDiscoveryMockClient(opts = {}) {
  const callLog = opts.callLog || []
  const history = fixtureHistoryRows()
  const classifications = opts.classifications != null ? opts.classifications : FIXTURE_CLASSIFICATIONS

  function table(name) {
    /** @type {object} */
    const state = {
      name,
      filters: /** @type {Array<{ type: string, col?: string, val?: unknown }>} */ ([]),
      selectCols: '*',
      orderSpecs: [],
      limitN: null,
      head: false,
      countExact: false,
    }

    const api = {
      select(cols, opts2 = {}) {
        state.selectCols = cols
        state.head = Boolean(opts2.head)
        state.countExact = opts2.count === 'exact'
        callLog.push({ table: name, op: 'select', cols, opts: opts2 })
        return api
      },
      eq(col, val) {
        state.filters.push({ type: 'eq', col, val })
        return api
      },
      in(col, val) {
        state.filters.push({ type: 'in', col, val })
        return api
      },
      ilike(col, val) {
        state.filters.push({ type: 'ilike', col, val })
        return api
      },
      gte(col, val) {
        state.filters.push({ type: 'gte', col, val })
        return api
      },
      lte(col, val) {
        state.filters.push({ type: 'lte', col, val })
        return api
      },
      order(col, opts2 = {}) {
        state.orderSpecs.push({ col, ...opts2 })
        return api
      },
      limit(n) {
        state.limitN = n
        callLog.push({ table: name, op: 'limit', n })
        return api
      },
      maybeSingle() {
        return Promise.resolve(finalize(true))
      },
      then(resolve, reject) {
        return Promise.resolve(finalize(false)).then(resolve, reject)
      },
    }

    function finalize(single) {
      callLog.push({ table: name, op: 'execute', filters: [...state.filters], limit: state.limitN })
      if (name === 'raid_classifications') {
        let rows = [...classifications]
        for (const f of state.filters) {
          if (f.type === 'eq' && f.col === 'zone') rows = rows.filter((r) => r.zone === f.val)
          if (f.type === 'eq' && f.col === 'mob') rows = rows.filter((r) => r.mob === f.val)
          if (f.type === 'in' && f.col === 'mob') {
            const set = new Set(f.val)
            rows = rows.filter((r) => set.has(r.mob))
          }
        }
        if (state.limitN != null) rows = rows.slice(0, state.limitN)
        return { data: rows, error: null, count: rows.length }
      }
      if (name === 'raids') {
        let rows = [...FIXTURE_RAIDS]
        for (const f of state.filters) {
          if (f.type === 'in' && f.col === 'raid_id') {
            const set = new Set(f.val)
            rows = rows.filter((r) => set.has(r.raid_id))
          }
          if (f.type === 'eq' && f.col === 'raid_id') rows = rows.filter((r) => r.raid_id === f.val)
        }
        rows.sort((a, b) => String(b.date_iso).localeCompare(String(a.date_iso)))
        if (state.limitN != null) rows = rows.slice(0, state.limitN)
        if (single) return { data: rows[0] || null, error: null }
        return { data: rows, error: null }
      }
      if (name === 'raid_loot_with_assignment') {
        let rows = []
        for (const f of state.filters) {
          if (f.type === 'eq' && f.col === 'raid_id') {
            rows = (FIXTURE_LOOT_BY_RAID[f.val] || []).map((r) => ({
              ...r,
              assigned_char_id: r.assigned_char_id ?? r.char_id ?? null,
              assigned_character_name: r.assigned_character_name ?? r.character_name ?? null,
            }))
          }
        }
        if (state.limitN != null) rows = rows.slice(0, state.limitN)
        return { data: rows, error: null }
      }
      if (name === 'characters') {
        let rows = [...FIXTURE_CHARACTERS]
        for (const f of state.filters) {
          if (f.type === 'in' && f.col === 'char_id') {
            const set = new Set((f.val || []).map((v) => String(v)))
            rows = rows.filter((r) => set.has(String(r.char_id)))
          }
          if (f.type === 'eq' && f.col === 'char_id') {
            rows = rows.filter((r) => String(r.char_id) === String(f.val))
          }
        }
        return { data: rows, error: null }
      }
      if (name === 'raid_loot_history') {
        let rows = [...history]
        for (const f of state.filters) {
          if (f.type === 'ilike' && f.col === 'item_name') {
            const pat = String(f.val).toLowerCase()
            rows = rows.filter((r) => String(r.item_name).toLowerCase() === pat)
          }
          if (f.type === 'ilike' && f.col === 'character_name') {
            const pat = String(f.val).toLowerCase()
            rows = rows.filter((r) => String(r.character_name).toLowerCase() === pat)
          }
          if (f.type === 'in' && f.col === 'raid_id') {
            const set = new Set(f.val)
            rows = rows.filter((r) => set.has(r.raid_id))
          }
          if (f.type === 'gte' && f.col === 'date_iso') {
            rows = rows.filter((r) => String(r.date_iso) >= String(f.val))
          }
          if (f.type === 'lte' && f.col === 'date_iso') {
            rows = rows.filter((r) => String(r.date_iso) <= String(f.val))
          }
        }
        rows.sort((a, b) => String(b.date_iso).localeCompare(String(a.date_iso)))
        if (state.head && state.countExact) {
          return { data: null, error: null, count: rows.length }
        }
        if (state.limitN != null) rows = rows.slice(0, state.limitN)
        return { data: rows, error: null, count: rows.length }
      }
      if (name === 'raid_loot') {
        let rows = history.map((r) => ({ id: r.id, item_name: r.item_name, raid_id: r.raid_id }))
        for (const f of state.filters) {
          if (f.type === 'ilike' && f.col === 'item_name') {
            const pat = String(f.val).toLowerCase()
            rows = rows.filter((r) => String(r.item_name).toLowerCase() === pat)
          }
        }
        if (state.head && state.countExact) {
          return { data: null, error: null, count: rows.length }
        }
        return { data: rows, error: null, count: rows.length }
      }
      return { data: [], error: null }
    }

    return api
  }

  return {
    callLog,
    from(name) {
      callLog.push({ op: 'from', table: name })
      return table(name)
    },
  }
}
