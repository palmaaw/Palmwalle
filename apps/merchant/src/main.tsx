import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App.js';
import { PosProvider } from './state.js';
import './styles.css';

class PosErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }
  override render(): React.ReactNode {
    if (this.state.error) {
      return <div className="phone pos"><div className="prototype-strip">SIMULATED PROTOTYPE — demo biometrics · no real money</div><main className="screen"><div className="callout warn" role="alert"><strong>POS could not start</strong><span>{this.state.error.message || 'Unexpected scanner error'}</span><button className="ghost" onClick={() => window.location.reload()}>Reload POS</button></div></main></div>;
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PosErrorBoundary>
      <BrowserRouter>
        <PosProvider>
          <App />
        </PosProvider>
      </BrowserRouter>
    </PosErrorBoundary>
  </React.StrictMode>
);
