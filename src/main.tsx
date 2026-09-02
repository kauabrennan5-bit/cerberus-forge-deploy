import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './design-system.css';
import './design-system-hero.css';
import './design-system-compact.css';
import './design-system-mobile-card-fix.css';
import './design-system-category-marquee-fix.css';
import './design-system-product-detail.css';
import './design-system-dark-surface.css';
import './design-system-archive-title-fix.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
