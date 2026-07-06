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
    if (!socket) return;
    const onNotify = (p: { title: string; body: string; url?: string }) => {
      const toast = { id: nextId++, ...p };
      setToasts((t) => [...t.slice(-2), toast]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toast.id)), 6000);
    };
    socket.on('notify', onNotify);
    return () => {
      socket.off('notify', onNotify);
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
