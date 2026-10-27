import { useCallback, useState } from 'react'
import { useSWRConfig } from 'swr'
import { supabase } from '../lib/supabase'
import { accountDetailSwrKey } from '../lib/accountDetailMissingScope'
import { usePersistedState } from '../lib/usePersistedState'
import { resolveExpeditionRoster } from '../lib/expedition/rosterLoader'
import {
  startRun,
  commitRound,
  selectBoon,
  selectEventChoice,
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
 * Quarm's Questionable Expedition — fully client-side minigame.
 * @param {{ profile?: { account_id?: string|null }|null, userId?: string|null }} props
 */
export default function Expedition({ profile }) {
  const accountId = profile?.account_id || null
  const { cache } = useSWRConfig()

  const [screen, setScreen] = useState('landing') // landing | party | run
  const [roster, setRoster] = useState(null)
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
      setRoster(result.characters)
      setRosterMeta({
        notice: result.notice,
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
    const state = startRun(party)
    setPartyChars(party)
    setRun(state)
    setScreen('run')
    setActionError(null)
  }

  function bumpRun(next) {
    setRun({ ...next, party: next.party.map((p) => ({ ...p })), enemy: next.enemy ? { ...next.enemy } : null })
  }

  function handleCommit(actions) {
    if (!run) return
    const res = commitRound(run, actions)
    if (!res.ok) {
      setActionError((res.errors || ['Invalid actions']).join(' · '))
      return
    }
    setActionError(null)
    bumpRun(res.state)
    if (res.state.phase === 'rewards' && res.state.report) {
      setSave((prev) => applyRunToSave(prev, {
        score: res.state.report.score,
        artifactId: res.state.report.artifact?.id,
      }))
    }
  }

  function handleBoon(id) {
    if (!run) return
    const res = selectBoon(run, id)
    if (res.ok) bumpRun(res.state)
  }

  function handleEvent(id) {
    if (!run) return
    const res = selectEventChoice(run, id)
    if (res.ok) bumpRun(res.state)
  }

  function playAgain() {
    if (!partyChars) {
      setScreen('party')
      setRun(null)
      return
    }
    const state = restartRun(partyChars)
    setRun(state)
    setActionError(null)
  }

  return (
    <div className="expedition">
      <div className="exp-landing-hero">
        <h1>Quarm&apos;s Questionable Expedition</h1>
        <p className="exp-tagline">Three characters. Terrible leadership. One questionable expedition.</p>
        {screen === 'landing' ? (
          <>
            <p style={{ maxWidth: '36rem', margin: '0 auto 1.25rem', color: 'var(--exp-muted)' }}>
              A short turn-based raid parody. Uses your linked account characters when available.
              No DKP changes. No database writes. Playable offline after roster load.
            </p>
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
          />
        )
      ) : null}

      {screen === 'run' && run && run.phase === 'rewards' && run.report ? (
        <RewardsScreen
          report={run.report}
          personalBest={save.personalBest}
          onPlayAgain={playAgain}
          onLeave={() => {
            setScreen('landing')
            setRun(null)
          }}
        />
      ) : null}

      {screen === 'run' && run && run.phase !== 'rewards' ? (
        <BattleScreen
          state={run}
          onCommit={handleCommit}
          onBoon={handleBoon}
          onEvent={handleEvent}
        />
      ) : null}
    </div>
  )
}
