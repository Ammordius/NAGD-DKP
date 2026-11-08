import { Suspense, lazy, useState } from 'react'
import { useLocation } from 'react-router-dom'
import './AssistantDock.css'

const RoastBot = lazy(() => import('./RoastBot.jsx'))
const PaperclipBot = lazy(() => import('./PaperclipBot.jsx'))

/**
 * Bottom-right dock: Paperclip + Inquisitor FABs side by side.
 * Parent gates mount on Fun Zone + session + profile.
 * Only one assistant panel open at a time; clicking the other swaps.
 */
export default function AssistantDock({ profile, session }) {
  const location = useLocation()
  const hide =
    location.pathname === '/login' ||
    location.pathname.startsWith('/auth/')

  const [active, setActive] = useState(/** @type {null | 'paperclip' | 'inquisitor'} */ (null))

  if (hide || !session || !profile) return null

  function toggle(id) {
    setActive((cur) => (cur === id ? null : id))
  }

  return (
    <div className="assistant-dock" data-testid="assistant-dock">
      <div className="assistant-dock-panel-slot">
        {active === 'paperclip' ? (
          <Suspense fallback={null}>
            <PaperclipBot
              open
              onOpenChange={(next) => setActive(next ? 'paperclip' : null)}
              showToggle={false}
            />
          </Suspense>
        ) : null}
        {active === 'inquisitor' ? (
          <Suspense fallback={null}>
            <RoastBot
              profile={profile}
              session={session}
              open
              onOpenChange={(next) => setActive(next ? 'inquisitor' : null)}
              showToggle={false}
            />
          </Suspense>
        ) : null}
      </div>

      <div className="assistant-dock-fabs" role="toolbar" aria-label="Site assistants">
        <button
          type="button"
          className="assistant-dock-fab assistant-dock-fab-paperclip"
          data-testid="assistant-dock-paperclip"
          aria-label={active === 'paperclip' ? 'Close Paperclip' : 'Open Paperclip'}
          aria-pressed={active === 'paperclip'}
          onClick={() => toggle('paperclip')}
        >
          📎
        </button>
        <button
          type="button"
          className="assistant-dock-fab assistant-dock-fab-inquisitor"
          data-testid="assistant-dock-inquisitor"
          aria-label={
            active === 'inquisitor' ? 'Close DKP Inquisitor' : 'Open DKP Inquisitor'
          }
          aria-pressed={active === 'inquisitor'}
          onClick={() => toggle('inquisitor')}
        >
          ☠
        </button>
      </div>
    </div>
  )
}
