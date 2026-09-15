import { io, type Socket } from 'socket.io-client';
import { API_URL, getToken, renewStudentSession } from './api.js';

let studentSocket: Socket | null = null;
let shopSocket: Socket | null = null;

// empty API_URL = same origin (Vite proxy in dev, API-served app in prod)
const target = API_URL || '/';

export function getStudentSocket(): Socket | null {
  const token = getToken('student');
  if (!token) return null;
  if (!studentSocket) {
    studentSocket = io(target, { auth: { token } });
    studentSocket.on('connect_error', (error) => {
      if (error.message !== 'unauthorized' || !studentSocket) return;
      void renewStudentSession().then((freshToken) => {
        if (!freshToken || !studentSocket) return;
        studentSocket.auth = { token: freshToken };
        studentSocket.connect();
      });
    });
  }
  return studentSocket;
}

export function getShopSocket(): Socket | null {
  const token = getToken('shop');
  if (!token) return null;
  shopSocket ??= io(target, { auth: { token } });
  return shopSocket;
}

export function resetSockets(): void {
  studentSocket?.disconnect();
  shopSocket?.disconnect();
  studentSocket = null;
  shopSocket = null;
}
