import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import useSWR from 'swr'
import { useDkpData } from '../lib/dkpLeaderboard'
import { loadAccountActivity } from '../lib/accountData'
import { formatMyDkpTotal, formatRaidDkpEarned, MISSING_DKP_NOTE, mostRecentAttendedRaid, reconcileAccountDkp } from '../lib/accountDkpTotals'

const ACTIVITY_DEDUPING_MS = 60_000

export function claimedAccountId(accountId) {
  if (accountId == null) return ''
  return String(accountId).trim()
}

/**
 * DKP total for the signed-in user's claimed account, using the account page formula.
 * Pass activityByRaid when the page already loaded it (profile) so we don't fetch twice.
 */
export function useMyAccountDkp(accountId, { activityByRaid, activityReady } = {}) {
  const id = claimedAccountId(accountId)
  const provided = activityByRaid !== undefined
  const { accountTotalsByAccountId, apiData, isLoading: summaryLoading, error: summaryError } = useDkpData(undefined, { enabled: Boolean(id) })
  const { data, error: activityFetchError, isLoading: activityLoading } = useSWR(
    !provided && id ? `my-account-activity-${id}` : null,
    () => loadAccountActivity(id),
    { dedupingInterval: ACTIVITY_DEDUPING_MS, revalidateOnFocus: false, revalidateOnReconnect: false },
  )
  const raids = provided ? (activityByRaid || []) : (data?.activityByRaid || [])
  const raidsReady = provided ? activityReady !== false : !activityLoading
  const activityError = provided ? '' : (data?.error || activityFetchError?.message || '')
  const totals = useMemo(() => {
    if (!id || !raidsReady) return null
    return reconcileAccountDkp(accountTotalsByAccountId?.[id], raids)
  }, [id, raidsReady, accountTotalsByAccountId, raids])
  const recentRaid = useMemo(
    () => (id && raidsReady ? mostRecentAttendedRaid(raids) : null),
    [id, raidsReady, raids],
  )
  const loading = Boolean(id) && (summaryLoading || !raidsReady)
  const failed = Boolean(id) && !loading && Boolean(summaryError) && Boolean(activityError)
  const claimedName = useMemo(() => claimedAccountName(id, apiData?.accounts), [id, apiData?.accounts])
  return { accountId: id, claimedName, totals, recentRaid, loading, failed }
}

export function claimedAccountName(accountId, accounts) {
  const id = claimedAccountId(accountId)
  if (!id) return ''
  const row = (accounts || []).find((acc) => String(acc?.account_id) === id)
  return row?.display_name?.trim()
    || String(row?.toon_names || '').split(',')[0]?.trim()
    || id
}

function ClaimedAccountLine({ accountId, claimedName }) {
  if (!accountId) return null
  return (
    <p style={{ marginTop: 0, marginBottom: '0.5rem' }}>
      You have claimed account{' '}
      <Link to={`/accounts/${accountId}`}>{claimedName || accountId}</Link>
      {' '}(<code>{accountId}</code>).
    </p>
  )
}

export function MyDkpStandingsView({ accountId, claimedName, totals, recentRaid, loading, failed, showClaimPrompt = false }) {
  if (!accountId) {
    if (!showClaimPrompt) return null
    return (
      <p style={{ color: '#a1a1aa' }}>
        Claim your account from <Link to="/accounts">Game Accounts</Link> to display your current DKP standings. Open your game account and choose Claim this account.
      </p>
    )
  }
  if (loading || !totals) {
    return (
      <div style={{ marginBottom: '1rem' }}>
        <ClaimedAccountLine accountId={accountId} claimedName={claimedName} />
        <p style={{ color: '#71717a' }}>Loading your DKP…</p>
      </div>
    )
  }
  if (failed) {
    return (
      <div style={{ marginBottom: '1rem' }}>
        <ClaimedAccountLine accountId={accountId} claimedName={claimedName} />
        <p style={{ color: '#f87171' }}>Couldn&apos;t load your DKP standings.</p>
      </div>
    )
  }
  const line = formatMyDkpTotal(totals)
  const balance = Number(totals.balance).toFixed(0)
  const marker = `Your DKP total is: ${balance}`
  const marked = line.startsWith(marker)
  const earned = Math.round(Number(recentRaid?.dkpEarned) || 0)
  const raidTotal = Math.round(Number(recentRaid?.dkpRaidTotal) || 0)
  const missedTic = Boolean(recentRaid) && raidTotal > earned
  const raidTitle = recentRaid?.raid_name?.trim() || ''
  const raidLabel = recentRaid
    ? [raidTitle, recentRaid.date].filter(Boolean).join(' ')
    : ''
  return (
    <div style={{ marginBottom: '1rem' }}>
      <ClaimedAccountLine accountId={accountId} claimedName={claimedName} />
      <p className="my-dkp-total">
        {marked ? (
          <>
            <span className="my-dkp-total-label">Your DKP total is:</span>
            <strong className="my-dkp-total-value">{balance}</strong>
            <span className="my-dkp-total-detail">{line.slice(marker.length)}</span>
          </>
        ) : line}
      </p>
      {recentRaid ? (
        <>
          <p style={{ color: '#a1a1aa', margin: '0.35rem 0' }}>
            Your most recent attended raid was:{' '}
            <Link to={`/raids/${recentRaid.raid_id}`}>{raidLabel || 'Raid'}</Link>
          </p>
          <p style={{ color: missedTic ? '#f59e0b' : '#a1a1aa', margin: '0.35rem 0' }}>
            {formatRaidDkpEarned(recentRaid)}
          </p>
        </>
      ) : (
        <p style={{ color: '#a1a1aa', margin: '0.35rem 0' }}>You have not attended a raid yet.</p>
      )}
      <p style={{ color: '#71717a', margin: '0.35rem 0 0', fontSize: '0.875rem' }}>{MISSING_DKP_NOTE}</p>
    </div>
  )
}

export default function MyDkpStandings({ accountId, claimedName, showClaimPrompt = false, activityByRaid, activityReady }) {
  const state = useMyAccountDkp(accountId, { activityByRaid, activityReady })
  return (
    <MyDkpStandingsView
      {...state}
      claimedName={claimedName || state.claimedName}
      showClaimPrompt={showClaimPrompt}
    />
  )
}
