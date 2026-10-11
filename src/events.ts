import { redis, redisSub } from './redis';

const CHANNEL = 'seat_updates';
const STREAM_KEY = 'seat_updates_stream';
const STREAM_MAX_LEN = 10000;

export interface SeatUpdateEvent {
  trainId: number;
  date: string;
  seatId: number;
  coach: string;
  seatNumber: number;
  status: 'free' | 'held' | 'booked';
  occupiedMask: number;
  timestamp: number;
}

type Listener = (event: SeatUpdateEvent) => void;
const listeners: Listener[] = [];

let subscribed = false;

/**
 * Publish a seat update event to Redis Pub/Sub + Stream.
 * All app instances receive the event through Pub/Sub.
 * The stream provides replay for clients that reconnect.
 */
export async function publishSeatUpdate(event: SeatUpdateEvent): Promise<string> {
  const payload = JSON.stringify(event);

  // Publish to Pub/Sub for live delivery
  await redis.publish(CHANNEL, payload);

  // Add to Redis Stream for replay on reconnect
  const streamId = await redis.xadd(
    STREAM_KEY,
    'MAXLEN', '~', String(STREAM_MAX_LEN),
    '*',
    'data', payload
  );

  return streamId!;
}

/**
 * Subscribe to seat update events from Redis Pub/Sub.
 * Called once on app startup.
 */
export async function subscribeSeatUpdates(): Promise<void> {
  if (subscribed) return;
  subscribed = true;

  await redisSub.subscribe(CHANNEL);

  redisSub.on('message', (channel, message) => {
    if (channel !== CHANNEL) return;
    try {
      const event: SeatUpdateEvent = JSON.parse(message);
      for (const listener of listeners) {
        listener(event);
      }
    } catch (err) {
      console.error('Failed to parse seat update event:', err);
    }
  });
}

/**
 * Register a listener for seat update events.
 */
export function onSeatUpdate(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

/**
 * Read events from the Redis Stream starting from a given ID.
 * Used for reconnect/resume to catch up on missed events.
 */
export async function readStreamFrom(
  lastId: string,
  count: number = 100
): Promise<Array<{ id: string; event: SeatUpdateEvent }>> {
  const results = await redis.xrange(STREAM_KEY, lastId, '+', 'COUNT', count);

  if (!results || results.length === 0) return [];

  return results
    .filter(([id]) => id !== lastId) // exclude the lastId itself
    .map(([id, fields]) => {
      const dataIndex = fields.indexOf('data');
      const data = dataIndex !== -1 ? fields[dataIndex + 1] : '{}';
      return {
        id,
        event: JSON.parse(data) as SeatUpdateEvent,
      };
    });
}
