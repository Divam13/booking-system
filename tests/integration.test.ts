import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const API = 'http://localhost:3000';

// Helper to make authenticated requests
let token = '';
let userId = 0;
const testEmail = `test-${Date.now()}@railway.com`;
const testPassword = 'testpass123';

async function api(method: string, path: string, body?: any, authToken?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken || token) {
    headers['Authorization'] = `Bearer ${authToken || token}`;
  }

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  return { status: res.status, data };
}

let serverOnline = false;
try {
  const res = await fetch(`${API}/health`);
  serverOnline = res.ok;
} catch {
  serverOnline = false;
}

describe.skipIf(!serverOnline)('Integration Tests', () => {
  // These tests run against a running server with seeded database

  describe('Auth', () => {
    it('should register a new user', async () => {
      const { status, data } = await api('POST', '/auth/register', {
        email: testEmail,
        password: testPassword,
        name: 'Test User',
      });

      expect(status).toBe(201);
      expect(data.token).toBeDefined();
      expect(data.user.email).toBe(testEmail);
      token = data.token;
      userId = data.user.id;
    });

    it('should reject duplicate registration', async () => {
      const { status } = await api('POST', '/auth/register', {
        email: testEmail,
        password: testPassword,
        name: 'Test User',
      });
      expect(status).toBe(409);
    });

    it('should login with valid credentials', async () => {
      const { status, data } = await api('POST', '/auth/login', {
        email: testEmail,
        password: testPassword,
      });

      expect(status).toBe(200);
      expect(data.token).toBeDefined();
      token = data.token;
    });

    it('should reject invalid credentials', async () => {
      const { status } = await api('POST', '/auth/login', {
        email: testEmail,
        password: 'wrongpassword',
      });
      expect(status).toBe(401);
    });
  });

  describe('Train Search', () => {
    it('should find trains for valid route and date', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const date = tomorrow.toISOString().split('T')[0];

      const { status, data } = await api('GET', `/trains?from=New Delhi&to=Kolkata&date=${date}`);

      expect(status).toBe(200);
      expect(data.trains.length).toBeGreaterThan(0);
      expect(data.trains[0].availableSeats).toBeGreaterThan(0);
    });

    it('should return empty for non-existent route', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const date = tomorrow.toISOString().split('T')[0];

      const { status, data } = await api('GET', `/trains?from=New Delhi&to=Jaipur&date=${date}`);

      expect(status).toBe(200);
      expect(data.trains.length).toBe(0);
    });
  });

  describe('Hold, Confirm, Cancel Flow', () => {
    let trainId: number;
    let seatId: number;
    let holdId: string;
    let bookingId: number;
    const date = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return d.toISOString().split('T')[0];
    })();

    it('should load seat map', async () => {
      const { status, data } = await api(
        'GET',
        `/trains?from=New Delhi&to=Kolkata&date=${date}`
      );
      expect(status).toBe(200);
      trainId = data.trains[0].id;

      const { data: seatData } = await api(
        'GET',
        `/trains/${trainId}/seats?date=${date}&from=New Delhi&to=Kolkata`
      );

      expect(seatData.coaches).toBeDefined();
      const coachA = seatData.coaches['A'];
      expect(coachA.length).toBeGreaterThan(0);

      // Pick a free seat
      const freeSeat = coachA.find((s: any) => s.status === 'free');
      expect(freeSeat).toBeDefined();
      seatId = freeSeat.seatId;
    });

    it('should hold a seat', async () => {
      const { status, data } = await api('POST', '/holds', {
        trainId,
        seatId,
        date,
        from: 'New Delhi',
        to: 'Kolkata',
      });

      expect(status).toBe(201);
      expect(data.holdId).toBeDefined();
      expect(data.expiresIn).toBe(300);
      holdId = data.holdId;
    });

    it('should show seat as held in seat map', async () => {
      const { data } = await api(
        'GET',
        `/trains/${trainId}/seats?date=${date}&from=New Delhi&to=Kolkata`
      );

      const coachA = data.coaches['A'];
      const seat = coachA.find((s: any) => s.seatId === seatId);
      expect(seat.status).toBe('held');
    });

    it('should reject overlapping hold on same seat', async () => {
      const { status } = await api('POST', '/holds', {
        trainId,
        seatId,
        date,
        from: 'Kanpur',
        to: 'Patna',
      });

      expect(status).toBe(409);
    });

    it('should confirm booking from hold', async () => {
      const { status, data } = await api('POST', '/bookings', {
        holdId,
        idempotencyKey: `test-${holdId}`,
      });

      // Payment has 95% success rate, allow retry
      if (status === 402) {
        const retry = await api('POST', '/bookings', {
          holdId,
          idempotencyKey: `test-${holdId}-retry`,
        });
        expect(retry.status).toBe(201);
        bookingId = retry.data.booking.id;
      } else {
        expect(status).toBe(201);
        expect(data.booking.paymentId).toBeDefined();
        bookingId = data.booking.id;
      }
    });

    it('should handle idempotent booking request', async () => {
      const { status, data } = await api('POST', '/bookings', {
        holdId: 'nonexistent-hold',
        idempotencyKey: `test-${holdId}`,
      });

      // Should return existing booking instead of creating a new one
      expect(status).toBe(200);
      expect(data.message).toContain('idempotent');
    });

    it('should show seat as booked in seat map', async () => {
      const { data } = await api(
        'GET',
        `/trains/${trainId}/seats?date=${date}&from=New Delhi&to=Kolkata`
      );

      const coachA = data.coaches['A'];
      const seat = coachA.find((s: any) => s.seatId === seatId);
      expect(seat.status).toBe('booked');
    });

    it('should show booking in my bookings', async () => {
      const { data } = await api('GET', '/bookings/me');
      expect(data.bookings.length).toBeGreaterThan(0);
      const booking = data.bookings.find((b: any) => b.id === bookingId);
      expect(booking).toBeDefined();
      expect(booking.status).toBe('confirmed');
    });

    it('should cancel booking and free the seat', async () => {
      const { status, data } = await api('POST', `/bookings/${bookingId}/cancel`);
      expect(status).toBe(200);
      expect(data.message).toContain('cancelled');

      // Verify seat is free again
      const { data: seatData } = await api(
        'GET',
        `/trains/${trainId}/seats?date=${date}&from=New Delhi&to=Kolkata`
      );
      const coachA = seatData.coaches['A'];
      const seat = coachA.find((s: any) => s.seatId === seatId);
      expect(seat.status).toBe('free');
    });
  });

  describe('Overlapping Segment Bookings', () => {
    let trainId: number;
    let seatId: number;
    const date = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      return d.toISOString().split('T')[0];
    })();

    beforeAll(async () => {
      const { data } = await api(
        'GET',
        `/trains?from=New Delhi&to=Kolkata&date=${date}`
      );
      trainId = data.trains[0].id;

      const { data: seatData } = await api(
        'GET',
        `/trains/${trainId}/seats?date=${date}&from=New Delhi&to=Kolkata`
      );
      const coachA = seatData.coaches['A'];
      seatId = coachA.find((s: any) => s.status === 'free').seatId;
    });

    it('should book A->C, then allow C->E on same seat', async () => {
      // Hold and book A->C (New Delhi -> Allahabad)
      const hold1 = await api('POST', '/holds', {
        trainId, seatId, date,
        from: 'New Delhi', to: 'Allahabad',
      });
      expect(hold1.status).toBe(201);

      const book1 = await api('POST', '/bookings', {
        holdId: hold1.data.holdId,
        idempotencyKey: `seg-test-1-${Date.now()}`,
      });
      // Allow payment retry
      if (book1.status === 402) {
        const retry = await api('POST', '/bookings', {
          holdId: hold1.data.holdId,
          idempotencyKey: `seg-test-1-retry-${Date.now()}`,
        });
        expect(retry.status).toBe(201);
      } else {
        expect(book1.status).toBe(201);
      }

      // Hold and book C->E (Allahabad -> Patna) — should succeed
      const hold2 = await api('POST', '/holds', {
        trainId, seatId, date,
        from: 'Allahabad', to: 'Patna',
      });
      expect(hold2.status).toBe(201);

      const book2 = await api('POST', '/bookings', {
        holdId: hold2.data.holdId,
        idempotencyKey: `seg-test-2-${Date.now()}`,
      });
      if (book2.status === 402) {
        const retry = await api('POST', '/bookings', {
          holdId: hold2.data.holdId,
          idempotencyKey: `seg-test-2-retry-${Date.now()}`,
        });
        expect(retry.status).toBe(201);
      } else {
        expect(book2.status).toBe(201);
      }
    });

    it('should reject B->D hold on same seat (overlaps with A->C)', async () => {
      // B->D (Kanpur -> Mughal Sarai) overlaps with A->C booking
      const hold = await api('POST', '/holds', {
        trainId, seatId, date,
        from: 'Kanpur', to: 'Mughal Sarai',
      });

      expect(hold.status).toBe(409);
    });
  });
});
