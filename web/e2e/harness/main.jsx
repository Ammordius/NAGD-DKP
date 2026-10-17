import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom'
import MobLoot from '../../src/pages/MobLoot.jsx'
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

function Harness() {
  const [userId, setUserId] = useState('user-a')
  return (
    <PageStateUserProvider userId={userId}>
      <BrowserRouter>
        <RouteScrollProvider>
          <nav>
            <Link to="/mobs">Raid Items</Link>
            <Link to="/dkp">DKP</Link>
            <button type="button" onClick={() => setUserId('user-a')}>User A</button>
            <button type="button" onClick={() => setUserId('user-b')}>User B</button>
            <span data-testid="current-user">{userId}</span>
          </nav>
          <Routes>
            <Route path="/mobs" element={<MobLoot />} />
            <Route path="/dkp" element={<DkpStub />} />
            <Route path="/items/:itemNameEncoded" element={<ItemStub />} />
            <Route path="*" element={<Navigate to="/mobs" replace />} />
          </Routes>
        </RouteScrollProvider>
      </BrowserRouter>
    </PageStateUserProvider>
  )
}

createRoot(document.getElementById('root')).render(<Harness />)
