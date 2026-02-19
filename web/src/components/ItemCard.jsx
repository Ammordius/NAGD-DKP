/**
 * Item card — Magelo-style layout to match TAKP Magelo character sheet.
 * ItemOuter > ItemTitle (link to AllaClone item) > ItemInner (flags, slot, stats, effect/focus links, etc.)
 */

const TAKP_ITEM_BASE = 'https://www.takproject.net/allaclone/item.php?id='
const TAKP_SPELL_BASE = 'https://www.takproject.net/allaclone/spell.php?id='

function SpellLink({ spellId, name }) {
  if (spellId == null || !name) return name || ''
  return (
    <a href={`${TAKP_SPELL_BASE}${spellId}`} target="_blank" rel="noopener noreferrer" className="item-card__spell-link">
      {name}
    </a>
  )
}

/** Inline subset: slot, AC, effect, key mods, resists, level, classes in a few lines. */
function ItemCardInline({ name, itemId, stats, href }) {
  if (!stats) {
    return (
      <div className="item-card item-card--inline item-card--compact ItemOuter">
        <div className="ItemTitle">
          <div className="ItemTitleMid">
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">{name || 'Unknown item'}</a>
            ) : (
              <span>{name || 'Unknown item'}</span>
            )}
          </div>
        </div>
      </div>
    )
  }
  const {
    slot,
    ac,
    mods = [],
    resists = [],
    requiredLevel,
    effectSpellName,
    effectSpellId,
    classes,
  } = stats
  const modsShort = mods.length > 0
    ? mods.map((m) => {
        const v = m.value
        const plus = typeof v === 'number' && (m.label === 'HP' || m.label === 'MANA') ? (v >= 0 ? '+' : '') + v : v
        return `${m.label}: ${plus}`
      }).join(', ')
    : ''
  const resistsShort = resists.length > 0 ? resists.map((r) => `${r.label}: ${r.value}`).join(' ') : ''
  const parts = []
  if (slot) parts.push(slot)
  if (ac != null) parts.push(`AC: ${ac}`)
  if (effectSpellId != null || effectSpellName) parts.push(`Effect: ${effectSpellName || effectSpellId}`)
  if (modsShort) parts.push(modsShort)
  if (resistsShort) parts.push(resistsShort)
  if (requiredLevel != null) parts.push(`Req ${requiredLevel}`)
  if (classes) parts.push(classes)
  return (
    <div className="item-card item-card--inline ItemOuter">
      <div className="ItemTitle">
        <div className="ItemTitleMid">
          <a href={href} target="_blank" rel="noopener noreferrer">{name || 'Unknown item'}</a>
        </div>
      </div>
      <div className="ItemInner ItemInner--inline">
        {parts.filter(Boolean).join(' · ')}
      </div>
    </div>
  )
}

export default function ItemCard({ name, itemId, stats, compact = false, inline = false }) {
  const href = itemId != null ? `${TAKP_ITEM_BASE}${itemId}` : null

  if (inline) {
    return <ItemCardInline name={name} itemId={itemId} stats={stats} href={href} />
  }

  if (compact || !stats) {
    return (
      <div className="item-card item-card--compact ItemOuter">
        <div className="ItemTitle">
          <div className="ItemTitleLeft" />
          <div className="ItemTitleMid">
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">{name || 'Unknown item'}</a>
            ) : (
              <span>{name || 'Unknown item'}</span>
            )}
          </div>
          <div className="ItemTitleRight" />
        </div>
      </div>
    )
  }

  const {
    flags = [],
    slot,
    skill,
    ac,
    atkDelay,
    dmg,
    dmgBonus,
    dmgBonusNote,
    mods = [],
    resists = [],
    instrumentMods = [],
    levelType = 'required',
    requiredLevel,
    effectSpellId,
    effectSpellName,
    effectNote,
    focusSpellId,
    focusSpellName,
    weight,
    size,
    classes,
    races,
    skillMod,
    light,
    tint,
  } = stats

  const levelStr = requiredLevel != null
    ? (levelType === 'recommended' ? `Recommended level of ${requiredLevel}.` : `Required level of ${requiredLevel}.`)
    : null

  const statsLine = mods.length > 0
    ? mods.map((m) => {
        const v = m.value
        const plus = typeof v === 'number' && (m.label === 'HP' || m.label === 'MANA') ? (v >= 0 ? '+' : '') + v : v
        return `${m.label}: ${plus}`
      }).join(' ')
    : null

  const resistsLine = resists.length > 0
    ? resists.map((r) => `${r.label}: ${r.value}`).join(' ')
    : null

  return (
    <div className="item-card ItemOuter">
      <div className="ItemTitle">
        <div className="ItemTitleLeft" />
        <div className="ItemTitleMid">
          <a href={href} target="_blank" rel="noopener noreferrer">{name || 'Unknown item'}</a>
        </div>
        <div className="ItemTitleRight" />
      </div>
      <div className="ItemInner">
        {flags.length > 0 && (
          <> {flags.join('  ')}<br /></>
        )}
        {slot && <>Slot: {slot}<br /></>}
        {skill && atkDelay != null && dmg != null && (
          <>Skill: {skill} Atk Delay: {atkDelay}<br /></>
        )}
        {skill && dmg != null && (
          <>
            DMG: {dmg} {dmgBonus != null && <>Dmg bonus:{dmgBonus} {dmgBonusNote && <><i>{dmgBonusNote}</i> </>}</>}
            {ac != null && <> AC: {ac}</>}
            <br />
          </>
        )}
        {!skill && ac != null && <> AC: {ac}<br /></>}
        {(effectSpellId != null || effectSpellName) && (
          <>Effect: <SpellLink spellId={effectSpellId} name={effectSpellName} /> {effectNote && <>&nbsp;{effectNote}</>}<br /></>
        )}
        {skillMod && <>Skill Mod: {skillMod}<br /></>}
        {statsLine && <>{statsLine}<br /></>}
        {resistsLine && <>{resistsLine}<br /></>}
        {instrumentMods.length > 0 && instrumentMods.map((inst, i) => (
          <span key={i}>
            {inst.label != null && inst.label !== '' ? `${inst.label}: ` : ''}{inst.value}
            {inst.pct != null && <><i> ({inst.pct})</i></>}
            <br />
          </span>
        ))}
        {levelStr && <>{levelStr}<br /></>}
        {(focusSpellId != null || focusSpellName) && (
          <>Focus: <SpellLink spellId={focusSpellId} name={focusSpellName} /><br /></>
        )}
        {(weight != null || size) && (
          <>WT: {weight != null ? weight : '?'} Size: {size || '?'}<br /></>
        )}
        {classes && <>Class: {classes}<br /></>}
        {races && <>Race: {races}<br /></>}
        {light != null && <>Light: {light}<br /></>}
        {tint && <>Tint: {tint}<br /></>}
      </div>
    </div>
  )
}
