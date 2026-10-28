import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appSource = readFileSync(path.join(root, 'App.jsx'), 'utf8')
const expeditionDir = path.join(root, 'lib', 'expedition')
const expeditionPage = readFileSync(path.join(root, 'pages', 'Expedition.jsx'), 'utf8')

function allExpeditionSources() {
  const files = readdirSync(expeditionDir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  const componentDir = path.join(root, 'components', 'expedition')
  const comps = readdirSync(componentDir).filter((f) => f.endsWith('.jsx'))
  return [
    expeditionPage,
    ...files.map((f) => readFileSync(path.join(expeditionDir, f), 'utf8')),
    ...comps.map((f) => readFileSync(path.join(componentDir, f), 'utf8')),
  ].join('\n')
}

describe('App Expedition wiring', () => {
  it('lazy-loads Expedition on /games/expedition and links Expedition in nav', () => {
    assert.match(appSource, /lazy\(\(\)\s*=>\s*import\('\.\/pages\/Expedition\.jsx'\)\)/)
    assert.match(appSource, /path="\/games\/expedition"/)
    assert.match(appSource, /to="\/games\/expedition"/)
    assert.match(appSource, /<Expedition profile=\{profile\}/)
    // Not eagerly imported at top of App
    assert.doesNotMatch(appSource, /^import Expedition from/m)
  })

  it('gates Expedition nav and route behind isFunZoneEnabled', () => {
    assert.match(appSource, /import \{ isFunZoneEnabled \} from '\.\/lib\/funZone'/)
    assert.match(appSource, /const funZoneEnabled = isFunZoneEnabled\(\)/)
    assert.match(appSource, /funZoneEnabled \? <Link to="\/games\/expedition">Expedition<\/Link> : null/)
    assert.match(appSource, /path="\/games\/expedition"\s+element=\{funZoneEnabled \? \(/)
    assert.match(appSource, /<Navigate to="\/" replace \/>/)
    // Fun Zone is independent of the production/development banner flag
    assert.match(appSource, /const funZoneEnabled = isFunZoneEnabled\(\)/)
    assert.doesNotMatch(appSource, /funZoneEnabled\s*=\s*isProductionSite/)
  })

  it('game modules avoid Magelo, AccountDetail page, roastBot, and guild map hooks', () => {
    const src = allExpeditionSources()
    assert.doesNotMatch(src, /mageloUpgradeEngine|classCoverage|item_stats|itemStats/)
    assert.doesNotMatch(src, /useCharToAccountMap|fetchAccountDetail|pages\/AccountDetail|from ['"].*AccountDetail/)
    assert.doesNotMatch(src, /lib\/roastBot|components\/RoastBot|from ['"].*roastBot/)
    assert.doesNotMatch(src, /fetchActiveRoster|dkpLeaderboard|useDkpData/)
  })

  it('Expedition page does not fetch on mount — only on Assemble', () => {
    assert.match(expeditionPage, /Assemble Your Party/)
    assert.match(expeditionPage, /resolveExpeditionRoster/)
    // assembleParty is click-driven, not useEffect on mount for roster
    assert.doesNotMatch(expeditionPage, /useEffect\(\s*\(\)\s*=>\s*\{[^}]*resolveExpeditionRoster/s)
  })
})
