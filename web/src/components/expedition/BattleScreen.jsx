import { useEffect, useState } from 'react'
import { getClassDef } from '../../lib/expedition/classDefinitions.js'
import { availableActions } from '../../lib/expedition/gameEngine.js'

const ENEMY_SYMBOLS = {
  entrance_guards: '🛡',
  endless_trash: '👻',
  mini_boss: '😈',
  loot_officer: '📋',
  final_prep: '🔥',
  quarm: '🐉',
}

/**
 * @param {{
 *   state: object,
 *   onCommit: (actions: Record<string, { actionId: string, targetId?: string }>) => void,
 *   onBoon: (id: string) => void,
 *   onEvent: (id: string) => void,
 * }} props
 */
export default function BattleScreen({ state, onCommit, onBoon, onEvent }) {
  const living = state.party.filter((p) => p.alive)
  const [draft, setDraft] = useState(() => initialDraft(state))

  const draftKey = `${state.encounterIndex}-${state.round}-${state.phase}`
  useEffect(() => {
    setDraft(initialDraft(state))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  if (state.phase === 'boon' && state.boonChoices) {
    return (
      <div className="exp-panel">
        <h2>Temporary boon</h2>
        <p className="exp-tagline">Choose one. Effects last only for this run.</p>
        <div className="exp-boon-grid">
          {state.boonChoices.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`exp-boon${b.risk ? ' is-risk' : ''}`}
              onClick={() => onBoon(b.id)}
            >
              <strong>{b.name}</strong>
              <p className="meta" style={{ margin: '0.35rem 0 0', color: 'var(--exp-muted)' }}>{b.description}</p>
              {b.risk ? <span className="exp-status">Risky</span> : null}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (state.phase === 'event' && state.eventChoices) {
    const ev = state.eventChoices
    return (
      <div className="exp-panel">
        <h2>{ev.title}</h2>
        <p>{ev.description}</p>
        <div className="exp-action-row" style={{ marginTop: '0.75rem' }}>
          {ev.choices.map((c) => (
            <button key={c.id} type="button" className="exp-btn is-primary" onClick={() => onEvent(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  const enemy = state.enemy
  const hpPct = enemy ? Math.max(0, (enemy.hp / enemy.maxHp) * 100) : 0
  const allReady = living.every((p) => draft[p.id]?.actionId)

  return (
    <div>
      <div className="exp-panel exp-enemy">
        <p className="exp-status">
          Encounter {state.encounterIndex + 1}/6 · Round {state.round}
        </p>
        <div className="exp-enemy-portrait" aria-hidden="true">
          {ENEMY_SYMBOLS[enemy?.id] || '⚔'}
        </div>
        <h2 style={{ margin: '0 0 0.35rem' }}>{enemy?.title || enemy?.name}</h2>
        <p className="exp-tagline" style={{ marginBottom: '0.5rem' }}>{enemy?.flavor}</p>
        <div className="exp-hp is-enemy" aria-label={`Enemy health ${enemy?.hp} of ${enemy?.maxHp}`}>
          <span style={{ width: `${hpPct}%` }} />
        </div>
        <p className="exp-status" style={{ marginTop: '0.25rem' }}>
          {enemy?.hp} / {enemy?.maxHp} HP
        </p>
        <p className="exp-intent" role="status">
          Intent: {state.intent?.label || 'Unknown'}
        </p>
      </div>

      <div className="exp-grid" style={{ marginBottom: '1rem' }}>
        {state.party.map((p) => {
          const def = getClassDef(p.class_name)
          const pct = Math.max(0, (p.hp / p.maxHp) * 100)
          return (
            <div
              key={p.id}
              className={`exp-combatant${!p.alive ? ' is-down' : ''}`}
              aria-label={`${p.name} ${p.hp} of ${p.maxHp} HP`}
            >
              <span className="exp-class-badge" style={{ color: def.color }}>
                <span aria-hidden="true">{def.symbol}</span> {def.abbrev}
              </span>
              <div className="name">{p.name}</div>
              <div className="exp-hp" style={{ margin: '0.35rem 0' }}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <div className="exp-status">
                {p.alive ? `${p.hp}/${p.maxHp}` : 'KO'}
                {(p.statuses || []).map((s) => ` · ${s.id}`).join('')}
              </div>
            </div>
          )
        })}
      </div>

      <div className="exp-panel exp-actions">
        <strong>Actions</strong>
        {living.map((p) => {
          const opts = availableActions(state, p)
          const current = draft[p.id] || {}
          const needsTarget = opts.find((o) => o.id === current.actionId)?.needsAllyTarget
          return (
            <div key={p.id} className="exp-action-row">
              <span className="who">{p.name}</span>
              {opts.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`exp-btn${current.actionId === o.id ? ' is-active' : ''}`}
                  title={o.description}
                  aria-pressed={current.actionId === o.id}
                  onClick={() => setDraft((d) => ({
                    ...d,
                    [p.id]: { ...d[p.id], actionId: o.id },
                  }))}
                >
                  {o.name}
                </button>
              ))}
              {needsTarget ? (
                <label className="exp-status">
                  Target{' '}
                  <select
                    value={current.targetId || ''}
                    onChange={(e) => setDraft((d) => ({
                      ...d,
                      [p.id]: { ...d[p.id], targetId: e.target.value },
                    }))}
                    aria-label={`Heal target for ${p.name}`}
                  >
                    <option value="">Select…</option>
                    {living.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
          )
        })}
        <button
          type="button"
          className="exp-btn is-primary"
          disabled={!allReady}
          onClick={() => onCommit(draft)}
        >
          Resolve round
        </button>
      </div>

      <div className="exp-panel">
        <strong>Combat log</strong>
        <div className="exp-log" aria-live="polite">
          {[...state.log].reverse().map((line, i) => (
            <div key={`${state.turns}-${i}`}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

function initialDraft(state) {
  /** @type {Record<string, { actionId: string, targetId?: string }>} */
  const d = {}
  for (const p of state.party.filter((x) => x.alive)) {
    const opts = availableActions(state, p)
    const first = opts[0]
    if (!first) continue
    d[p.id] = {
      actionId: first.id,
      targetId: first.needsAllyTarget ? (state.party.find((x) => x.alive)?.id) : undefined,
    }
  }
  return d
}
