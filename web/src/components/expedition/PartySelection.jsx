import { getClassDef } from '../../lib/expedition/classDefinitions.js'
import {
  compositionCommentary,
  fillPartyToThree,
  partyComposition,
} from '../../lib/expedition/characterAdapter.js'

/**
 * @param {{
 *   roster: Array<{ char_id: string, name: string, class_name: string, level?: number|null, fictional?: boolean }>,
 *   selectedIds: string[],
 *   onToggle: (charId: string) => void,
 *   onStart: (party: object[]) => void,
 *   notice?: string|null,
 *   fictionalRoster?: boolean,
 * }} props
 */
export default function PartySelection({
  roster,
  selectedIds,
  onToggle,
  onStart,
  notice,
  fictionalRoster,
}) {
  const selected = roster.filter((c) => selectedIds.includes(c.char_id))
  const preview = fillPartyToThree(selected)
  const comp = partyComposition(preview)
  const commentary = compositionCommentary(preview)

  return (
    <div>
      <h2>Assemble Your Party</h2>
      <p className="exp-tagline">Choose up to three characters. Unusual compositions are legal and entertaining.</p>
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
            </button>
          )
        })}
      </div>

      <div className="exp-panel" style={{ marginTop: '1rem' }}>
        <strong>Party preview</strong>
        <div className="exp-party-preview" aria-live="polite">
          {preview.map((c) => (
            <span key={c.char_id} className="exp-party-chip">
              {c.name} ({getClassDef(c.class_name).abbrev}
              {c.fictional && selectedIds.length < 3 ? ', volunteer' : ''})
            </span>
          ))}
        </div>
        <p className="exp-comp">
          Tanking {comp.tanking} · Healing {comp.healing} · Damage {comp.damage} · Utility {comp.utility}
        </p>
        <p className="exp-narrator" style={{ marginBottom: 0 }}>
          <strong>DKP Inquisitor</strong>
          {commentary}
        </p>
      </div>

      <button
        type="button"
        className="exp-btn is-primary"
        onClick={() => onStart(preview)}
      >
        Begin Expedition
      </button>
      {selectedIds.length === 0 ? (
        <p className="exp-notice">No selection — volunteers will fill the party.</p>
      ) : null}
    </div>
  )
}
