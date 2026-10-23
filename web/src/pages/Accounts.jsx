import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ACCOUNTS_LIST_CACHE_KEY, createCache } from '../lib/cache'
import { fetchAll } from '../lib/accountData'
import { supabase } from '../lib/supabase'
import { usePersistedState } from '../lib/usePersistedState'
import { compareAccountsByName } from '../lib/accountSort'
import { useScrollContentReady } from '../lib/routeScrollView'
import DkpSiteDisclaimer from '../components/DkpSiteDisclaimer'
import MyDkpStandings from '../components/MyDkpStandings'
import {
  formatCharacterClassSpentLine,
  buildSpentByAccountFromLoot,
  spentForCharacterFromLootMap,
} from '../lib/formatAccountCharacter'

const CACHE_TTL = 10 * 60 * 1000
const MAGELO_BASE = 'https://www.takproject.net/magelo/character.php?char='

function claimedByLabel(names) {
  if (!names?.length) return 'unclaimed'
  return names.map((name) => (name || '').trim() || '—').join(', ')
}

export default function Accounts({ profile }) {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = usePersistedState('/accounts:search', '')
  useScrollContentReady(!loading)

  useEffect(() => {
    const cache = createCache(ACCOUNTS_LIST_CACHE_KEY, CACHE_TTL)
    const cached = cache.get()
    if (cached?.length) {
      setAccounts(cached)
      setLoading(false)
    }

    Promise.all([
      fetchAll('accounts', 'account_id, toon_count, display_name, inactive'),
      fetchAll('character_account', 'account_id, char_id'),
      fetchAll('characters', 'char_id, name, class_name, level'),
      fetchAll(
        'raid_loot_with_assignment',
        'id, char_id, character_name, cost, assigned_char_id, assigned_character_name',
        undefined,
        { order: { column: 'id', ascending: true } },
      ),
      supabase.rpc('account_claim_labels'),
    ]).then(([a, ca, ch, lootRes, claimsRes]) => {
      if (a.error) {
        setError(a.error.message)
        setLoading(false)
        return
      }
      if (ca.error) {
        setError(ca.error.message)
        setLoading(false)
        return
      }
      if (ch.error) {
        setError(ch.error.message)
        setLoading(false)
        return
      }
      if (lootRes.error) {
        setError(lootRes.error.message)
        setLoading(false)
        return
      }
      if (claimsRes.error) {
        setError(claimsRes.error.message)
        setLoading(false)
        return
      }
      const claimsByAccount = {}
      ;(claimsRes.data || []).forEach((row) => {
        const id = row.account_id != null ? String(row.account_id) : ''
        if (!id) return
        if (!claimsByAccount[id]) claimsByAccount[id] = []
        claimsByAccount[id].push(row.display_name)
      })
      const charMap = {}
      ;(ch.data || []).forEach((c) => { charMap[c.char_id] = c })
      const byAccount = {}
      const buyerCharIdToAccountId = {}
      ;(ca.data || []).forEach((row) => {
        if (!byAccount[row.account_id]) byAccount[row.account_id] = []
        byAccount[row.account_id].push(row.char_id)
        const accountId = String(row.account_id)
        const cid = row.char_id != null ? String(row.char_id).trim() : ''
        if (cid) buyerCharIdToAccountId[cid] = accountId
        const cname = (charMap[row.char_id]?.name || '').trim()
        if (cname) buyerCharIdToAccountId[cname] = accountId
      })
      const spentByAccount = buildSpentByAccountFromLoot(lootRes.data || [], buyerCharIdToAccountId)
      const accList = (a.data || []).filter((acc) => !acc.inactive).map((acc) => {
        const rawChars = (byAccount[acc.account_id] || []).map((cid) => charMap[cid]).filter(Boolean)
        const spentMap = spentByAccount[String(acc.account_id)] || {}
        const withSpent = rawChars.map((c) => ({
          ...c,
          dkp_spent: spentForCharacterFromLootMap(spentMap, c),
        }))
        const characters = [...withSpent].sort((x, y) => {
          if (y.dkp_spent !== x.dkp_spent) return y.dkp_spent - x.dkp_spent
          return String(x.name || x.char_id).localeCompare(String(y.name || y.char_id))
        })
        return {
          account_id: acc.account_id,
          toon_count: acc.toon_count,
          display_name: acc.display_name,
          claimed_by: claimedByLabel(claimsByAccount[String(acc.account_id)]),
          char_ids: byAccount[acc.account_id] || [],
          characters,
        }
      })
      accList.sort(compareAccountsByName)
      setAccounts(accList)
      setLoading(false)
      cache.set(accList)
    })
  }, [])

  const filteredAccounts = useMemo(() => {
    if (!search.trim()) return accounts
    const q = search.trim().toLowerCase()
    return accounts.filter((acc) => {
      if ((acc.account_id || '').toLowerCase().includes(q)) return true
      if ((acc.display_name || '').toLowerCase().includes(q)) return true
      if ((acc.claimed_by || '').toLowerCase().includes(q)) return true
      return (acc.characters || []).some((c) => (c.name || c.char_id || '').toLowerCase().includes(q))
    })
  }, [accounts, search])

  if (loading) return <div className="container">Loading accounts…</div>
  if (error) return <div className="container"><span className="error">{error}</span></div>

  return (
    <div className="container">
      <h1>Accounts &amp; characters</h1>
      <DkpSiteDisclaimer />
      <MyDkpStandings accountId={profile?.account_id} />
      <p style={{ color: '#71717a', marginBottom: '1rem' }}>
        All accounts with full character lists. Type a name to find who it is.
      </p>
      <div style={{ marginBottom: '1rem' }}>
        <input
          type="search"
          placeholder="Search by account, display name, claimed by, or character name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: '100%',
            maxWidth: '28rem',
            padding: '0.5rem 0.75rem',
            fontSize: '1rem',
            border: '1px solid #3f3f46',
            borderRadius: '6px',
            background: '#18181b',
            color: '#fafafa',
          }}
          aria-label="Search accounts and characters"
        />
        {search.trim() && (
          <span style={{ marginLeft: '0.5rem', color: '#71717a', fontSize: '0.875rem' }}>
            {filteredAccounts.length} account{filteredAccounts.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className="card">
        <table style={{ tableLayout: 'fixed', width: '100%' }}>
          <colgroup>
            <col style={{ width: '10rem' }} />
            <col style={{ width: '14rem' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Claimed by</th>
              <th>Account</th>
              <th>Characters</th>
            </tr>
          </thead>
          <tbody>
            {filteredAccounts.map((acc) => {
              const chars = acc.characters || []
              return (
                <tr key={acc.account_id} data-scroll-anchor={acc.account_id}>
                  <td style={{ verticalAlign: 'top', color: acc.claimed_by === 'unclaimed' ? '#71717a' : undefined }}>
                    {acc.claimed_by}
                  </td>
                  <td style={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                    <Link to={`/accounts/${acc.account_id}`}>
                      {acc.display_name?.trim() || acc.characters?.[0]?.name || acc.account_id}
                    </Link>
                    <span style={{ marginLeft: '0.5rem', color: '#71717a', fontSize: '0.875rem' }}>
                      <code>{acc.account_id}</code>
                      {` · ${chars.length} toons`}
                    </span>
                  </td>
                  <td style={{ verticalAlign: 'top', minWidth: 0 }}>
                    {chars.length === 0 ? (
                      <span style={{ color: '#71717a' }}>—</span>
                    ) : (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '0.35rem 1rem',
                          alignItems: 'baseline',
                          minWidth: 0,
                          overflowWrap: 'break-word',
                        }}
                      >
                        {chars.map((c, i) => {
                          const name = c.name || c.char_id
                          const mageloUrl = `${MAGELO_BASE}${encodeURIComponent(name)}`
                          const spent = c.dkp_spent ?? 0
                          const classSpentLine = formatCharacterClassSpentLine(c, spent)
                          return (
                            <span
                              key={c.char_id}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                flexWrap: 'wrap',
                                flexShrink: 0,
                              }}
                            >
                              {i > 0 && <span style={{ color: '#52525b', marginRight: '0.25rem' }}>·</span>}
                              <Link to={`/characters/${encodeURIComponent(name)}`}>{name}</Link>
                              <span style={{ color: '#71717a', fontSize: '0.875rem' }}>
                                {classSpentLine}
                              </span>
                              <a
                                href={mageloUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ fontSize: '0.8rem', color: '#a78bfa', whiteSpace: 'nowrap' }}
                                title={`Magelo: ${name}`}
                              >
                                Magelo
                              </a>
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
