import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'printq:installPromptDismissed';

/** Turns the bare browser install affordance into a visible, dismissible banner. */
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === '1');

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!deferred || dismissed) return null;

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, '1');
    setDismissed(true);
  }

  return (
    <div className="card row between" style={{ alignItems: 'center' }}>
      <div>
        <strong>Add PrintQ to your home screen</strong>
        <p className="dim" style={{ margin: '2px 0 0' }}>Faster access, works like an app.</p>
      </div>
      <div className="row" style={{ flexWrap: 'nowrap', flexShrink: 0 }}>
        <button
          className="small"
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
          }}
        >
          Install
        </button>
        <button className="ghost small" onClick={dismiss}>Not now</button>
      </div>
    </div>
  );
}
