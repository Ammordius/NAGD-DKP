import { useCallback, useEffect, useState } from 'react'
import { useSWRConfig } from 'swr'
import { supabase } from '../lib/supabase'
import { accountDetailSwrKey } from '../lib/accountDetailMissingScope'
import { usePersistedState } from '../lib/usePersistedState'
import { resolveExpeditionRoster } from '../lib/expedition/rosterLoader'
import { loadCombatProfiles, clearCombatProfileCache } from '../lib/expedition/combatProfile'
import {
  startRun,
  commitRound,
  selectBoon,
  selectEventChoice,
  selectRoute,
  selectConsumable,
  restartRun,
} from '../lib/expedition/gameEngine'
import {
  emptyExpeditionSave,
  normalizeExpeditionSave,
  applyRunToSave,
} from '../lib/expedition/persistence'
import PartySelection from '../components/expedition/PartySelection'
import BattleScreen from '../components/expedition/BattleScreen'
import RewardsScreen from '../components/expedition/RewardsScreen'
import '../styles/expedition.css'

/**
 * @param {{ profile?: { account_id?: string|null }|null, userId?: string|null }} props
 */
export default function Expedition({ profile, userId }) {
  const accountId = profile?.account_id || null
  const { cache } = useSWRConfig()

  const [screen, setScreen] = useState('landing')
  const [difficulty, setDifficulty] = useState('normal')
  const [roster, setRoster] = useState(null)
  const [profiles, setProfiles] = useState(null)
  const [rosterMeta, setRosterMeta] = useState({ notice: null, fictional: false, loading: false, error: null })
  const [selectedIds, setSelectedIds] = useState([])
  const [run, setRun] = useState(null)
  const [partyChars, setPartyChars] = useState(null)
  const [actionError, setActionError] = useState(null)

  const saveKey = `/games/expedition:save:${accountId || 'unclaimed'}`
  const [save, setSave] = usePersistedState(saveKey, emptyExpeditionSave(), normalizeExpeditionSave)

  const assembleParty = useCallback(async () => {
    setRosterMeta((m) => ({ ...m, loading: true, error: null }))
    setScreen('party')
    try {
      const swrKey = accountId ? accountDetailSwrKey(accountId, false) : null
      const swrEntry = swrKey ? cache.get(swrKey) : null
      const result = await resolveExpeditionRoster({
        accountId,
        swrData: swrEntry,
        sessionStorage: typeof sessionStorage !== 'undefined' ? sessionStorage : undefined,
        client: supabase,
        allowNetwork: true,
      })
      // Static Magelo profiles — one fetch, not Supabase; cached for session
      const map = await loadCombatProfiles()
      setProfiles(map)
      setRoster(result.characters)
      const geared = result.characters.filter((c) => map.has(String(c.name).toLowerCase())).length
      const gearNote = result.fictional
        ? null
        : geared
          ? `Magelo combat profiles matched for ${geared}/${result.characters.length} characters.`
          : 'No Magelo combat profiles matched — using class and level only.'
      setRosterMeta({
        notice: [result.notice, gearNote].filter(Boolean).join(' '),
        fictional: result.fictional,
        loading: false,
        error: null,
      })
      setSelectedIds(result.characters.slice(0, Math.min(3, result.characters.length)).map((c) => c.char_id))
    } catch (e) {
      setRosterMeta({
        notice: 'Could not assemble a roster.',
        fictional: true,
        loading: false,
        error: e?.message || 'error',
      })
    }
  }, [accountId, cache])

  function toggleChar(charId) {
    setSelectedIds((ids) => {
      if (ids.includes(charId)) return ids.filter((id) => id !== charId)
      if (ids.length >= 3) return ids
      return [...ids, charId]
    })
  }

  function beginExpedition(party) {
    const state = startRun(party, { difficulty, profiles })
    setPartyChars(party)
    setRun(state)
    setScreen('run')
    setActionError(null)
  }

  function bumpRun(next) {
    setRun({
      ...next,
      party: next.party.map((p) => ({ ...p, statuses: [...(p.statuses || [])], cooldowns: { ...p.cooldowns } })),
      enemies: (next.enemies || []).map((e) => ({ ...e, statuses: [...(e.statuses || [])] })),
      intents: { ...(next.intents || {}) },
      consumables: { ...(next.consumables || {}) },
    })
  }

  function maybeSave(next) {
    if (next.phase === 'rewards' && next.report) {
      setSave((prev) => applyRunToSave(prev, {
        score: next.report.score,
        artifactId: next.report.artifact?.id,
      }))
    }
  }

  function handleCommit(actions, extras) {
    if (!run) return
    const res = commitRound(run, actions, extras)
    if (!res.ok) {
      setActionError((res.errors || ['Invalid actions']).join(' · '))
      return
    }
    setActionError(null)
    bumpRun(res.state)
    maybeSave(res.state)
  }

  function wrapSelect(fn, arg) {
    if (!run) return
    const res = fn(run, arg)
    if (res.ok) {
      bumpRun(res.state)
      maybeSave(res.state)
    }
  }

  function playAgain() {
    if (!partyChars) {
      setScreen('party')
      setRun(null)
      return
    }
    setRun(restartRun(partyChars, { difficulty, profiles }))
    setActionError(null)
  }

  function leaveToLanding() {
    setScreen('landing')
    setRun(null)
  }

  useEffect(() => {
    setRun(null)
    setRoster(null)
    setScreen('landing')
    setSelectedIds([])
    setPartyChars(null)
  }, [userId, accountId])

  return (
    <div className="expedition" data-user={userId || ''} data-account={accountId || ''}>
      <div className="exp-landing-hero">
        <h1>Quarm&apos;s Questionable Expedition</h1>
        <p className="exp-tagline">Three characters. Terrible leadership. One questionable expedition.</p>
        {screen === 'landing' ? (
          <>
            <p style={{ maxWidth: '36rem', margin: '0 auto 1.25rem', color: 'var(--exp-muted)' }}>
              A tactical raid parody. Real class, level, and Magelo-derived gear when available.
              Six abilities per class. No DKP changes. No database writes.
            </p>
            <div className="exp-action-row" style={{ justifyContent: 'center', marginBottom: '1rem' }}>
              {['normal', 'heroic', 'reckless'].map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`exp-btn${difficulty === d ? ' is-active' : ''}`}
                  onClick={() => setDifficulty(d)}
                >
                  {d}
                </button>
              ))}
            </div>
            {save.personalBest > 0 ? (
              <p className="exp-status">Personal best: {save.personalBest} · Runs: {save.completedRuns}</p>
            ) : null}
            <button type="button" className="exp-btn is-primary" onClick={assembleParty}>
              Assemble Your Party
            </button>
          </>
        ) : null}
      </div>

      {run?.narrator ? (
        <div className="exp-narrator" aria-live="polite">
          <strong>DKP Inquisitor</strong>
          {run.narrator}
        </div>
      ) : null}

      {actionError ? <p className="error" role="alert">{actionError}</p> : null}

      {screen === 'party' ? (
        rosterMeta.loading || !roster ? (
          <p className="exp-notice">Loading roster…</p>
        ) : (
          <PartySelection
            roster={roster}
            selectedIds={selectedIds}
            onToggle={toggleChar}
            onStart={beginExpedition}
            notice={rosterMeta.notice}
            fictionalRoster={rosterMeta.fictional}
            profiles={profiles}
          />
        )
      ) : null}

      {screen === 'run' && run && run.phase === 'rewards' && run.report ? (
        <RewardsScreen
          report={run.report}
          personalBest={save.personalBest}
          onPlayAgain={playAgain}
          onLeave={leaveToLanding}
        />
      ) : null}

      {screen === 'run' && run && run.phase !== 'rewards' ? (
        <BattleScreen
          state={run}
          onCommit={handleCommit}
          onBoon={(id) => wrapSelect(selectBoon, id)}
          onEvent={(id) => wrapSelect(selectEventChoice, id)}
          onRoute={(id) => wrapSelect(selectRoute, id)}
          onConsumable={(take) => wrapSelect(selectConsumable, take)}
        />
      ) : null}
    </div>
  )
}

// Re-export for tests that clear on sign-out simulation
export { clearCombatProfileCache }
