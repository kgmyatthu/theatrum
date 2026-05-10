import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './components/App';
import { AppProvider } from './state/AppContext';
import { ForceDraftProvider } from './state/ForceDraftContext';
import { AuthProvider } from './auth/AuthContext';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <AuthProvider>
      <AppProvider>
        <ForceDraftProvider>
          <App />
        </ForceDraftProvider>
      </AppProvider>
    </AuthProvider>
  </React.StrictMode>,
);
