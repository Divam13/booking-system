import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { redis } from '../redis';
import { createJourneyMask } from '../bitmask';
import { publishSeatUpdate } from '../events';
import { config } from '../config';

// Lua script for atomic hold: checks no existing hold overlaps, then sets the hold with TTL
const HOLD_LUA_SCRIPT = `
  -- KEYS: pattern for scanning existing holds
  -- ARGV: holdKey, holdData, ttl, seatId, segmentMask
  local holdKey = ARGV[1]
  local holdData = ARGV[2]
  local ttl = tonumber(ARGV[3])
  local seatId = tonumber(ARGV[4])
  local segmentMask = tonumber(ARGV[5])
  local scanPattern = KEYS[1]

  -- Check for existing overlapping holds on this seat
  local cursor = "0"
  repeat
    local result = redis.call("SCAN", cursor, "MATCH", scanPattern, "COUNT", 100)
    cursor = result[1]
    local keys = result[2]
    for _, key in ipairs(keys) do
      local existing = redis.call("GET", key)
      if existing then
        local data = cjson.decode(existing)
        if data.seatId == seatId then
          local existingMask = data.segmentMask
          if bit.band(existingMask, segmentMask) ~= 0 then
            return cjson.encode({ok = false, error = "Seat already held for overlapping segments"})
          end
        end
      end
    end
  until cursor == "0"

  -- No overlap found, create the hold
  redis.call("SET", holdKey, holdData, "EX", ttl)
  return cjson.encode({ok = true})
`;

export async function holdRoutes(app: FastifyInstance) {
  // Create a hold on a seat
  app.post('/holds', {
    preHandler: [async (request) => await request.jwtVerify()],
  }, async (request, reply) => {
    const user = request.user as { id: number; email: string };
    const { trainId, seatId, date, from, to } = request.body as {
      trainId: number;
      seatId: number;
      date: string;
      from: string;
      to: string;
    };

    if (!trainId || !seatId || !date || !from || !to) {
      return reply.status(400).send({ error: 'trainId, seatId, date, from, and to are required' });
    }

    // Resolve station indices
    const stationsResult = await pool.query(
      `SELECT station_name, station_index FROM train_stations WHERE train_id = $1 ORDER BY station_index`,
      [trainId]
    );

    const fromStation = stationsResult.rows.find((s: any) => s.station_name === from);
    const toStation = stationsResult.rows.find((s: any) => s.station_name === to);

    if (!fromStation || !toStation || fromStation.station_index >= toStation.station_index) {
      return reply.status(400).send({ error: 'Invalid stations for this train' });
    }

    const segmentMask = createJourneyMask(fromStation.station_index, toStation.station_index);

    // Verify seat belongs to this train
    const seatResult = await pool.query(
      `SELECT s.id, s.coach, s.seat_number, COALESCE(sa.occupied_mask, 0) AS occupied_mask
       FROM seats s
       LEFT JOIN seat_availability sa ON sa.seat_id = s.id AND sa.travel_date = $2
       WHERE s.id = $1 AND s.train_id = $3`,
      [seatId, date, trainId]
    );

    if (seatResult.rowCount === 0) {
      return reply.status(404).send({ error: 'Seat not found for this train' });
    }

    const seat = seatResult.rows[0];

    // Check if seat is available in DB (not booked)
    if ((seat.occupied_mask & segmentMask) !== 0) {
      return reply.status(409).send({ error: 'Seat is already booked for overlapping segments' });
    }

    // Atomic hold in Redis using Lua script
    const holdId = uuidv4();
    const holdKey = `hold:${trainId}:${date}:${holdId}`;
    const scanPattern = `hold:${trainId}:${date}:*`;

    const holdData = JSON.stringify({
      holdId,
      userId: user.id,
      trainId,
      seatId,
      date,
      from,
      to,
      fromIndex: fromStation.station_index,
      toIndex: toStation.station_index,
      segmentMask,
      coach: seat.coach,
      seatNumber: seat.seat_number,
      createdAt: Date.now(),
    });

    const result = await redis.eval(
      HOLD_LUA_SCRIPT,
      1,
      scanPattern,
      holdKey,
      holdData,
      config.hold.ttlSeconds,
      seatId,
      segmentMask
    ) as string;

    const parsed = JSON.parse(result);

    if (!parsed.ok) {
      return reply.status(409).send({ error: parsed.error });
    }

    // Publish seat update event
    await publishSeatUpdate({
      trainId,
      date,
      seatId,
      coach: seat.coach,
      seatNumber: seat.seat_number,
      status: 'held',
      occupiedMask: seat.occupied_mask,
      timestamp: Date.now(),
    });

    return reply.status(201).send({
      holdId,
      seatId,
      coach: seat.coach,
      seatNumber: seat.seat_number,
      trainId,
      date,
      from,
      to,
      expiresIn: config.hold.ttlSeconds,
    });
  });

  // Release a hold
  app.delete('/holds/:id', {
    preHandler: [async (request) => await request.jwtVerify()],
  }, async (request, reply) => {
    const user = request.user as { id: number; email: string };
    const { id: holdId } = request.params as { id: string };

    // Find the hold in Redis
    const keys = await redis.keys(`hold:*:*:${holdId}`);
    if (keys.length === 0) {
      return reply.status(404).send({ error: 'Hold not found or expired' });
    }

    const holdData = await redis.get(keys[0]);
    if (!holdData) {
      return reply.status(404).send({ error: 'Hold not found or expired' });
    }

    const hold = JSON.parse(holdData);

    if (hold.userId !== user.id) {
      return reply.status(403).send({ error: 'You can only release your own holds' });
    }

    await redis.del(keys[0]);

    // Publish seat update event
    await publishSeatUpdate({
      trainId: hold.trainId,
      date: hold.date,
      seatId: hold.seatId,
      coach: hold.coach,
      seatNumber: hold.seatNumber,
      status: 'free',
      occupiedMask: 0, // We don't know the exact mask, client should refresh
      timestamp: Date.now(),
    });

    return reply.send({ message: 'Hold released', holdId });
  });
}

/**
 * Sweeper that periodically checks for expired holds.
 * Redis TTL handles the actual expiry; the sweeper publishes
 * seat update events so WebSocket clients know the seat is free again.
 *
 * Uses Redis keyspace notifications for expired keys.
 */
export async function startHoldSweeper(): Promise<void> {
  // Enable keyspace notifications for expired events
  await redis.config('SET', 'notify-keyspace-events', 'Ex');

  // Subscribe to expiry events on a dedicated connection
  const { redisSub: sweeperSub } = await import('../redis');

  // We need a new connection for this since our main sub is used for seat updates
  const Redis = (await import('ioredis')).default;
  const { config: appConfig } = await import('../config');
  const expirySub = new Redis(appConfig.redis.url);

  await expirySub.subscribe('__keyevent@0__:expired');

  expirySub.on('message', async (_channel: string, expiredKey: string) => {
    // Only process our hold keys
    if (!expiredKey.startsWith('hold:')) return;

    // Parse the key: hold:{trainId}:{date}:{holdId}
    const parts = expiredKey.split(':');
    if (parts.length !== 4) return;

    const trainId = parseInt(parts[1], 10);
    const date = parts[2];
    const holdId = parts[3];

    console.log(`Hold expired: ${holdId} (train ${trainId}, date ${date})`);

    // We can't retrieve the data since the key is gone,
    // but we can publish a generic refresh event
    await publishSeatUpdate({
      trainId,
      date,
      seatId: 0, // Unknown — client should refresh seat map
      coach: '',
      seatNumber: 0,
      status: 'free',
      occupiedMask: 0,
      timestamp: Date.now(),
    });
  });

  console.log('Hold sweeper started (listening for Redis key expirations)');
}
