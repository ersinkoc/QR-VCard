import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import UpdatePrompt, { announceUpdate } from './components/UpdatePrompt';
import { I18nProvider } from './i18n';
import './index.css';
import './fonts.css';
import './page-card.css';

// A new version waits for the person (see UpdatePrompt) instead of reloading open tabs.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    announceUpdate(() => void updateSW(true));
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <App />
        <UpdatePrompt />
      </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
);
