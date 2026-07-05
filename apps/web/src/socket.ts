import { io, type Socket } from 'socket.io-client';
import { API_URL, getToken } from './api.js';

let studentSocket: Socket | null = null;
let shopSocket: Socket | null = null;

export function getStudentSocket(): Socket | null {
  const token = getToken('student');
  if (!token) return null;
  if (!studentSocket) {
    studentSocket = io(API_URL, { auth: { token } });
  }
  return studentSocket;
}

export function getShopSocket(): Socket | null {
  const token = getToken('shop');
  if (!token) return null;
  if (!shopSocket) {
    shopSocket = io(API_URL, { auth: { token } });
  }
  return shopSocket;
}

export function resetSockets(): void {
  studentSocket?.disconnect();
  shopSocket?.disconnect();
  studentSocket = null;
  shopSocket = null;
}
