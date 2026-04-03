/**
 * CI/local: build web/public/bid_forecast_by_item.json + bid_forecast_meta.json
 * from class_rankings.json (URL or file), guild roster JSON, and web/public/item_stats.json.
 *
 * Env:
 *   CLASS_RANKINGS_URL — required unless --rankings-file (same artifact as VITE_CLASS_RANKINGS_URL)
 *
 * Usage (repo root):
 *   node scripts/build_bid_forecast_by_item.mjs
 *   node scripts/build_bid_forecast_by_item.mjs --rankings-file ./class_rankings.json
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { computeUpgradesForCharacter } from '../web/src/lib/mageloUpgradeEngine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

function normName(s) {
  return (s || '').trim().toLowerCase()
}

function parseArgs(argv) {
  const out = {
    rosterFile: path.join(REPO_ROOT, 'data', 'bid_forecast_roster.json'),
    outByItem: path.join(REPO_ROOT, 'web', 'public', 'bid_forecast_by_item.json'),
    outMeta: path.join(REPO_ROOT, 'web', 'public', 'bid_forecast_meta.json'),
    rankingsFile: null,
    maxPerSlot: 8,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--roster' && argv[i + 1]) {
      out.rosterFile = path.resolve(REPO_ROOT, argv[++i])
    } else if (a === '--out-by-item' && argv[i + 1]) {
      out.outByItem = path.resolve(REPO_ROOT, argv[++i])
    } else if (a === '--out-meta' && argv[i + 1]) {
      out.outMeta = path.resolve(REPO_ROOT, argv[++i])
    } else if (a === '--rankings-file' && argv[i + 1]) {
      out.rankingsFile = path.resolve(REPO_ROOT, argv[++i])
    } else if (a === '--max-per-slot' && argv[i + 1]) {
      out.maxPerSlot = Math.max(1, Math.min(20, parseInt(argv[++i], 10) || 8))
    }
  }
  return out
}

function shortHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

function trimDeltas(deltas) {
  if (!deltas || typeof deltas !== 'object') return null
  const out = {
    hpDelta: deltas.hpDelta,
    manaDelta: deltas.manaDelta,
    acDelta: deltas.acDelta,
    svAllDelta: deltas.svAllDelta,
    svDeltasByType: deltas.svDeltasByType || undefined,
  }
  return JSON.parse(JSON.stringify(out))
}

function normalizeInventory(inv) {
  if (!Array.isArray(inv)) return []
  return inv.map((row) => ({
    slot_id: Number(row.slot_id),
    item_id: row.item_id != null && row.item_id !== '' ? String(row.item_id) : '',
    item_name: row.item_name != null ? String(row.item_name) : '',
  }))
}

async function loadRankingsJson(rankingsFile, rankingsUrl) {
  if (rankingsFile) {
    const raw = fs.readFileSync(rankingsFile, 'utf8')
    return { json: JSON.parse(raw), rawBytes: Buffer.from(raw, 'utf8') }
  }
  const url = (rankingsUrl || process.env.CLASS_RANKINGS_URL || '').trim()
  if (!url) {
    throw new Error('Set CLASS_RANKINGS_URL or pass --rankings-file')
  }
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch class rankings: ${res.status} ${res.statusText}`)
  }
  const raw = await res.text()
  return { json: JSON.parse(raw), rawBytes: Buffer.from(raw, 'utf8') }
}

async function main() {
  const args = parseArgs(process.argv)
  const itemStatsPath = path.join(REPO_ROOT, 'web', 'public', 'item_stats.json')
  if (!fs.existsSync(itemStatsPath)) {
    throw new Error(`Missing ${itemStatsPath}`)
  }
  const itemStatsRaw = fs.readFileSync(itemStatsPath)
  const itemStats = JSON.parse(itemStatsRaw.toString('utf8'))

  if (!fs.existsSync(args.rosterFile)) {
    throw new Error(`Missing roster file ${args.rosterFile} (run scripts/export_bid_forecast_roster.py first)`)
  }
  const rosterPayload = JSON.parse(fs.readFileSync(args.rosterFile, 'utf8'))
  const rosterChars = Array.isArray(rosterPayload.characters) ? rosterPayload.characters : []
  const activityDays = Number(rosterPayload.activity_days) || 120

  const rosterMap = new Map()
  for (const r of rosterChars) {
    const name = (r.name || '').trim()
    const className = (r.class_name || '').trim()
    if (!name) continue
    const key = `${normName(name)}|${normName(className)}`
    rosterMap.set(key, {
      char_id: (r.char_id || '').trim(),
      name,
      class_name: className,
    })
  }

  const { json: rankingsData, rawBytes: rankingsRaw } = await loadRankingsJson(
    args.rankingsFile,
    process.env.CLASS_RANKINGS_URL,
  )

  const classWeights = rankingsData.class_weights || {}
  const focusCandidates = rankingsData.focus_candidates || {}
  const rankingsChars = rankingsData.characters || []

  const ctx = {
    itemStats,
    classWeights,
    focusCandidates,
    spellFociiList: null,
    elementalDisplayNames: {},
  }

  /** @type {Map<string, object>} */
  const bestByCharItem = new Map()

  let processed = 0
  let skippedNoRoster = 0
  let skippedNoWeights = 0

  for (const mageloChar of rankingsChars) {
    const name = (mageloChar.name || '').trim()
    const cls = (mageloChar.class || '').trim()
    if (!name) continue
    const key = `${normName(name)}|${normName(cls)}`
    const roster = rosterMap.get(key)
    if (!roster) {
      skippedNoRoster += 1
      continue
    }
    if (!classWeights[cls] || Object.keys(classWeights[cls]).length === 0) {
      skippedNoWeights += 1
      continue
    }

    const char = {
      name: mageloChar.name,
      class: mageloChar.class,
      inventory: normalizeInventory(mageloChar.inventory),
    }

    const result = computeUpgradesForCharacter(char, args.maxPerSlot, false, ctx)
    if (result.error) {
      continue
    }

    for (const slot of result.bySlot || []) {
      for (const u of slot.upgrades || []) {
        if (u.delta <= 0) continue
        const itemIdStr = String(u.itemId)
        const dedupeKey = `${key}|${itemIdStr}`
        const entry = {
          char_id: roster.char_id || null,
          name: roster.name,
          class_name: roster.class_name,
          slotId: slot.slotId,
          slotName: slot.slotName,
          currentItemId: slot.currentItemId,
          currentItemName: slot.currentItemName || '',
          itemId: u.itemId,
          itemName: u.itemName,
          scoreDelta: u.delta,
          isUpgrade: true,
          eligible: true,
          hpDelta: u.deltas?.hpDelta ?? null,
          manaDelta: u.deltas?.manaDelta ?? null,
          acDelta: u.deltas?.acDelta ?? null,
          focusSpellName: u.focusSpellName || '',
          deltasDetail: trimDeltas(u.deltas),
        }
        const prev = bestByCharItem.get(dedupeKey)
        if (!prev || entry.scoreDelta > prev.scoreDelta) {
          bestByCharItem.set(dedupeKey, entry)
        }
      }
    }
    processed += 1
  }

  /** @type {Record<string, object[]>} */
  const byItem = {}
  for (const entry of bestByCharItem.values()) {
    const id = String(entry.itemId)
    if (!byItem[id]) byItem[id] = []
    byItem[id].push(entry)
  }
  for (const id of Object.keys(byItem)) {
    byItem[id].sort((a, b) => (b.scoreDelta || 0) - (a.scoreDelta || 0))
  }

  const generatedAt = new Date().toISOString()
  const byItemPayload = {
    version: 1,
    generated_at: generatedAt,
    activity_days: activityDays,
    byItem,
  }

  fs.mkdirSync(path.dirname(args.outByItem), { recursive: true })
  fs.writeFileSync(args.outByItem, JSON.stringify(byItemPayload), 'utf8')

  const meta = {
    version: 1,
    generated_at: generatedAt,
    activity_days: activityDays,
    rankings_hash: shortHash(rankingsRaw),
    item_stats_hash: shortHash(itemStatsRaw),
    magelo_characters_total: rankingsChars.length,
    guild_magelo_matched: processed,
    skipped_no_roster_match: skippedNoRoster,
    skipped_no_class_weights: skippedNoWeights,
    upgrade_entries: bestByCharItem.size,
    distinct_items: Object.keys(byItem).length,
  }
  fs.writeFileSync(args.outMeta, JSON.stringify(meta, null, 2), 'utf8')

  console.log(
    JSON.stringify(
      {
        wrote_by_item: args.outByItem,
        wrote_meta: args.outMeta,
        ...meta,
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
