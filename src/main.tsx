import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { AnalyticsConsentBanner } from './components/AnalyticsConsentBanner';
import { installSensitiveStorageGuard } from './lib/securityStorage';

installSensitiveStorageGuard();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <AnalyticsConsentBanner />
  </StrictMode>,
);
