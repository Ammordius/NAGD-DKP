import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appSource = readFileSync(path.join(root, 'App.jsx'), 'utf8')
const paperclipSource = readFileSync(path.join(root, 'components', 'PaperclipBot.jsx'), 'utf8')

describe('App Paperclip wiring', () => {
  it('lazy-loads PaperclipBot for authenticated users with profile, not Fun Zone', () => {
    assert.match(appSource, /lazy\(\(\)\s*=>\s*import\('\.\/components\/PaperclipBot\.jsx'\)\)/)
    const paperclipBlock = appSource.match(
      /\{session && profile \? \(\s*<Suspense fallback=\{null\}>\s*<PaperclipBot \/>/,
    )
    assert.ok(paperclipBlock, 'expected Paperclip mount gated only on session && profile')
    assert.doesNotMatch(paperclipBlock[0], /funZoneEnabled/)
  })

  it('Paperclip mounts after Routes so browser Back keeps conversation', () => {
    const routesClose = appSource.indexOf('</Routes>')
    const mount = appSource.indexOf('<PaperclipBot')
    assert.ok(routesClose >= 0)
    assert.ok(mount > routesClose)
  })

  it('Paperclip hides on login/auth and uses external href links', () => {
    assert.match(paperclipSource, /pathname === '\/login'/)
    assert.match(paperclipSource, /Paperclip/)
    assert.match(paperclipSource, /href=\{link\.href\}/)
    assert.match(paperclipSource, /target="_blank"/)
    assert.match(paperclipSource, /rel="noopener noreferrer"/)
  })

  it('Paperclip is redirect-only (no roast / account facts)', () => {
    assert.doesNotMatch(paperclipSource, /buildAccountFacts|roastBot|Magelo|funZone/)
    assert.match(paperclipSource, /buildRedirectReply/)
  })
})
