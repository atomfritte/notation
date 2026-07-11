import { useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { SpaceList } from './pages/SpaceList'
import { SpaceView } from './pages/SpaceView'
import { PrintSpaceView } from './pages/PrintSpaceView'
import { AuthGate } from './components/AuthGate'
import { initTheme } from './lib/theme'

export function App() {
  // Push the user's last picked accent colour into :root before the first
  // paint so we don't flash the default lime for a frame on every load.
  useEffect(() => { initTheme() }, [])
  return (
    <BrowserRouter>
      <AuthGate>
        <Routes>
          <Route path="/" element={<SpaceList />} />
          <Route path="/admin" element={<SpaceList />} />
          <Route path="/admin/spaces/:spaceID" element={<SpaceView />} />
          <Route path="/admin/spaces/:spaceID/print" element={<PrintSpaceView />} />
          <Route path="*" element={<div className="p-8">Not found</div>} />
        </Routes>
      </AuthGate>
    </BrowserRouter>
  )
}
