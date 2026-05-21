import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { SpaceList } from './pages/SpaceList'
import { SpaceView } from './pages/SpaceView'
import { AuthGate } from './components/AuthGate'

export function App() {
  return (
    <BrowserRouter>
      <AuthGate>
        <Routes>
          <Route path="/" element={<SpaceList />} />
          <Route path="/admin" element={<SpaceList />} />
          <Route path="/admin/spaces/:spaceID" element={<SpaceView />} />
          <Route path="*" element={<div className="p-8">Not found</div>} />
        </Routes>
      </AuthGate>
    </BrowserRouter>
  )
}
