import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { onSeatUpdate, readStreamFrom, SeatUpdateEvent } from './events';

interface ClientState {
  ws: WebSocket;
  subscriptions: Set<string>; // "trainId:date" keys
  lastStreamId: string;
  alive: boolean;
}

const clients = new Map<WebSocket, ClientState>();

export function setupWebSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Heartbeat: ping every 30 seconds, terminate if no pong
  const heartbeatInterval = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, 30_000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws: WebSocket) => {
    const state: ClientState = {
      ws,
      subscriptions: new Set(),
      lastStreamId: '0',
      alive: true,
    };
    clients.set(ws, state);

    ws.on('pong', () => {
      state.alive = true;
    });

    ws.on('message', async (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleClientMessage(state, msg);
      } catch (err) {
        sendToClient(ws, { type: 'error', message: 'Invalid message format' });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });

    ws.on('error', () => {
      clients.delete(ws);
    });

    // Send welcome message
    sendToClient(ws, {
      type: 'connected',
      message: 'Connected to seat updates WebSocket',
    });
  });

  // Listen for seat update events from the event bus
  onSeatUpdate((event: SeatUpdateEvent) => {
    const key = `${event.trainId}:${event.date}`;

    for (const [, state] of clients) {
      if (state.subscriptions.has(key)) {
        sendToClient(state.ws, {
          type: 'seat_update',
          data: event,
        });
      }
    }
  });

  console.log('WebSocket server started on /ws');
}

async function handleClientMessage(state: ClientState, msg: any): Promise<void> {
  switch (msg.type) {
    case 'subscribe': {
      // Subscribe to seat updates for a train+date
      const { trainId, date } = msg;
      if (!trainId || !date) {
        sendToClient(state.ws, {
          type: 'error',
          message: 'subscribe requires trainId and date',
        });
        return;
      }

      const key = `${trainId}:${date}`;
      state.subscriptions.add(key);

      sendToClient(state.ws, {
        type: 'subscribed',
        trainId,
        date,
      });
      break;
    }

    case 'unsubscribe': {
      const { trainId, date } = msg;
      const key = `${trainId}:${date}`;
      state.subscriptions.delete(key);

      sendToClient(state.ws, {
        type: 'unsubscribed',
        trainId,
        date,
      });
      break;
    }

    case 'resume': {
      // Resume from a last-known stream ID to catch up on missed events
      const { lastStreamId } = msg;
      if (!lastStreamId) {
        sendToClient(state.ws, {
          type: 'error',
          message: 'resume requires lastStreamId',
        });
        return;
      }

      state.lastStreamId = lastStreamId;

      try {
        const events = await readStreamFrom(lastStreamId);
        for (const { id, event } of events) {
          const key = `${event.trainId}:${event.date}`;
          if (state.subscriptions.has(key)) {
            sendToClient(state.ws, {
              type: 'seat_update',
              streamId: id,
              data: event,
            });
          }
          state.lastStreamId = id;
        }

        sendToClient(state.ws, {
          type: 'resume_complete',
          lastStreamId: state.lastStreamId,
          eventCount: events.length,
        });
      } catch (err) {
        sendToClient(state.ws, {
          type: 'error',
          message: 'Failed to resume from stream',
        });
      }
      break;
    }

    default:
      sendToClient(state.ws, {
        type: 'error',
        message: `Unknown message type: ${msg.type}`,
      });
  }
}

function sendToClient(ws: WebSocket, data: any): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
