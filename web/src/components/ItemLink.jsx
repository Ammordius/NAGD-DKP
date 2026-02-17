import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { createPortal } from 'react-dom'
import ItemCard from './ItemCard'
import { getItemStats, getItemStatsCached } from '../lib/itemStats'

const HOVER_DELAY_MS = 400
const POPOVER_OFFSET = 8

/**
 * Link that shows a Discord-style item card on hover.
 * When externalHref is set (e.g. TAKP item URL), click goes there; otherwise uses React Router to /items/...
 * Pass itemId when known so we can show stats and TAKP link in the card.
 */
export default function ItemLink({ itemName, itemId, children, className, externalHref, ...linkProps }) {
  const [showCard, setShowCard] = useState(false)
  const [positionReady, setPositionReady] = useState(false)
  const [stats, setStats] = useState(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const timerRef = useRef(null)
  const anchorRef = useRef(null)

  const displayName = itemName || (typeof children === 'string' ? children : null) || 'Item'

  const showPopover = () => {
    timerRef.current = window.setTimeout(() => {
      const cached = itemId != null ? getItemStatsCached(itemId) : null
      if (cached) {
        setStats(cached)
        setShowCard(true)
        return
      }
      if (itemId != null) {
        getItemStats(itemId).then((s) => {
          setStats(s)
          setShowCard(true)
        })
      } else {
        setStats(null)
        setShowCard(true)
      }
    }, HOVER_DELAY_MS)
  }

  const hidePopover = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setShowCard(false)
    setPositionReady(false)
    setStats(null)
  }

  useEffect(() => {
    if (!showCard || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    const cardWidth = 320
    const cardHeight = 400
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    let left = rect.left + rect.width + POPOVER_OFFSET
    let top = rect.top
    if (left + cardWidth > viewportW - 12) left = rect.left - cardWidth - POPOVER_OFFSET
    if (left < 12) left = 12
    if (top + cardHeight > viewportH - 12) top = viewportH - cardHeight - 12
    if (top < 12) top = 12
    setPosition({ top, left })
    setPositionReady(true)
  }, [showCard])

  const popover = showCard && positionReady && createPortal(
    <div
      className="item-card-popover"
      style={{ top: position.top, left: position.left }}
      onMouseEnter={() => { if (timerRef.current) clearTimeout(timerRef.current); setShowCard(true) }}
      onMouseLeave={hidePopover}
      role="tooltip"
    >
      <ItemCard
        name={displayName}
        itemId={itemId}
        stats={stats}
        compact={itemId == null}
      />
    </div>,
    document.body
  )

  const isExternal = externalHref != null

  return (
    <>
      {isExternal ? (
        <a
          ref={anchorRef}
          href={externalHref}
          target="_blank"
          rel="noopener noreferrer"
          className={className}
          onMouseEnter={showPopover}
          onMouseLeave={hidePopover}
        >
          {children ?? displayName}
        </a>
      ) : (
        <Link
          ref={anchorRef}
          to={linkProps.to ?? `/items/${encodeURIComponent(displayName)}`}
          className={className}
          onMouseEnter={showPopover}
          onMouseLeave={hidePopover}
          {...linkProps}
        >
          {children ?? displayName}
        </Link>
      )}
      {popover}
    </>
  )
}
