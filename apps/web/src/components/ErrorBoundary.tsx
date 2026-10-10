import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** 'app' = full-screen last resort; 'route' = inline, the rest of the shell stays usable. */
  level?: 'app' | 'route';
}

/** Catches render-time crashes (e.g. an API answering 200 with an unexpected body). */
export default class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    // Console only: no user data is attached, and nothing is sent anywhere.
    console.error('ui_crash', error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const appLevel = this.props.level === 'app';
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return (
      <main className="page crash-screen" role="alert">
        <div className="empty-state">
          <strong>{offline ? 'You are offline' : 'Something went wrong'}</strong>
          <p>
            {offline
              ? 'This page is not saved on your device yet. Reconnect to the internet and reload.'
              : appLevel
              ? 'PrintQs hit an unexpected problem. Reloading usually fixes it.'
              : 'This page hit an unexpected problem. You can reload it or go back to the start.'}
          </p>
          <div className="welcome-actions" style={{ justifyContent: 'center' }}>
            <button type="button" onClick={() => window.location.reload()}>Reload</button>
            <a className="button-link secondary" href="/">Go to Home</a>
          </div>
        </div>
      </main>
    );
  }
}
