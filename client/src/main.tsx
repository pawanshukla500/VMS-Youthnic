import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Icons stay hidden until their font is ready (see index.css) — never show
// raw ligature names. If loading fails, they stay hidden rather than garbled.
if (typeof document !== 'undefined' && document.fonts?.load) {
  document.fonts
    .load('24px "Material Symbols Outlined"', 'home')
    .then((faces) => {
      if (faces.length > 0) document.documentElement.classList.add('icons-ready');
    })
    .catch(() => undefined);
} else {
  document.documentElement.classList.add('icons-ready');
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
