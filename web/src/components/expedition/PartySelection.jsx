import { getClassDef } from '../../lib/expedition/classDefinitions.js'
import { getClassAbilities } from '../../lib/expedition/abilities.js'
import { getPassive } from '../../lib/expedition/passives.js'
import {
  compositionCommentary,
  fillPartyToThree,
  partyComposition,
} from '../../lib/expedition/characterAdapter.js'
import {
  buildCombatIdentity,
  evaluatePartyRadar,
  partyLimitationLine,
  lookupProfile,
} from '../../lib/expedition/combatProfile.js'

/**
 * @param {{
 *   roster: object[],
 *   selectedIds: string[],
 *   onToggle: (id: string) => void,
 *   onStart: (party: object[], identities: object[]) => void,
 *   notice?: string|null,
 *   fictionalRoster?: boolean,
 *   profiles?: Map<string, object>|null,
 * }} props
 */
export default function PartySelection({
  roster,
  selectedIds,
  onToggle,
  onStart,
  notice,
  fictionalRoster,
  profiles,
}) {
  const selected = roster.filter((c) => selectedIds.includes(c.char_id))
  const preview = fillPartyToThree(selected)
  const identities = preview.map((c) => {
    const profile = profiles ? lookupProfile(c.name, profiles) : lookupProfile(c.name)
    return buildCombatIdentity(c, profile)
  })
  const comp = partyComposition(preview)
  const commentary = compositionCommentary(preview)
  const radar = evaluatePartyRadar(preview, identities)
  const limitation = partyLimitationLine(preview)

  return (
    <div>
      <h2>Assemble Your Party</h2>
      <p className="exp-tagline">Choose up to three characters. Class kits, levels, and Magelo gear (when known) all matter.</p>
      {notice ? <p className="exp-notice" role="status">{notice}</p> : null}
      {fictionalRoster ? (
        <p className="exp-disclaimer" role="note">
          Fictional stand-ins — not real guild characters. Nothing is written to the database.
        </p>
      ) : null}

      <div className="exp-grid" role="list" aria-label="Available characters">
        {roster.map((c) => {
          const def = getClassDef(c.class_name)
          const selectedCard = selectedIds.includes(c.char_id)
          const disabled = !selectedCard && selectedIds.length >= 3
          const profile = profiles ? lookupProfile(c.name, profiles) : null
          const idn = buildCombatIdentity(c, profile)
          return (
            <button
              key={c.char_id}
              type="button"
              role="listitem"
              className={`exp-char-card${selectedCard ? ' is-selected' : ''}`}
              aria-pressed={selectedCard}
              disabled={disabled}
              onClick={() => onToggle(c.char_id)}
            >
              <span className="exp-class-badge" style={{ color: def.color }}>
                <span aria-hidden="true">{def.symbol}</span> {def.abbrev}
              </span>
              <span className="name">{c.name}</span>
              <span className="meta">
                {def.name}
                {c.level != null ? ` · L${c.level}` : ''}
                {c.fictional ? ' · fictional' : ''}
              </span>
              <span className="meta">{def.roleLabel}</span>
              <span className="meta">
                {idn.equipmentKnown ? `Gear snapshot ${idn.snapshotDate || 'known'}` : 'Class/level profile only'}
              </span>
              <span className="meta">HP {idn.base.maxHp} · ATK {idn.base.atk}</span>
            </button>
          )
        })}
      </div>

      <div className="exp-panel" style={{ marginTop: '1rem' }}>
        <strong>Party preview</strong>
        <div className="exp-party-preview" aria-live="polite">
          {preview.map((c, i) => {
            const idn = identities[i]
            const passive = getPassive(c.class_name)
            const abs = getClassAbilities(c.class_name)
            return (
              <div key={c.char_id} className="exp-party-chip" style={{ display: 'block', maxWidth: '100%' }}>
                <div>
                  {c.name} ({getClassDef(c.class_name).abbrev}
                  {c.fictional && selectedIds.length < 3 ? ', volunteer' : ''})
                </div>
                <div className="exp-status">
                  {idn.equipmentKnown ? 'Magelo-derived stats' : 'Class/level fallback'} · {idn.traits.join(', ') || 'no traits'}
                </div>
                <div className="exp-status">Passive: {passive?.name}</div>
                <div className="exp-status">Abilities: {abs.map((a) => a.name).join(', ')}</div>
              </div>
            )
          })}
        </div>
        <p className="exp-comp">
          Tanking {comp.tanking} · Healing {comp.healing} · Damage {comp.damage} · Utility {comp.utility}
        </p>
        <p className="exp-comp">
          Survivability {radar.survivability} · Healing {radar.healing} · Burst {radar.burst} · Sustain {radar.sustained} · CC {radar.control} · Mana {radar.manaSustain}
        </p>
        <p className="exp-notice">{limitation}</p>
        <p className="exp-narrator" style={{ marginBottom: 0 }}>
          <strong>DKP Inquisitor</strong>
          {commentary}
        </p>
      </div>

      <button type="button" className="exp-btn is-primary" onClick={() => onStart(preview, identities)}>
        Begin Expedition
      </button>
      {selectedIds.length === 0 ? (
        <p className="exp-notice">No selection — volunteers will fill the party.</p>
      ) : null}
    </div>
  )
}
