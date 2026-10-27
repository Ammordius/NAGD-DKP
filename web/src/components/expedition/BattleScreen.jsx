import { useEffect, useState } from 'react'
import { getClassDef } from '../../lib/expedition/classDefinitions.js'
import { availableActions, RAID_COMMANDS } from '../../lib/expedition/gameEngine.js'

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
 *   onCommit: (actions: object, extras?: object) => void,
 *   onBoon: (id: string) => void,
 *   onEvent: (id: string) => void,
 *   onRoute: (id: string) => void,
 *   onConsumable: (take: boolean) => void,
 * }} props
 */
export default function BattleScreen({ state, onCommit, onBoon, onEvent, onRoute, onConsumable }) {
  const living = state.party.filter((p) => p.alive)
  const [draft, setDraft] = useState(() => initialDraft(state))
  const [activeId, setActiveId] = useState(living[0]?.id || null)
  const [tab, setTab] = useState('offensive')
  const [commandId, setCommandId] = useState('')
  const draftKey = `${state.encounterIndex}-${state.round}-${state.phase}`

  useEffect(() => {
    setDraft(initialDraft(state))
    const live = state.party.filter((p) => p.alive)
    setActiveId(live[0]?.id || null)
  }, [draftKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (state.phase === 'route' && state.routeChoices) {
    return (
      <div className="exp-panel">
        <h2>Choose your route</h2>
        <div className="exp-boon-grid">
          {state.routeChoices.map((r) => (
            <button key={r.id} type="button" className="exp-boon" onClick={() => onRoute(r.id)}>
              <strong>{r.name}</strong>
              <p className="meta" style={{ margin: '0.35rem 0 0', color: 'var(--exp-muted)' }}>{r.description}</p>
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (state.phase === 'boon' && state.boonChoices) {
    return (
      <div className="exp-panel">
        <h2>Temporary boon</h2>
        <div className="exp-boon-grid">
          {state.boonChoices.map((b) => (
            <button key={b.id} type="button" className={`exp-boon${b.risk ? ' is-risk' : ''}`} onClick={() => onBoon(b.id)}>
              <strong>{b.name}</strong>
              <p className="meta" style={{ margin: '0.35rem 0 0', color: 'var(--exp-muted)' }}>{b.description}</p>
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
            <button key={c.id} type="button" className="exp-btn is-primary" onClick={() => onEvent(c.id)}>{c.label}</button>
          ))}
        </div>
      </div>
    )
  }

  if (state.phase === 'consumable') {
    return (
      <div className="exp-panel">
        <h2>Expedition supply</h2>
        <p>Take a <strong>{state.consumableOffer}</strong>? (Game-only — not real DKP.)</p>
        <div className="exp-action-row">
          <button type="button" className="exp-btn is-primary" onClick={() => onConsumable(true)}>Take it</button>
          <button type="button" className="exp-btn" onClick={() => onConsumable(false)}>Leave it</button>
        </div>
      </div>
    )
  }

  const enemies = state.enemies || []
  const active = state.party.find((p) => p.id === activeId) || living[0]
  const opts = active ? availableActions(state, active).filter((o) => !tab || o.group === tab || o.tags?.includes('universal')) : []
  const allReady = living.every((p) => draft[p.id]?.actionId)

  return (
    <div>
      <div className="exp-panel">
        <p className="exp-status">
          Encounter {state.encounterIndex + 1}/6 · Round {state.round} · CP {state.commandPoints || 0}
          {state.difficulty ? ` · ${state.difficulty}` : ''}
        </p>
        <div className="exp-grid">
          {enemies.map((enemy) => {
            const hpPct = Math.max(0, (enemy.hp / enemy.maxHp) * 100)
            const intent = state.intents?.[enemy.id]
            const phase = enemy.phases ? enemy.phases[enemy.phaseIndex || 0] : null
            return (
              <div key={enemy.id} className="exp-enemy" style={{ textAlign: 'left' }}>
                <div className="exp-enemy-portrait" aria-hidden="true">{ENEMY_SYMBOLS[state.enemy?.id] || '⚔'}</div>
                <strong>{enemy.name}</strong>
                {phase ? <div className="exp-status">Phase: {phase}</div> : null}
                <div className="exp-hp is-enemy" aria-label={`${enemy.name} health`}>
                  <span style={{ width: `${hpPct}%` }} />
                </div>
                <div className="exp-status">{enemy.hp}/{enemy.maxHp}</div>
                <p className="exp-intent" role="status">
                  {intent?.label || '…'}
                  {enemy.casting ? ` · Casting ${enemy.casting.castName}!` : ''}
                  {intent?.interruptible || enemy.casting?.interruptible ? ' (interruptible)' : ''}
                </p>
                <div className="exp-status">
                  {(enemy.statuses || []).map((s) => s.id).join(', ') || 'No statuses'}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="exp-grid" style={{ marginBottom: '1rem' }}>
        {state.party.map((p) => {
          const def = getClassDef(p.class_name)
          const pct = Math.max(0, (p.hp / p.maxHp) * 100)
          const resLabel = p.maxMana > 0
            ? `MP ${p.mana}/${p.maxMana}`
            : p.maxEndurance > 0
              ? `END ${p.endurance}/${p.maxEndurance}`
              : ''
          return (
            <button
              key={p.id}
              type="button"
              className={`exp-combatant${!p.alive ? ' is-down' : ''}${activeId === p.id ? ' is-selected' : ''}`}
              onClick={() => p.alive && setActiveId(p.id)}
              aria-pressed={activeId === p.id}
              aria-label={`${p.name} ${p.hp} of ${p.maxHp}`}
            >
              <span className="exp-class-badge" style={{ color: def.color }}>
                <span aria-hidden="true">{def.symbol}</span> {def.abbrev}
              </span>
              <div className="name">{p.name}</div>
              <div className="exp-status">{p.position} · {p.equipmentKnown ? 'Magelo gear' : 'class/level'}</div>
              <div className="exp-hp"><span style={{ width: `${pct}%` }} /></div>
              <div className="exp-status">
                {p.alive ? `${p.hp}/${p.maxHp}` : 'KO'} {resLabel}
              </div>
              {p.casting ? <div className="exp-intent">Casting {p.casting.abilityName}…</div> : null}
              <div className="exp-status">{(p.statuses || []).map((s) => s.id).join(', ')}</div>
            </button>
          )
        })}
      </div>

      {active ? (
        <div className="exp-panel exp-actions">
          <strong>Actions — {active.name}</strong>
          <div className="exp-action-row" role="tablist">
            {['offensive', 'defensive', 'support'].map((g) => (
              <button key={g} type="button" role="tab" className={`exp-btn${tab === g ? ' is-active' : ''}`} onClick={() => setTab(g)}>
                {g}
              </button>
            ))}
          </div>
          <div className="exp-action-row">
            {availableActions(state, active)
              .filter((o) => o.group === tab || o.tags?.includes('universal'))
              .map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`exp-btn${draft[active.id]?.actionId === o.id ? ' is-active' : ''}`}
                  title={`${o.description}\nCost: ${o.cost || 0} ${o.resource || 'none'} · CD ${o.cooldown || 0}${o.castTime ? ' · cast delay' : ''}`}
                  onClick={() => setDraft((d) => ({
                    ...d,
                    [active.id]: {
                      actionId: o.id,
                      targetId: o.needsAllyTarget
                        ? (d[active.id]?.targetId || living[0]?.id)
                        : o.needsEnemyTarget
                          ? (d[active.id]?.targetId || enemies[0]?.id)
                          : undefined,
                    },
                  }))}
                >
                  {o.name}
                  {o.cost ? ` (${o.cost})` : ''}
                  {o.castTime ? '…' : ''}
                </button>
              ))}
          </div>
          {(() => {
            const cur = draft[active.id]
            const match = availableActions(state, active).find((o) => o.id === cur?.actionId)
            if (match?.needsAllyTarget) {
              return (
                <label className="exp-status">
                  Ally{' '}
                  <select
                    value={cur?.targetId || ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [active.id]: { ...d[active.id], targetId: e.target.value } }))}
                  >
                    {state.party.filter((t) => match.needsDeadAlly ? !t.alive : t.alive).map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
              )
            }
            if (match?.needsEnemyTarget) {
              return (
                <label className="exp-status">
                  Enemy{' '}
                  <select
                    value={cur?.targetId || enemies[0]?.id || ''}
                    onChange={(e) => setDraft((d) => ({ ...d, [active.id]: { ...d[active.id], targetId: e.target.value } }))}
                  >
                    {enemies.filter((e) => e.alive).map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
              )
            }
            return null
          })()}

          <div className="exp-action-row" style={{ marginTop: '0.75rem' }}>
            <label className="exp-status">
              Raid command{' '}
              <select value={commandId} onChange={(e) => setCommandId(e.target.value)}>
                <option value="">None</option>
                {RAID_COMMANDS.map((c) => (
                  <option key={c.id} value={c.id} disabled={(state.commandPoints || 0) < c.cost}>
                    {c.name} ({c.cost} CP)
                  </option>
                ))}
              </select>
            </label>
          </div>

          <button
            type="button"
            className="exp-btn is-primary"
            disabled={!allReady}
            onClick={() => onCommit(draft, commandId ? { commandId, commandTargetId: enemies[0]?.id } : {})}
          >
            Resolve round
          </button>
        </div>
      ) : null}

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
  const d = {}
  const enemyId = (state.enemies || []).find((e) => e.alive)?.id
  for (const p of state.party.filter((x) => x.alive)) {
    const opts = availableActions(state, p)
    const first = opts.find((o) => o.id === 'basic_attack') || opts[0]
    if (!first) continue
    d[p.id] = {
      actionId: first.id,
      targetId: first.needsAllyTarget ? p.id : first.needsEnemyTarget ? enemyId : undefined,
    }
  }
  return d
}
