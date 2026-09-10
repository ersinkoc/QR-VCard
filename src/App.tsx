import { Route, Routes } from 'react-router-dom';
import HomePage from './pages/HomePage';
import ScanPage from './pages/ScanPage';
import PanelPage from './pages/PanelPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      {/* The short URL encoded in every QR code: /c/<code> */}
      <Route path="/c/:code" element={<ScanPage />} />
      <Route path="/panel" element={<PanelPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}
