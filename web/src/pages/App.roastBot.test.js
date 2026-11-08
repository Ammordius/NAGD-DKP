import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appSource = readFileSync(path.join(root, 'App.jsx'), 'utf8')
const roastSource = readFileSync(path.join(root, 'components', 'RoastBot.jsx'), 'utf8')

const dockSource = readFileSync(path.join(root, 'components', 'AssistantDock.jsx'), 'utf8')

describe('App RoastBot wiring', () => {
  it('loads Inquisitor through Fun Zone–gated AssistantDock', () => {
    assert.match(appSource, /lazy\(\(\)\s*=>\s*import\('\.\/components\/AssistantDock\.jsx'\)\)/)
    assert.match(appSource, /import \{ isFunZoneEnabled \} from '\.\/lib\/funZone'/)
    assert.match(appSource, /funZoneEnabled && session && profile \? \([\s\S]*<AssistantDock/)
    assert.match(dockSource, /lazy\(\(\)\s*=>\s*import\('\.\/RoastBot\.jsx'\)\)/)
    assert.match(dockSource, /<RoastBot/)
    assert.match(appSource, /Suspense/)
  })

  it('RoastBot hides on login/auth routes and has no personality settings UI', () => {
    assert.match(roastSource, /pathname === '\/login'/)
    assert.match(roastSource, /DKP Inquisitor/)
    assert.doesNotMatch(roastSource, /sarcasmLevel|personalitySettings|roastPreferences/)
  })

  it('RoastBot header includes New judgment restart control', () => {
    assert.match(roastSource, /data-testid="roast-bot-restart"/)
    assert.match(roastSource, /New judgment/)
    assert.match(roastSource, /startConversation\(facts\)/)
  })

  it('AssistantDock mounts after Routes so browser Back keeps conversation', () => {
    const routesClose = appSource.indexOf('</Routes>')
    const dockMount = appSource.indexOf('<AssistantDock')
    assert.ok(routesClose >= 0, 'expected </Routes> in App.jsx')
    assert.ok(dockMount >= 0, 'expected <AssistantDock in App.jsx')
    assert.ok(
      dockMount > routesClose,
      'AssistantDock must render after </Routes> so SPA Back does not remount the chat',
    )
  })

  it('RoastBot outbound links and upgrade cards use React Router Link', () => {
    assert.match(roastSource, /from 'react-router-dom'/)
    assert.match(roastSource, /<Link key=\{`\$\{link\.type\}-\$\{link\.to\}`\} to=\{link\.to\}>/)
    assert.match(roastSource, /<Link to=\{card\.to\}>\{card\.itemName\}<\/Link>/)
    assert.doesNotMatch(roastSource, /window\.location|href=\{link\.to\}|navigate\(link\.to\)/)
  })

  it('RoastBot supports controlled open and optional FAB for the shared dock', () => {
    assert.match(roastSource, /showToggle = true/)
    assert.match(roastSource, /onOpenChange/)
    assert.match(roastSource, /showToggle \? \(/)
  })
})
