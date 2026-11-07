import { useEffect, useMemo, useRef, useState } from 'react'
import { getClassDef } from '../../lib/expedition/classDefinitions.js'
import { availableActions, RAID_COMMANDS } from '../../lib/expedition/gameEngine.js'
import { smartAllyTarget, smartEnemyTarget } from '../../lib/expedition/targeting.js'
import {
  isBossSprite,
  resolveEnemyFallbackSymbol,
  resolveEnemySprite,
} from '../../lib/expedition/assets.js'
import {
  buildDefaultDraft,
  deriveEnemyCardState,
  derivePartyCardState,
  derivePortraitStatusFlags,
  diffFlashClasses,
  getEncounterId,
  isDraftReady,
  isLogHeaderLine,
  partyClickEffect,
  statusCategory,
  statusLabel,
  statusMarker,
  statusRemaining,
} from '../../lib/expedition/battleUi.js'
import ClassPortrait from './ClassPortrait.jsx'

const FLASH_MS = 400

function EnemyPortrait({ enemy, encounterId, flags = [] }) {
  const src = resolveEnemySprite(enemy)
  const fallback = resolveEnemyFallbackSymbol(enemy, encounterId)
  const [failed, setFailed] = useState(false)
  const showSprite = Boolean(src) && !failed
  const boss = isBossSprite(enemy)
  const flagClass = (flags || []).filter(Boolean).join(' ')

  return (
    <div
      className={`exp-portrait exp-enemy-portrait${boss ? ' is-boss' : ''}${flagClass ? ` ${flagClass}` : ''}`}
      aria-hidden="true"
    >
      {showSprite ? (
        <img
          className="exp-enemy-sprite"
          src={src}
          alt=""
          width={boss ? 128 : 96}
          height={boss ? 128 : 96}
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="exp-enemy-fallback">{fallback}</span>
      )}
      <span className="exp-portrait-markers">
        {(flags || []).includes('has-stun') ? <span className="exp-marker is-stun">★</span> : null}
        {(flags || []).includes('has-mez') ? <span className="exp-marker is-mez">◈</span> : null}
        {(flags || []).includes('has-shield') ? <span className="exp-marker is-shield">◇</span> : null}
        {(flags || []).includes('has-haste') ? <span className="exp-marker is-haste">»</span> : null}
        {(flags || []).includes('has-slow') ? <span className="exp-marker is-slow">«</span> : null}
        {(flags || []).includes('has-warn') ? <span className="exp-marker is-warn">!</span> : null}
        {(flags || []).includes('has-regen') ? <span className="exp-marker is-regen">+</span> : null}
        {(flags || []).includes('has-sick') ? <span className="exp-marker is-sick">●</span> : null}
      </span>
    </div>
  )
}

function StatusChips({ statuses, emptyLabel = null }) {
  const list = (statuses || []).filter(
    (s) => s && (typeof s.remaining !== 'number' || s.remaining > 0),
  )
  if (!list.length) {
    return emptyLabel ? <div className="exp-status">{emptyLabel}</div> : null
  }
  return (
    <div className="exp-status-chips">
      {list.map((s, i) => {
        const id = s.id || s
        const label = statusLabel(s)
        const remaining = statusRemaining(s)
        const marker = statusMarker(s)
        const title = remaining != null ? `${label} (${remaining} round${remaining === 1 ? '' : 's'} left)` : label
        return (
          <span
            key={`${id}-${i}`}
            className={`exp-status-chip is-${statusCategory(s)}`}
            title={title}
            aria-label={title}
          >
            <span className="exp-status-marker" aria-hidden="true">{marker}</span>
            {' '}
            {label}
            {remaining != null ? <span className="exp-status-rem" aria-hidden="true"> {remaining}</span> : null}
          </span>
        )
      })}
    </div>
  )
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
export default function BattleScreen({
  state,
  appearanceMode = 'classic',
  onCommit,
  onBoon,
  onEvent,
  onRoute,
  onConsumable,
}) {
  const living = state.party.filter((p) => p.alive)
  const [draft, setDraft] = useState(() => buildDefaultDraft(state))
  const [activeId, setActiveId] = useState(living[0]?.id || null)
  const [tab, setTab] = useState('offensive')
  const [commandId, setCommandId] = useState('')
  const [flashes, setFlashes] = useState(/** @type {Record<string, string>} */ ({}))
  const draftKey = `${state.encounterIndex}-${state.round}-${state.phase}`
  const prevUnitsRef = useRef(null)

  useEffect(() => {
    setDraft(buildDefaultDraft(state))
    const live = state.party.filter((p) => p.alive)
    setActiveId(live[0]?.id || null)
    setCommandId('')
  }, [draftKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const units = [...(state.party || []), ...(state.enemies || [])]
    const prev = prevUnitsRef.current
    prevUnitsRef.current = units.map((u) => ({ id: u.id, hp: u.hp }))
    if (!prev) return
    const nextFlashes = diffFlashClasses(prev, units)
    if (!Object.keys(nextFlashes).length) return
    setFlashes(nextFlashes)
    const t = setTimeout(() => setFlashes({}), FLASH_MS)
    return () => clearTimeout(t)
  }, [state.turns, state.round, state.party, state.enemies])

  const defaultDraft = useMemo(() => buildDefaultDraft(state), [draftKey]) // eslint-disable-line react-hooks/exhaustive-deps

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
  const encounterId = getEncounterId(state)
  const active = state.party.find((p) => p.id === activeId) || living[0]
  const activeAction = active
    ? availableActions(state, active).find((o) => o.id === draft[active.id]?.actionId)
    : null
  const allReady = isDraftReady(state, draft)
  const autoCount = living.filter((p) => {
    const card = derivePartyCardState({
      member: p,
      activeId,
      draft,
      defaultDraft,
      activeAction,
      state,
    })
    return card.isAutoQueued
  }).length
  const deliberateCount = living.length - autoCount
  const draftTargetId = active ? draft[active.id]?.targetId : null
  const abilityPanelId = 'exp-ability-panel'

  function selectAbility(o) {
    if (!active) return
    setDraft((d) => ({
      ...d,
      [active.id]: {
        actionId: o.id,
        targetId: o.needsAllyTarget
          ? smartAllyTarget(state.party, d[active.id]?.targetId, { dead: o.needsDeadAlly })
          : o.needsEnemyTarget
            ? smartEnemyTarget(enemies, d[active.id]?.targetId)
            : undefined,
      },
    }))
  }

  function setTargetForActive(targetId) {
    if (!active) return
    setDraft((d) => ({
      ...d,
      [active.id]: { ...d[active.id], targetId },
    }))
  }

  function onPartyClick(p) {
    const effect = partyClickEffect({ member: p, activeId: active?.id, activeAction })
    if (effect.type === 'setActive') {
      setActiveId(effect.activeId)
      return
    }
    if (effect.type === 'setTarget') {
      setTargetForActive(effect.targetId)
    }
  }

  function onEnemyClick(enemy) {
    if (!activeAction?.needsEnemyTarget || !enemy.alive) return
    setTargetForActive(enemy.id)
  }

  const selectedCommand = RAID_COMMANDS.find((c) => c.id === commandId)

  return (
    <div className="exp-battle">
      <div className="exp-panel exp-battle-hud">
        <p className="exp-status">
          Encounter {state.encounterIndex + 1}/6 · Round {state.round} · CP {state.commandPoints || 0}
          {state.difficulty ? ` · ${state.difficulty}` : ''}
        </p>
      </div>

      <div className="exp-battlefield">
        <div className="exp-panel exp-enemies-panel">
          <strong className="exp-panel-label">Enemies</strong>
          <div className={`exp-grid exp-enemy-grid${enemies.length === 1 ? ' is-single' : ''}`}>
            {enemies.map((enemy) => {
              const hpPct = Math.max(0, (enemy.hp / enemy.maxHp) * 100)
              const intent = state.intents?.[enemy.id]
              const ui = deriveEnemyCardState({
                enemy,
                intent,
                draftTargetId,
                activeAction,
              })
              const flash = flashes[enemy.id] || ''
              const portraitFlags = derivePortraitStatusFlags(enemy)
              const className = [
                'exp-enemy',
                ui.isDown ? 'is-down' : '',
                ui.isTargeted ? 'is-targeted' : '',
                ui.isTargetable ? 'is-targetable' : '',
                ui.isCasting ? 'is-casting' : '',
                ui.isInterruptible ? 'is-interruptible' : '',
                flash,
              ].filter(Boolean).join(' ')

              const body = (
                <>
                  <EnemyPortrait enemy={enemy} encounterId={encounterId} flags={portraitFlags} />
                  <strong className="exp-enemy-name">{enemy.name}</strong>
                  {ui.phase ? <div className="exp-status">Phase: {ui.phase}</div> : null}
                  <div className="exp-hp is-enemy" aria-hidden="true">
                    <span style={{ width: `${hpPct}%` }} />
                  </div>
                  <div className="exp-hp-label">{enemy.hp}/{enemy.maxHp} HP</div>
                  <p className="exp-intent" role="status">
                    <span className="exp-intent-label">Intent</span>
                    {' '}
                    {ui.intentLabel}
                    {ui.castName ? ` · Casting ${ui.castName}!` : ''}
                  </p>
                  {ui.isInterruptible ? (
                    <span className="exp-cast-badge">Interruptible</span>
                  ) : null}
                  <StatusChips statuses={enemy.statuses} emptyLabel="No statuses" />
                </>
              )

              const label = [
                enemy.name,
                `${enemy.hp} of ${enemy.maxHp} health`,
                ui.isTargeted ? 'targeted' : '',
                ui.isTargetable ? 'click to target' : '',
                ui.isInterruptible ? 'interruptible cast' : '',
                ui.isDown ? 'defeated' : '',
              ].filter(Boolean).join(', ')

              if (ui.isTargetable) {
                return (
                  <button
                    key={enemy.id}
                    type="button"
                    className={className}
                    onClick={() => onEnemyClick(enemy)}
                    aria-pressed={ui.isTargeted}
                    aria-label={label}
                  >
                    {body}
                  </button>
                )
              }

              return (
                <div key={enemy.id} className={className} aria-label={label}>
                  {body}
                </div>
              )
            })}
          </div>
        </div>

        <div className="exp-panel exp-party-panel">
          <strong className="exp-panel-label">Party</strong>
          <div className="exp-grid exp-party-grid">
            {state.party.map((p) => {
              const def = getClassDef(p.class_name)
              const pct = Math.max(0, (p.hp / p.maxHp) * 100)
              const resLabel = p.maxMana > 0
                ? `MP ${p.mana}/${p.maxMana}`
                : p.maxEndurance > 0
                  ? `END ${p.endurance}/${p.maxEndurance}`
                  : ''
              const ui = derivePartyCardState({
                member: p,
                activeId: active?.id,
                draft,
                defaultDraft,
                activeAction,
                state,
              })
              const flash = flashes[p.id] || ''
              const portraitFlags = derivePortraitStatusFlags(p)
              const className = [
                'exp-combatant',
                ui.isDown ? 'is-down' : '',
                ui.isActivePlanner ? 'is-selected' : '',
                ui.isTargeted ? 'is-targeted' : '',
                ui.isTargetable ? 'is-targetable' : '',
                ui.isAutoQueued ? 'is-auto-queue' : '',
                ui.isCasting ? 'is-casting' : '',
                flash,
              ].filter(Boolean).join(' ')

              const aria = [
                p.name,
                def.name,
                p.alive ? `${p.hp} of ${p.maxHp}` : 'KO',
                ui.isActivePlanner ? 'active planner' : '',
                ui.isTargeted ? 'current target' : '',
                ui.isTargetable
                  ? 'click to target'
                  : p.alive
                    ? 'click to plan actions'
                    : '',
                p.alive && ui.queueLabel ? `queued ${ui.queueLabel}` : '',
                p.casting ? `casting ${p.casting.abilityName}` : '',
              ].filter(Boolean).join(', ')

              return (
                <button
                  key={p.id}
                  type="button"
                  className={className}
                  onClick={() => onPartyClick(p)}
                  aria-pressed={ui.isActivePlanner}
                  aria-label={aria}
                  disabled={ui.isDown && !ui.isTargetable}
                >
                  <div className="exp-combatant-head">
                    <ClassPortrait
                      unitClass={p.class_name}
                      size={64}
                      flags={portraitFlags}
                      showKoLabel
                      appearanceMode={appearanceMode}
                    />
                    <div className="exp-combatant-meta">
                      <span className="exp-class-badge" style={{ color: def.color }}>
                        <span aria-hidden="true">{def.symbol}</span> {def.abbrev}
                      </span>
                      <div className="name">{p.name}</div>
                      <div className="exp-status">{p.position} · {p.equipmentKnown ? 'Magelo gear' : 'class/level'}</div>
                    </div>
                  </div>
                  <div className="exp-hp" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
                  <div className="exp-hp-label">
                    {p.alive ? `${p.hp}/${p.maxHp}` : 'KO'} {resLabel}
                  </div>
                  {p.casting ? <div className="exp-intent">Casting {p.casting.abilityName}…</div> : null}
                  {p.alive ? (
                    <div className={`exp-queue${ui.isAutoQueued ? ' is-auto' : ' is-deliberate'}`}>
                      {ui.isAutoQueued ? <span className="exp-queue-tag">auto</span> : null}
                      <span>{ui.queueLabel}</span>
                    </div>
                  ) : null}
                  <StatusChips statuses={p.statuses} />
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {active ? (
        <div className="exp-panel exp-actions">
          <div className="exp-planner-row" role="group" aria-label="Active planner">
            <strong className="exp-planner-heading">Actions</strong>
            <div className="exp-planner-chips">
              {living.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`exp-btn exp-planner-chip${active.id === p.id ? ' is-active' : ''}`}
                  aria-pressed={active.id === p.id}
                  onClick={() => setActiveId(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
          <div className="exp-action-row" role="tablist" aria-label="Ability groups">
            {['offensive', 'defensive', 'support'].map((g) => (
              <button
                key={g}
                type="button"
                role="tab"
                id={`exp-tab-${g}`}
                aria-selected={tab === g}
                aria-controls={abilityPanelId}
                className={`exp-btn${tab === g ? ' is-active' : ''}`}
                onClick={() => setTab(g)}
              >
                {g}
              </button>
            ))}
          </div>
          <div
            className="exp-ability-grid"
            role="tabpanel"
            id={abilityPanelId}
            aria-labelledby={`exp-tab-${tab}`}
          >
            {availableActions(state, active)
              .filter((o) => o.group === tab || o.tags?.includes('universal'))
              .map((o) => {
                const selected = draft[active.id]?.actionId === o.id
                const meta = [
                  o.cost ? `${o.cost} ${o.resource || ''}`.trim() : null,
                  o.cooldown ? `CD ${o.cooldown}` : null,
                  o.castTime ? 'cast delay' : null,
                ].filter(Boolean).join(' · ')
                return (
                  <button
                    key={o.id}
                    type="button"
                    className={`exp-btn exp-ability${selected ? ' is-active' : ''}`}
                    title={`${o.description}\nCost: ${o.cost || 0} ${o.resource || 'none'} · CD ${o.cooldown || 0}${o.castTime ? ' · cast delay' : ''}`}
                    onClick={() => selectAbility(o)}
                  >
                    <span className="exp-ability-name">
                      {o.name}
                      {o.castTime ? '…' : ''}
                    </span>
                    {meta ? <span className="exp-ability-meta">{meta}</span> : null}
                  </button>
                )
              })}
          </div>
          {(() => {
            const cur = draft[active.id]
            const match = availableActions(state, active).find((o) => o.id === cur?.actionId)
            if (match?.needsAllyTarget) {
              const allyValue = smartAllyTarget(state.party, cur?.targetId, { dead: match.needsDeadAlly }) || ''
              return (
                <label className="exp-target-label">
                  Ally
                  <select
                    value={allyValue}
                    onChange={(e) => setTargetForActive(e.target.value)}
                    aria-label="Ally target"
                  >
                    {state.party.filter((t) => (match.needsDeadAlly ? !t.alive : t.alive)).map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
              )
            }
            if (match?.needsEnemyTarget) {
              const enemyValue = smartEnemyTarget(enemies, cur?.targetId) || ''
              return (
                <label className="exp-target-label">
                  Enemy
                  <select
                    value={enemyValue}
                    onChange={(e) => setTargetForActive(e.target.value)}
                    aria-label="Enemy target"
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

          <div className="exp-action-row exp-command-row">
            <label className="exp-target-label">
              Raid command
              <select value={commandId} onChange={(e) => setCommandId(e.target.value)} aria-label="Raid command">
                <option value="">None</option>
                {RAID_COMMANDS.map((c) => (
                  <option key={c.id} value={c.id} disabled={(state.commandPoints || 0) < c.cost}>
                    {c.name} ({c.cost} CP)
                  </option>
                ))}
              </select>
            </label>
            {selectedCommand ? (
              <span className="exp-status">Costs {selectedCommand.cost} CP · you have {state.commandPoints || 0}</span>
            ) : null}
          </div>

          <div className="exp-resolve-bar">
            <p className="exp-resolve-hint" role="status">
              {!allReady
                ? 'Assign an action to every living party member.'
                : autoCount > 0
                  ? `${deliberateCount}/${living.length} deliberate · ${autoCount} auto default${autoCount === 1 ? '' : 's'}`
                  : 'All actions deliberately set — ready to resolve.'}
            </p>
            <button
              type="button"
              className={`exp-btn is-primary exp-resolve-btn${allReady ? ' is-ready' : ''}`}
              disabled={!allReady}
              onClick={() => onCommit(draft, commandId ? { commandId, commandTargetId: enemies[0]?.id } : {})}
            >
              Resolve round
            </button>
          </div>
        </div>
      ) : null}

      <div className="exp-panel">
        <strong>Combat log</strong>
        <div className="exp-log" aria-live="polite">
          {[...state.log].reverse().map((line, i) => (
            <div
              key={`${state.turns}-${i}`}
              className={`exp-log-line${isLogHeaderLine(line) ? ' is-header' : ''}`}
            >
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
