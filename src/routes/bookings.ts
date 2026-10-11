import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { redis } from '../redis';
import { createJourneyMask } from '../bitmask';
import { publishSeatUpdate } from '../events';

/**
 * Simulate a payment. In production, this would call a payment gateway.
 * Returns a payment ID on success.
 */
function simulatePayment(): { success: boolean; paymentId: string } {
  // 95% success rate for realism
  const success = Math.random() < 0.95;
  return {
    success,
    paymentId: success ? `PAY-${uuidv4().slice(0, 8).toUpperCase()}` : '',
  };
}

export async function bookingRoutes(app: FastifyInstance) {
  // Confirm a booking (hold -> booking)
  app.post('/bookings', {
    preHandler: [async (request) => await request.jwtVerify()],
  }, async (request, reply) => {
    const user = request.user as { id: number; email: string };
    const { holdId, idempotencyKey } = request.body as {
      holdId: string;
      idempotencyKey?: string;
    };

    if (!holdId) {
      return reply.status(400).send({ error: 'holdId is required' });
    }

    const idemKey = idempotencyKey || uuidv4();

    // Check idempotency: if this key was already used, return existing booking
    const existingBooking = await pool.query(
      'SELECT * FROM bookings WHERE idempotency_key = $1',
      [idemKey]
    );

    if (existingBooking.rowCount! > 0) {
      return reply.send({
        message: 'Booking already exists (idempotent)',
        booking: existingBooking.rows[0],
      });
    }

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
      return reply.status(403).send({ error: 'You can only confirm your own holds' });
    }

    // Simulate payment
    const payment = simulatePayment();
    if (!payment.success) {
      return reply.status(402).send({ error: 'Payment failed. Please try again.' });
    }

    // Begin a database transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // SELECT ... FOR UPDATE to lock the seat availability row
      const availResult = await client.query(
        `SELECT id, occupied_mask FROM seat_availability
         WHERE seat_id = $1 AND travel_date = $2
         FOR UPDATE`,
        [hold.seatId, hold.date]
      );

      if (availResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return reply.status(409).send({ error: 'Seat availability not found' });
      }

      const currentMask = availResult.rows[0].occupied_mask;
      const segmentMask = hold.segmentMask;

      // Double-check: seat must still be available
      if ((currentMask & segmentMask) !== 0) {
        await client.query('ROLLBACK');
        // Remove the hold since the seat is no longer available
        await redis.del(keys[0]);
        return reply.status(409).send({ error: 'Seat is no longer available for these segments' });
      }

      // Update the occupied mask
      const newMask = currentMask | segmentMask;
      await client.query(
        'UPDATE seat_availability SET occupied_mask = $1 WHERE seat_id = $2 AND travel_date = $3',
        [newMask, hold.seatId, hold.date]
      );

      // Insert the booking
      const bookingResult = await client.query(
        `INSERT INTO bookings (user_id, train_id, seat_id, travel_date, from_station, to_station,
                               from_index, to_index, segment_mask, status, idempotency_key, payment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', $10, $11)
         RETURNING *`,
        [
          user.id, hold.trainId, hold.seatId, hold.date,
          hold.from, hold.to, hold.fromIndex, hold.toIndex,
          segmentMask, idemKey, payment.paymentId,
        ]
      );

      await client.query('COMMIT');

      // Remove the hold from Redis
      await redis.del(keys[0]);

      const booking = bookingResult.rows[0];

      // Publish seat update event
      await publishSeatUpdate({
        trainId: hold.trainId,
        date: hold.date,
        seatId: hold.seatId,
        coach: hold.coach,
        seatNumber: hold.seatNumber,
        status: 'booked',
        occupiedMask: newMask,
        timestamp: Date.now(),
      });

      return reply.status(201).send({
        message: 'Booking confirmed',
        booking: {
          id: booking.id,
          trainId: booking.train_id,
          seatId: booking.seat_id,
          coach: hold.coach,
          seatNumber: hold.seatNumber,
          date: booking.travel_date,
          from: booking.from_station,
          to: booking.to_station,
          status: booking.status,
          paymentId: booking.payment_id,
          idempotencyKey: booking.idempotency_key,
          createdAt: booking.created_at,
        },
      });
    } catch (err: any) {
      await client.query('ROLLBACK');

      // Check for exclusion constraint violation (overlapping segments)
      if (err.code === '23P01') {
        return reply.status(409).send({
          error: 'Booking conflicts with an existing reservation on overlapping segments',
        });
      }

      throw err;
    } finally {
      client.release();
    }
  });

  // Cancel a booking
  app.post('/bookings/:id/cancel', {
    preHandler: [async (request) => await request.jwtVerify()],
  }, async (request, reply) => {
    const user = request.user as { id: number; email: string };
    const { id } = request.params as { id: string };
    const bookingId = parseInt(id, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock and fetch the booking
      const bookingResult = await client.query(
        'SELECT * FROM bookings WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [bookingId, user.id]
      );

      if (bookingResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return reply.status(404).send({ error: 'Booking not found' });
      }

      const booking = bookingResult.rows[0];

      if (booking.status !== 'confirmed') {
        await client.query('ROLLBACK');
        return reply.status(400).send({ error: 'Booking is already cancelled' });
      }

      // Update booking status
      await client.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`,
        [bookingId]
      );

      // Release the segments from seat_availability
      await client.query(
        `UPDATE seat_availability
         SET occupied_mask = occupied_mask & ~$1
         WHERE seat_id = $2 AND travel_date = $3`,
        [booking.segment_mask, booking.seat_id, booking.travel_date]
      );

      // Get updated mask
      const updatedAvail = await client.query(
        'SELECT occupied_mask FROM seat_availability WHERE seat_id = $1 AND travel_date = $2',
        [booking.seat_id, booking.travel_date]
      );

      await client.query('COMMIT');

      // Get seat details for the event
      const seatResult = await pool.query(
        'SELECT coach, seat_number FROM seats WHERE id = $1',
        [booking.seat_id]
      );
      const seat = seatResult.rows[0];

      // Publish seat update event
      await publishSeatUpdate({
        trainId: booking.train_id,
        date: booking.travel_date.toISOString().split('T')[0],
        seatId: booking.seat_id,
        coach: seat.coach,
        seatNumber: seat.seat_number,
        status: 'free',
        occupiedMask: updatedAvail.rows[0]?.occupied_mask || 0,
        timestamp: Date.now(),
      });

      return reply.send({
        message: 'Booking cancelled',
        bookingId,
        refundNote: 'Simulated refund processed',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // Get user's bookings
  app.get('/bookings/me', {
    preHandler: [async (request) => await request.jwtVerify()],
  }, async (request, reply) => {
    const user = request.user as { id: number; email: string };

    const result = await pool.query(
      `SELECT b.*, s.coach, s.seat_number, t.train_number, t.train_name
       FROM bookings b
       JOIN seats s ON s.id = b.seat_id
       JOIN trains t ON t.id = b.train_id
       WHERE b.user_id = $1
       ORDER BY b.created_at DESC`,
      [user.id]
    );

    const bookings = result.rows.map((b: any) => ({
      id: b.id,
      trainId: b.train_id,
      trainNumber: b.train_number,
      trainName: b.train_name,
      seatId: b.seat_id,
      coach: b.coach,
      seatNumber: b.seat_number,
      date: b.travel_date,
      from: b.from_station,
      to: b.to_station,
      status: b.status,
      paymentId: b.payment_id,
      createdAt: b.created_at,
      cancelledAt: b.cancelled_at,
    }));

    return reply.send({ bookings });
  });
}
