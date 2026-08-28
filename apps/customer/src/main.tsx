import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App.js';
import { SessionProvider } from './state.js';
import './styles.css';

class AppErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="phone">
          <div className="prototype-strip">SIMULATED PROTOTYPE — demo biometrics · no real money</div>
          <main className="screen center-screen">
            <div className="callout warn" role="alert">
              <strong>We couldn’t open your wallet</strong>
              <span>{this.state.error.message || 'Unexpected app error'}</span>
              <button className="ghost" onClick={() => window.location.reload()}>Reload wallet</button>
            </div>
          </main>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <SessionProvider>
          <App />
        </SessionProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>
);
