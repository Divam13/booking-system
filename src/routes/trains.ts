import { FastifyInstance } from 'fastify';
import { pool } from '../db';
import { createJourneyMask } from '../bitmask';

export async function trainRoutes(app: FastifyInstance) {
  // Search trains by from, to, date (with available seat count)
  app.get('/trains', async (request, reply) => {
    const { from, to, date } = request.query as {
      from?: string;
      to?: string;
      date?: string;
    };

    if (!from || !to || !date) {
      return reply.status(400).send({ error: 'from, to, and date query parameters are required' });
    }

    // Find trains that have both stations in the correct order
    const trainsResult = await pool.query(
      `SELECT t.id, t.train_number, t.train_name, t.total_coaches, t.seats_per_coach,
              ts_from.station_index AS from_index, ts_from.station_name AS from_station,
              ts_to.station_index AS to_index, ts_to.station_name AS to_station
       FROM trains t
       JOIN train_stations ts_from ON ts_from.train_id = t.id AND ts_from.station_name = $1
       JOIN train_stations ts_to ON ts_to.train_id = t.id AND ts_to.station_name = $2
       JOIN travel_dates td ON td.train_id = t.id AND td.travel_date = $3
       WHERE ts_from.station_index < ts_to.station_index`,
      [from, to, date]
    );

    if (trainsResult.rowCount === 0) {
      return reply.send({ trains: [] });
    }

    // For each train, count available seats
    const trains = [];
    for (const train of trainsResult.rows) {
      const journeyMask = createJourneyMask(train.from_index, train.to_index);

      const availResult = await pool.query(
        `SELECT COUNT(*) AS available_seats
         FROM seat_availability sa
         JOIN seats s ON s.id = sa.seat_id
         WHERE s.train_id = $1
           AND sa.travel_date = $2
           AND (sa.occupied_mask & $3) = 0`,
        [train.id, date, journeyMask]
      );

      trains.push({
        id: train.id,
        trainNumber: train.train_number,
        trainName: train.train_name,
        from: train.from_station,
        to: train.to_station,
        fromIndex: train.from_index,
        toIndex: train.to_index,
        date,
        totalSeats: train.total_coaches * train.seats_per_coach,
        availableSeats: parseInt(availResult.rows[0].available_seats, 10),
      });
    }

    return reply.send({ trains });
  });

  // Get seat map for a specific train
  app.get('/trains/:id/seats', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { date, from, to } = request.query as {
      date?: string;
      from?: string;
      to?: string;
    };

    if (!date || !from || !to) {
      return reply.status(400).send({ error: 'date, from, and to query parameters are required' });
    }

    const trainId = parseInt(id, 10);

    // Verify the train and stations exist
    const stationsResult = await pool.query(
      `SELECT station_name, station_index FROM train_stations WHERE train_id = $1 ORDER BY station_index`,
      [trainId]
    );

    if (stationsResult.rowCount === 0) {
      return reply.status(404).send({ error: 'Train not found' });
    }

    const stations = stationsResult.rows;
    const fromStation = stations.find((s: any) => s.station_name === from);
    const toStation = stations.find((s: any) => s.station_name === to);

    if (!fromStation || !toStation) {
      return reply.status(400).send({ error: 'Invalid station names for this train' });
    }

    if (fromStation.station_index >= toStation.station_index) {
      return reply.status(400).send({ error: 'From station must come before to station' });
    }

    const journeyMask = createJourneyMask(fromStation.station_index, toStation.station_index);

    // Get all seats with their availability
    const seatsResult = await pool.query(
      `SELECT s.id AS seat_id, s.coach, s.seat_number,
              COALESCE(sa.occupied_mask, 0) AS occupied_mask
       FROM seats s
       LEFT JOIN seat_availability sa ON sa.seat_id = s.id AND sa.travel_date = $2
       WHERE s.train_id = $1
       ORDER BY s.coach, s.seat_number`,
      [trainId, date]
    );

    // Check Redis for held seats
    const { redis } = await import('../redis');
    const holdKeys = await redis.keys(`hold:${trainId}:${date}:*`);
    const heldSeats = new Map<number, string>();

    for (const key of holdKeys) {
      const holdData = await redis.get(key);
      if (holdData) {
        const hold = JSON.parse(holdData);
        // Check if this hold overlaps with the requested journey
        if ((hold.segmentMask & journeyMask) !== 0) {
          heldSeats.set(hold.seatId, hold.holdId);
        }
      }
    }

    const coaches: Record<string, any[]> = {};

    for (const seat of seatsResult.rows) {
      const isAvailable = (seat.occupied_mask & journeyMask) === 0;
      const isHeld = heldSeats.has(seat.seat_id);

      let status: 'free' | 'held' | 'booked';
      if (!isAvailable) {
        status = 'booked';
      } else if (isHeld) {
        status = 'held';
      } else {
        status = 'free';
      }

      if (!coaches[seat.coach]) {
        coaches[seat.coach] = [];
      }

      coaches[seat.coach].push({
        seatId: seat.seat_id,
        seatNumber: seat.seat_number,
        status,
      });
    }

    return reply.send({
      trainId,
      date,
      from,
      to,
      journeyMask,
      stations: stations.map((s: any) => ({
        name: s.station_name,
        index: s.station_index,
      })),
      coaches,
    });
  });
}
