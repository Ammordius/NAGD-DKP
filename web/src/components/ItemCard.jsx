/**
 * Item card — Discord-style hover preview for TAKP items.
 * Shows name, slot, stats, effects, and link to AllaClone.
 * Accepts optional full `stats`; when missing, shows compact card with link only.
 */

const TAKP_ITEM_BASE = 'https://www.takproject.net/allaclone/item.php?id='

function StatLine({ label, value, highlight }) {
  if (value == null || value === '') return null
  return (
    <div className="item-card__stat">
      <span className="item-card__stat-label">{label}</span>
      <span className={highlight ? 'item-card__stat-value item-card__stat-value--highlight' : 'item-card__stat-value'}>
        {value}
      </span>
    </div>
  )
}

function Section({ title, children }) {
  if (!children) return null
  return (
    <div className="item-card__section">
      <div className="item-card__section-title">{title}</div>
      {children}
    </div>
  )
}

export default function ItemCard({ name, itemId, stats, compact = false }) {
  const href = itemId != null ? `${TAKP_ITEM_BASE}${itemId}` : null

  if (compact || !stats) {
    return (
      <div className="item-card item-card--compact">
        <div className="item-card__name">{name || 'Unknown item'}</div>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="item-card__link"
          >
            View on TAKP AllaClone →
          </a>
        )}
      </div>
    )
  }

  const {
    slot,
    skill,
    ac,
    atkDelay,
    dmg,
    dmgBonus,
    mods = [],
    resists = [],
    requiredLevel,
    effect,
    focusEffect,
    weight,
    size,
    classes,
    races,
    droppedBy = [],
  } = stats

  return (
    <div className="item-card">
      <div className="item-card__header">
        <span className="item-card__name">{name || 'Unknown item'}</span>
        {slot && <span className="item-card__slot">{slot}</span>}
      </div>

      {(skill || ac != null || (atkDelay != null && dmg != null)) && (
        <Section title="Combat">
          {skill && <StatLine label="Skill" value={skill} />}
          {ac != null && <StatLine label="AC" value={ac} />}
          {atkDelay != null && dmg != null && (
            <StatLine label="Weapon" value={`${dmg} dmg, ${atkDelay} delay`} highlight />
          )}
          {dmgBonus != null && <StatLine label="Dmg bonus" value={dmgBonus} />}
        </Section>
      )}

      {mods.length > 0 && (
        <Section title="Stats">
          {mods.map((m, i) => (
            <StatLine key={i} label={m.label} value={m.value} />
          ))}
        </Section>
      )}

      {resists.length > 0 && (
        <Section title="Resists">
          {resists.map((r, i) => (
            <StatLine key={i} label={r.label} value={r.value} />
          ))}
        </Section>
      )}

      {(effect || focusEffect) && (
        <Section title="Effects">
          {effect && <div className="item-card__effect">{effect}</div>}
          {focusEffect && <div className="item-card__effect item-card__effect--focus">{focusEffect}</div>}
        </Section>
      )}

      {(requiredLevel != null || classes || races) && (
        <div className="item-card__meta">
          {requiredLevel != null && <span>Req Lvl {requiredLevel}</span>}
          {classes && <span>{classes}</span>}
          {races && <span>{races}</span>}
        </div>
      )}

      {droppedBy.length > 0 && (
        <Section title="Dropped by">
          <div className="item-card__dropped-by">
            {droppedBy.slice(0, 5).map((s, i) => (
              <span key={i}>{s}</span>
            ))}
            {droppedBy.length > 5 && <span>…</span>}
          </div>
        </Section>
      )}

      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="item-card__link"
        >
          View full details on TAKP AllaClone →
        </a>
      )}
    </div>
  )
}
