import { Route, Routes } from 'react-router-dom';
import HomePage from './pages/HomePage';
import PanelPage from './pages/panel/PanelPage';
import ScanPage from './pages/ScanPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      {/* The short URL encoded in every QR code: /c/<code> */}
      <Route path="/c/:code" element={<ScanPage />} />
      {/* The owner's personal short URL: /<username> (primary card) */}
      <Route path="/:username" element={<ScanPage byUsername />} />
      {/* /panel (cards), /panel/users (admins), /panel/account */}
      <Route path="/panel/*" element={<PanelPage />} />
      <Route path="*" element={<HomePage />} />
    </Routes>
  );
}
