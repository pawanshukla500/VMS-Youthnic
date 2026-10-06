import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Icons stay hidden until their font is ready (see index.css) so raw
// ligature names never flash. If the font fails or is slow (>4 s), show
// them anyway: a boxed fallback beats invisible icon-only buttons.
const showIcons = () => document.documentElement.classList.add('icons-ready');
if (typeof document !== 'undefined' && document.fonts?.load) {
  const fallback = setTimeout(showIcons, 4000);
  document.fonts
    .load('24px "Material Symbols Outlined"', 'home')
    .catch(() => [])
    .finally(() => {
      clearTimeout(fallback);
      showIcons();
    });
} else {
  showIcons();
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
