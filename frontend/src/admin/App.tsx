import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { SpaceList } from './pages/SpaceList'
import { SpaceView } from './pages/SpaceView'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SpaceList />} />
        <Route path="/admin" element={<SpaceList />} />
        <Route path="/admin/spaces/:spaceID" element={<SpaceView />} />
        <Route path="*" element={<div className="p-8">Not found</div>} />
      </Routes>
    </BrowserRouter>
  )
}
