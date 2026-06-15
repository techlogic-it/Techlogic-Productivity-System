import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import PortalApp from './portal/PortalApp';
import './index.css';

// Apply the saved theme before first paint to avoid a flash of light mode.
if (localStorage.getItem('theme') === 'dark') {
  document.documentElement.classList.add('dark');
}

// Standalone product: the portal owns the whole app. Send the root to the portal.
if (window.location.pathname === '/') {
  window.history.replaceState(null, '', '/portal');
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <PortalApp />
    </BrowserRouter>
  </React.StrictMode>
);
