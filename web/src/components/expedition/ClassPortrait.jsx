import { useEffect, useState } from 'react'
import { getClassDef } from '../../lib/expedition/classDefinitions.js'
import { resolveClassSprite } from '../../lib/expedition/assets.js'
import { DEFAULT_APPEARANCE_MODE } from '../../lib/expedition/appearance.js'

/**
 * Pixel class portrait with emoji/abbrev fallback when the sprite is missing or fails.
 *
 * @param {{
 *   className?: string,
 *   unitClass?: string|null,
 *   size?: number,
 *   flags?: string[],
 *   showKoLabel?: boolean,
 *   appearanceMode?: 'classic'|'gnomes'|string,
 * }} props
 */
export default function ClassPortrait({
  className = '',
  unitClass,
  size = 64,
  flags = [],
  showKoLabel = false,
  appearanceMode = DEFAULT_APPEARANCE_MODE,
}) {
  const src = resolveClassSprite(unitClass, appearanceMode)
  const def = getClassDef(unitClass)
  const [failed, setFailed] = useState(false)
  const showSprite = Boolean(src) && !failed
  const flagClass = (flags || []).filter(Boolean).join(' ')
  const isDown = (flags || []).includes('is-down')

  useEffect(() => {
    setFailed(false)
  }, [src, appearanceMode])

  return (
    <div
      className={`exp-portrait exp-class-portrait ${flagClass} ${className}`.trim()}
      aria-hidden="true"
    >
      {showSprite ? (
        <img
          className="exp-class-sprite"
          src={src}
          alt=""
          width={size}
          height={size}
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="exp-class-fallback" style={{ color: def.color }}>
          {def.symbol}
        </span>
      )}
      {isDown && showKoLabel ? <span className="exp-ko-label">KO</span> : null}
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
