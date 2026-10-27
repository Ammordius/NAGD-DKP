import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom'
import MobLoot from '../../src/pages/MobLoot.jsx'
import RoastBot from '../../src/components/RoastBot.jsx'
import { buildAccountFacts } from '../../src/lib/roastBot/facts.js'
import { PageStateUserProvider } from '../../src/lib/pageStateUser'
import { RouteScrollProvider, useScrollContentReady } from '../../src/lib/routeScrollView'
import '../../src/index.css'
import './harness.css'

function DkpStub() {
  useScrollContentReady(true)
  return (
    <div className="container">
      <h1>DKP</h1>
      <table>
        <tbody>
          <tr data-scroll-anchor="dkp-account">
            <td>Account</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function ItemStub() {
  useScrollContentReady(true)
  return (
    <div className="container">
      <h1>Item</h1>
    </div>
  )
}

function RoastBotHarness() {
  useScrollContentReady(true)
  const noAccount = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('noAccount')
  const facts = useMemo(
    () =>
      noAccount
        ? buildAccountFacts({})
        : buildAccountFacts({
            accountId: 'acct-e2e',
            accountName: 'E2E Account',
            currentDkp: 42,
            earnedDkp: 800,
            spentDkp: 758,
            characters: [
              { char_id: 'w1', name: 'Zender', class_name: 'Warrior' },
              { char_id: 'c1', name: 'Zenderheals', class_name: 'Cleric' },
              { char_id: 'e1', name: 'Iaminae', class_name: 'Enchanter' },
              { char_id: 'e2', name: 'Charmalt', class_name: 'Enchanter' },
              { char_id: 'm1', name: 'Ammomats', class_name: 'Magician' },
            ],
            lootRows: [
              {
                id: 1,
                item_name: 'Smooth Onyx Torque',
                cost: 180,
                char_id: 'w1',
                character_name: 'Zender',
                sale_date: '2026-09-01',
              },
              {
                id: 2,
                item_name: 'Beguiler Circlet',
                cost: 220,
                char_id: 'e1',
                character_name: 'Iaminae',
                assigned_char_id: 'e1',
                assigned_character_name: 'Iaminae',
                sale_date: '2026-09-15',
              },
              {
                id: 3,
                item_name: 'Robes of the Elementalist',
                cost: 40,
                char_id: 'm1',
                character_name: 'Ammomats',
                assigned_char_id: 'm1',
                assigned_character_name: 'Ammomats',
                sale_date: '2026-09-12',
              },
            ],
            recentItemPrices: {
              'smooth onyx torque': { values: [150, 180, 160], avg: '163.3' },
              'beguiler circlet': { values: [200, 220], avg: '210' },
            },
            itemCatalog: [
              { name: 'Smooth Onyx Torque', itemId: 99 },
              { name: 'Beguiler Circlet', itemId: 501 },
            ],
            knownItemSources: {
              'smooth onyx torque': { zone: 'Plane of Time', mob: 'Quarm' },
              'beguiler circlet': { zone: 'Plane of Time', mob: 'Quarm' },
            },
            guildRaidCountInWindow: 20,
            attendanceRows: [
              { raid_id: 'r1', char_id: 'w1', character_name: 'Zender', account_id: 'acct-e2e' },
            ],
            raidsById: {
              r1: { raid_id: 'r1', raid_name: 'Plane of Time', date_iso: '2026-10-01' },
            },
            now: new Date('2026-10-20T12:00:00Z'),
          }),
    [noAccount],
  )
  const profile = noAccount ? { account_id: null } : { account_id: 'acct-e2e' }
  const session = { user: { id: 'user-e2e' } }
  return (
    <div className="container">
      <h1>Roast Bot Harness</h1>
      <RoastBot profile={profile} session={session} factsOverride={facts} openOnMount />
    </div>
  )
}

function Harness() {
  const [userId, setUserId] = useState('user-a')
  return (
    <PageStateUserProvider userId={userId}>
      <BrowserRouter>
        <RouteScrollProvider>
          <nav>
            <Link to="/mobs">Raid Items</Link>
            <Link to="/dkp">DKP</Link>
            <Link to="/roast-bot">Roast Bot</Link>
            <button type="button" onClick={() => setUserId('user-a')}>User A</button>
            <button type="button" onClick={() => setUserId('user-b')}>User B</button>
            <span data-testid="current-user">{userId}</span>
          </nav>
          <Routes>
            <Route path="/mobs" element={<MobLoot />} />
            <Route path="/dkp" element={<DkpStub />} />
            <Route path="/items/:itemNameEncoded" element={<ItemStub />} />
            <Route path="/characters/:charKey" element={<ItemStub />} />
            <Route path="/roast-bot" element={<RoastBotHarness />} />
            <Route path="*" element={<Navigate to="/mobs" replace />} />
          </Routes>
        </RouteScrollProvider>
      </BrowserRouter>
    </PageStateUserProvider>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
