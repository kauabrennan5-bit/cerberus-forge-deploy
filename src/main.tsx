import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './design-system.css';
import './design-system-hero.css';
import './design-system-compact.css';
import './design-system-product-detail.css';
import './design-system-mobile-card-fix.css';
import './design-system-category-marquee-fix.css';
// Keep the approved Cerberus dark palette late in the cascade.
import './design-system-dark-surface.css';
// Archive title fix must be last so the original H1 stays hidden under the editorial pseudo-title.
import './design-system-archive-title-fix.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
