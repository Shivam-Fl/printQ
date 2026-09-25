import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getStudentSocket } from '../socket.js';

interface Toast {
  id: number;
  title: string;
  body: string;
  url?: string;
}

let nextId = 1;

/** In-app notifications: every server `notify` event surfaces here. */
export default function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    const socket = getStudentSocket();
    const onNotify = (p: { title: string; body: string; url?: string }) => {
      const toast = { id: nextId++, ...p };
      setToasts((t) => [...t.slice(-2), toast]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toast.id)), 6000);
    };
    const onFirebaseNotify = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== 'object') return;
      const payload = detail as { title?: unknown; body?: unknown; url?: unknown };
      if (typeof payload.title !== 'string' || typeof payload.body !== 'string') return;
      onNotify({ title: payload.title, body: payload.body, url: typeof payload.url === 'string' ? payload.url : undefined });
    };
    socket?.on('notify', onNotify);
    window.addEventListener('printq:firebase-notification', onFirebaseNotify);
    return () => {
      socket?.off('notify', onNotify);
      window.removeEventListener('printq:firebase-notification', onFirebaseNotify);
    };
  }, []);

  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="toast"
          onClick={() => {
            setToasts((x) => x.filter((y) => y.id !== t.id));
            if (t.url) navigate(t.url);
          }}
        >
          <strong>{t.title}</strong>
          <span>{t.body}</span>
        </div>
      ))}
    </div>
  );
}
