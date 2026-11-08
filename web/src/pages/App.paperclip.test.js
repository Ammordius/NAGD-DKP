import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appSource = readFileSync(path.join(root, 'App.jsx'), 'utf8')
const paperclipSource = readFileSync(path.join(root, 'components', 'PaperclipBot.jsx'), 'utf8')
const dockSource = readFileSync(path.join(root, 'components', 'AssistantDock.jsx'), 'utf8')

describe('App Paperclip wiring', () => {
  it('mounts AssistantDock (Paperclip + Inquisitor) only when Fun Zone is enabled', () => {
    assert.match(appSource, /lazy\(\(\)\s*=>\s*import\('\.\/components\/AssistantDock\.jsx'\)\)/)
    assert.match(appSource, /funZoneEnabled && session && profile \? \([\s\S]*<AssistantDock/)
    assert.match(dockSource, /PaperclipBot/)
    assert.match(dockSource, /RoastBot/)
  })

  it('AssistantDock mounts after Routes so browser Back keeps conversation', () => {
    const routesClose = appSource.indexOf('</Routes>')
    const mount = appSource.indexOf('<AssistantDock')
    assert.ok(routesClose >= 0)
    assert.ok(mount > routesClose)
  })

  it('Paperclip shows labeled external links, not raw URLs as the link text', () => {
    assert.match(paperclipSource, /pathname === '\/login'/)
    assert.match(paperclipSource, /href=\{link\.href\}/)
    assert.match(paperclipSource, /\{link\.label \|\| link\.href\}/)
    assert.doesNotMatch(paperclipSource, />\s*\{link\.href\}\s*</)
    assert.match(paperclipSource, /target="_blank"/)
    assert.match(paperclipSource, /rel="noopener noreferrer"/)
  })

  it('Paperclip is redirect-only (no roast / account facts)', () => {
    assert.doesNotMatch(paperclipSource, /buildAccountFacts|Magelo|funZone/)
    assert.match(paperclipSource, /buildRedirectReply/)
  })

  it('dock keeps only one assistant open and FABs sit side by side', () => {
    assert.match(dockSource, /active === 'paperclip'/)
    assert.match(dockSource, /active === 'inquisitor'/)
    assert.match(dockSource, /assistant-dock-fabs/)
    assert.match(dockSource, /showToggle=\{false\}/)
  })
})
