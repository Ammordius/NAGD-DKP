import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  BOT_NAME,
  BOT_TAGLINE,
  buildRedirectReply,
  greetingMessage,
} from '../lib/paperclip/index.js'
import './RoastBot.css'
import './PaperclipBot.css'

/**
 * Redirect-only guide pointer. Uses Inquisitor panel chrome for visual parity.
 * Links show human labels, not raw URLs.
 *
 * @param {{
 *   openOnMount?: boolean,
 *   open?: boolean,
 *   onOpenChange?: (open: boolean) => void,
 *   showToggle?: boolean,
 * }} props
 */
export default function PaperclipBot({
  openOnMount = false,
  open: openProp,
  onOpenChange,
  showToggle = true,
}) {
  const location = useLocation()
  const hide =
    location.pathname === '/login' ||
    location.pathname.startsWith('/auth/')

  const controlled = openProp !== undefined
  const [openUncontrolled, setOpenUncontrolled] = useState(openOnMount)
  const open = controlled ? Boolean(openProp) : openUncontrolled

  function setOpen(next) {
    const value = typeof next === 'function' ? next(open) : next
    if (!controlled) setOpenUncontrolled(value)
    onOpenChange?.(value)
  }

  const [input, setInput] = useState('')
  const [messages, setMessages] = useState([])
  const [suggestions, setSuggestions] = useState([])
  const [busy, setBusy] = useState(false)
  const listRef = useRef(null)
  const stickToBottomRef = useRef(true)
  const startedRef = useRef(false)

  const restart = useCallback(() => {
    const greet = greetingMessage()
    setMessages([{ role: 'bot', text: greet.text, links: greet.links }])
    setSuggestions(greet.suggestions)
    setInput('')
  }, [])

  useEffect(() => {
    if (!open) return
    if (!startedRef.current) {
      startedRef.current = true
      restart()
    }
  }, [open, restart])

  const onMessagesScroll = () => {
    const el = listRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = dist < 48
  }

  useEffect(() => {
    if (!open || !stickToBottomRef.current) return
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open])

  const send = useCallback(
    (raw) => {
      const text = String(raw || '').trim()
      if (!text || busy) return
      setBusy(true)
      setInput('')
      setMessages((prev) => [...prev, { role: 'user', text }])
      try {
        const reply = buildRedirectReply(text)
        setMessages((prev) => [
          ...prev,
          { role: 'bot', text: reply.text, links: reply.links || [] },
        ])
        setSuggestions(reply.suggestions || [])
      } finally {
        setBusy(false)
      }
    },
    [busy],
  )

  if (hide) return null

  return (
    <div
      className="paperclip-bot-root roast-bot-root"
      data-testid="paperclip-bot-root"
      data-open={open ? '1' : '0'}
    >
      {open ? (
        <div
          className="paperclip-bot-panel roast-bot-panel"
          data-testid="paperclip-bot-panel"
          role="dialog"
          aria-label={BOT_NAME}
        >
          <div className="roast-bot-header">
            <div>
              <h2>{BOT_NAME}</h2>
              <p className="roast-bot-tagline">{BOT_TAGLINE}</p>
            </div>
            <div className="roast-bot-header-actions">
              <button
                type="button"
                className="roast-bot-restart"
                data-testid="paperclip-bot-restart"
                onClick={restart}
              >
                Clear
              </button>
              <button
                type="button"
                className="roast-bot-close"
                aria-label="Close Paperclip"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
          </div>

          <div
            className="roast-bot-messages"
            ref={listRef}
            data-testid="paperclip-bot-messages"
            onScroll={onMessagesScroll}
          >
            {messages.map((msg, i) => (
              <div
                key={`${msg.role}-${i}`}
                className={`roast-bot-msg roast-bot-msg-${msg.role}`}
                data-testid={msg.role === 'bot' ? 'paperclip-bot-reply' : 'paperclip-bot-user-msg'}
              >
                <div>{msg.text}</div>
                {msg.links?.length ? (
                  <div className="roast-bot-links paperclip-bot-links">
                    {msg.links.map((link) => (
                      <a
                        key={`${link.href}-${link.label}`}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={link.href}
                      >
                        {link.label || link.href}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {suggestions.length ? (
            <div className="roast-bot-chips" data-testid="paperclip-bot-chips">
              {suggestions.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className="roast-bot-chip"
                  onClick={() => send(chip)}
                  disabled={busy}
                >
                  {chip}
                </button>
              ))}
            </div>
          ) : null}

          <form
            className="roast-bot-input-row"
            onSubmit={(e) => {
              e.preventDefault()
              send(input)
            }}
          >
            <input
              data-testid="paperclip-bot-input"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about flags, PoTime, DKP, or a guide…"
              aria-label="Message Paperclip"
              disabled={busy}
            />
            <button
              type="submit"
              className="roast-bot-send"
              data-testid="paperclip-bot-send"
              disabled={busy || !input.trim()}
            >
              Send
            </button>
          </form>
        </div>
      ) : null}

      {showToggle ? (
        <button
          type="button"
          className="roast-bot-toggle paperclip-bot-toggle"
          data-testid="paperclip-bot-toggle"
          aria-label={open ? 'Close Paperclip' : 'Open Paperclip'}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          📎
        </button>
      ) : null}
    </div>
  )
}
