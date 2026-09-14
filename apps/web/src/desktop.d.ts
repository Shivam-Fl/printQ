interface PrintQsDesktopStatus {
  state: 'setup_required' | 'connecting' | 'online' | 'offline' | 'error';
  detail: string;
  lastUpdatedAt: string;
}

interface PrintQsDesktopBridge {
  load(): Promise<{
    config: {
      configured: boolean;
      apiUrl: string;
      webUrl: string;
      mode: 'real' | 'simulate';
    };
    status: PrintQsDesktopStatus;
    appVersion: string;
  }>;
  configure(config: {
    apiUrl: string;
    webUrl: string;
    token: string;
    mode: 'real' | 'simulate';
  }): Promise<{ ok: true; status: PrintQsDesktopStatus }>;
  restart(): Promise<PrintQsDesktopStatus>;
  openDashboard(): Promise<void>;
  onStatus(callback: (status: PrintQsDesktopStatus) => void): () => void;
}

interface Window {
  printqsDesktop?: PrintQsDesktopBridge;
}
