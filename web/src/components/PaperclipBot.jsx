import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  BOT_NAME,
  BOT_TAGLINE,
  buildRedirectReply,
  greetingMessage,
} from '../lib/paperclip/index.js'
import './PaperclipBot.css'

/**
 * Floating redirect-only guide pointer. Authenticated users only (parent gates mount).
 * Not Fun Zone — utility for members. Links are external (guildtag / Google Docs).
 */
export default function PaperclipBot({ openOnMount = false }) {
  const location = useLocation()
  const hide =
    location.pathname === '/login' ||
    location.pathname.startsWith('/auth/')

  const [open, setOpen] = useState(openOnMount)
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
    if (!open || startedRef.current) return
    startedRef.current = true
    restart()
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
    <div className="paperclip-bot-root" data-testid="paperclip-bot-root">
      {open ? (
        <div className="paperclip-bot-panel" data-testid="paperclip-bot-panel" role="dialog" aria-label={BOT_NAME}>
          <div className="paperclip-bot-header">
            <div>
              <h2>{BOT_NAME}</h2>
              <p className="paperclip-bot-tagline">{BOT_TAGLINE}</p>
            </div>
            <div className="paperclip-bot-header-actions">
              <button
                type="button"
                className="paperclip-bot-restart"
                data-testid="paperclip-bot-restart"
                onClick={restart}
              >
                Clear
              </button>
              <button
                type="button"
                className="paperclip-bot-close"
                aria-label="Close Paperclip"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
          </div>

          <div
            className="paperclip-bot-messages"
            ref={listRef}
            data-testid="paperclip-bot-messages"
            onScroll={onMessagesScroll}
          >
            {messages.map((msg, i) => (
              <div
                key={`${msg.role}-${i}`}
                className={`paperclip-bot-msg paperclip-bot-msg-${msg.role}`}
                data-testid={msg.role === 'bot' ? 'paperclip-bot-reply' : 'paperclip-bot-user-msg'}
              >
                <div>{msg.text}</div>
                {msg.links?.length ? (
                  <div className="paperclip-bot-links">
                    {msg.links.map((link) => (
                      <a
                        key={`${link.href}-${link.label}`}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {link.href}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="paperclip-bot-chips" data-testid="paperclip-bot-chips">
            {suggestions.map((chip) => (
              <button
                key={chip}
                type="button"
                className="paperclip-bot-chip"
                onClick={() => send(chip)}
                disabled={busy}
              >
                {chip}
              </button>
            ))}
          </div>

          <form
            className="paperclip-bot-input-row"
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
              placeholder="Ask about a guide topic…"
              aria-label="Message Paperclip"
              disabled={busy}
            />
            <button
              type="submit"
              className="paperclip-bot-send"
              data-testid="paperclip-bot-send"
              disabled={busy || !input.trim()}
            >
              Send
            </button>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        className="paperclip-bot-toggle"
        data-testid="paperclip-bot-toggle"
        aria-label={open ? 'Close Paperclip' : 'Open Paperclip'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        📎
      </button>
    </div>
  )
}
