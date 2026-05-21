/**
 * CI/local: fetch class_rankings.json, map guild characters to accounts, push account_class_coverage.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CLASS_RANKINGS_URL (or --rankings-file)
 *
 * Usage (repo root):
 *   node scripts/build_account_class_coverage.mjs
 *   node scripts/build_account_class_coverage.mjs --rankings-file ./class_rankings.json
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import {
  buildAccountCoverage,
  coverageToUpsertRows,
} from '../web/src/lib/classCoverage.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const PAGE_SIZE = 1000
const BATCH = 200

function parseArgs(argv) {
  const out = { rankingsFile: null }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--rankings-file' && argv[i + 1]) {
      out.rankingsFile = path.resolve(REPO_ROOT, argv[++i])
    }
  }
  return out
}

function shortHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

async function loadRankingsJson(rankingsFile) {
  if (rankingsFile) {
    const raw = fs.readFileSync(rankingsFile, 'utf8')
    return { json: JSON.parse(raw), rawBytes: Buffer.from(raw, 'utf8') }
  }
  const url = (process.env.CLASS_RANKINGS_URL || '').trim()
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

function supabaseHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  }
}

async function fetchAllTable(baseUrl, key, table, select) {
  const rows = []
  let offset = 0
  while (true) {
    const url = `${baseUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}&offset=${offset}&limit=${PAGE_SIZE}`
    const res = await fetch(url, { headers: supabaseHeaders(key) })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`${table} fetch ${res.status}: ${body}`)
    }
    const batch = await res.json()
    rows.push(...(batch || []))
    if (!batch || batch.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return rows
}

async function aggregateSpendByCharId(baseUrl, key) {
  const spend = {}
  let offset = 0
  while (true) {
    const url = `${baseUrl}/rest/v1/raid_loot?select=char_id,cost&offset=${offset}&limit=${PAGE_SIZE}`
    const res = await fetch(url, { headers: supabaseHeaders(key) })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`raid_loot fetch ${res.status}: ${body}`)
    }
    const batch = await res.json()
    for (const row of batch || []) {
      const cid = (row.char_id || '').trim()
      if (!cid) continue
      const cost = Number(row.cost) || 0
      spend[cid] = (spend[cid] || 0) + cost
    }
    if (!batch || batch.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return spend
}

async function deleteAllCoverage(baseUrl, key, accountIds) {
  for (let i = 0; i < accountIds.length; i += BATCH) {
    const chunk = accountIds.slice(i, i + BATCH)
    const filter = `account_id=in.(${chunk.map((id) => `"${String(id).replace(/"/g, '')}"`).join(',')})`
    const url = `${baseUrl}/rest/v1/account_class_coverage?${filter}`
    const res = await fetch(url, { method: 'DELETE', headers: supabaseHeaders(key) })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`delete coverage ${res.status}: ${body}`)
    }
  }
}

async function insertCoverageBatch(baseUrl, key, chunk) {
  const url = `${baseUrl}/rest/v1/account_class_coverage`
  const res = await fetch(url, {
    method: 'POST',
    headers: supabaseHeaders(key),
    body: JSON.stringify(chunk),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`insert coverage ${res.status}: ${body}`)
  }
}

async function replaceCoverageTable(baseUrl, key, rows, rankingsHash) {
  const existing = await fetchAllTable(baseUrl, key, 'account_class_coverage', 'account_id')
  const ids = existing.map((r) => r.account_id).filter(Boolean)
  if (ids.length) {
    await deleteAllCoverage(baseUrl, key, ids)
    console.log(`Deleted ${ids.length} existing coverage rows.`)
  }

  const refreshedAt = new Date().toISOString()
  const payload = rows.map((r) => ({
    account_id: r.account_id,
    main_char_id: r.main_char_id,
    classes: r.classes,
    refreshed_at: refreshedAt,
    rankings_hash: rankingsHash,
    meta: r.meta,
  }))

  for (let i = 0; i < payload.length; i += BATCH) {
    await insertCoverageBatch(baseUrl, key, payload.slice(i, i + BATCH))
  }
  console.log(`Inserted ${payload.length} account_class_coverage rows.`)
  return { refreshedAt, count: payload.length }
}

async function main() {
  const args = parseArgs(process.argv)
  const baseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '')
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!baseUrl || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
  }

  const { json: rankingsData, rawBytes } = await loadRankingsJson(args.rankingsFile)
  const rankingsHash = shortHash(rawBytes)
  const rankingsChars = rankingsData.characters || []

  const [links, characters, spendByCharId] = await Promise.all([
    fetchAllTable(baseUrl, key, 'character_account', 'char_id,account_id'),
    fetchAllTable(baseUrl, key, 'characters', 'char_id,name,class_name'),
    aggregateSpendByCharId(baseUrl, key),
  ])

  const built = buildAccountCoverage({
    links,
    characters,
    rankingsChars,
    spendByCharId,
  })

  const rows = coverageToUpsertRows(built)
  const result = await replaceCoverageTable(baseUrl, key, rows, rankingsHash)

  console.log(
    JSON.stringify(
      {
        rankings_hash: rankingsHash,
        magelo_characters_total: rankingsChars.length,
        accounts_with_coverage: result.count,
        refreshed_at: result.refreshedAt,
        stats: built.stats,
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
