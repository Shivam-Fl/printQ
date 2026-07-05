import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../lib/tokens.js';
import { hashAgentToken } from '../lib/otp.js';
import { subscribeEvents } from './events.js';

/**
 * Socket topology:
 *  - students join  student:<studentId>   (their job updates)
 *  - shop staff join shop:<shopId>        (live queue)
 *  - agents join    agent:<agentId>       (print dispatch)
 * Rooms are assigned server-side from verified credentials — clients never
 * pick their own rooms.
 */
export function setupRealtime(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGINS, credentials: false },
  });

  io.use(async (socket, next) => {
    const { token, agentToken } = socket.handshake.auth as {
      token?: string;
      agentToken?: string;
    };

    if (typeof agentToken === 'string' && agentToken.length >= 32) {
      const agent = await prisma.agent.findUnique({
        where: { tokenHash: hashAgentToken(agentToken) },
      });
      if (!agent) return next(new Error('unauthorized'));
      socket.data.kind = 'agent';
      socket.data.agentId = agent.id;
      socket.data.shopId = agent.shopId;
      return next();
    }

    const claims = typeof token === 'string' ? verifyToken(token) : null;
    if (!claims) return next(new Error('unauthorized'));
    if (claims.typ === 'student') {
      socket.data.kind = 'student';
      socket.data.studentId = claims.sub;
      return next();
    }
    socket.data.kind = 'shop';
    socket.data.shopId = claims.shopId;
    return next();
  });

  io.on('connection', async (socket) => {
    const { kind } = socket.data as { kind: 'student' | 'shop' | 'agent' };
    if (kind === 'student') {
      await socket.join(`student:${socket.data.studentId}`);
    } else if (kind === 'shop') {
      await socket.join(`shop:${socket.data.shopId}`);
    } else {
      await socket.join(`agent:${socket.data.agentId}`);
      await prisma.agent.update({
        where: { id: socket.data.agentId as string },
        data: { status: 'online', lastHeartbeatAt: new Date() },
      });

      socket.on('disconnect', async () => {
        try {
          await prisma.agent.update({
            where: { id: socket.data.agentId as string },
            data: { status: 'offline' },
          });
        } catch (err) {
          logger.error({ err }, 'agent_disconnect_update_failed');
        }
      });
    }
  });

  // forward engine/worker events (via Redis pub/sub) to the right rooms
  subscribeEvents(({ room, event, payload }) => {
    io.to(room).emit(event, payload);
  });

  return io;
}
