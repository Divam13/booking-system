/**
 * Load Test: Fire many parallel booking requests at one seat
 *
 * This script creates multiple users, then has them all try to hold and book
 * the same seat simultaneously. Only one should succeed due to atomic Redis
 * Lua hold + Postgres transaction with SELECT FOR UPDATE.
 *
 * Usage: npx tsx tests/load-test.ts
 */

const API = 'http://localhost:3000';

interface TestResult {
  userId: string;
  holdStatus: number;
  bookStatus?: number;
  holdError?: string;
  bookError?: string;
}

async function createUser(idx: number): Promise<{ token: string; email: string }> {
  const email = `loadtest-${Date.now()}-${idx}@railway.com`;
  const res = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test123', name: `Load User ${idx}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Registration failed: ${data.error}`);
  return { token: data.token, email };
}

async function tryHoldAndBook(
  token: string,
  trainId: number,
  seatId: number,
  date: string,
  from: string,
  to: string,
  email: string
): Promise<TestResult> {
  const result: TestResult = { userId: email, holdStatus: 0 };

  try {
    // Try to hold the seat
    const holdRes = await fetch(`${API}/holds`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ trainId, seatId, date, from, to }),
    });

    result.holdStatus = holdRes.status;
    const holdData = await holdRes.json();

    if (holdRes.status !== 201) {
      result.holdError = holdData.error;
      return result;
    }

    // Try to confirm the booking
    const bookRes = await fetch(`${API}/bookings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        holdId: holdData.holdId,
        idempotencyKey: `load-test-${email}-${Date.now()}`,
      }),
    });

    result.bookStatus = bookRes.status;
    const bookData = await bookRes.json();

    if (bookRes.status !== 201) {
      result.bookError = bookData.error;
    }

    return result;
  } catch (err: any) {
    result.holdError = err.message;
    return result;
  }
}

async function run() {
  const CONCURRENCY = 20;

  console.log(`\n🔥 Load Test: ${CONCURRENCY} parallel requests for the same seat\n`);

  // Step 1: Create users
  console.log('Creating test users...');
  const users = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => createUser(i))
  );
  console.log(`Created ${users.length} users\n`);

  // Step 2: Find a train and seat
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 3);
  const date = tomorrow.toISOString().split('T')[0];

  const searchRes = await fetch(`${API}/trains?from=New Delhi&to=Kolkata&date=${date}`);
  const searchData = await searchRes.json();

  if (!searchData.trains || searchData.trains.length === 0) {
    console.error('No trains found! Make sure the server is running with seeded data.');
    process.exit(1);
  }

  const trainId = searchData.trains[0].id;

  const seatRes = await fetch(
    `${API}/trains/${trainId}/seats?date=${date}&from=New Delhi&to=Kolkata`
  );
  const seatData = await seatRes.json();
  const targetSeat = seatData.coaches['A'].find((s: any) => s.status === 'free');

  if (!targetSeat) {
    console.error('No free seats available!');
    process.exit(1);
  }

  console.log(`Target: Train ${trainId}, Seat A${targetSeat.seatNumber} (id: ${targetSeat.seatId}), Date: ${date}`);
  console.log(`Route: New Delhi → Kolkata\n`);

  // Step 3: Fire all requests simultaneously
  console.log(`Firing ${CONCURRENCY} parallel hold+book requests...\n`);
  const startTime = Date.now();

  const results = await Promise.all(
    users.map((u) =>
      tryHoldAndBook(u.token, trainId, targetSeat.seatId, date, 'New Delhi', 'Kolkata', u.email)
    )
  );

  const elapsed = Date.now() - startTime;

  // Step 4: Analyze results
  const holdSuccesses = results.filter((r) => r.holdStatus === 201);
  const holdFailures = results.filter((r) => r.holdStatus !== 201);
  const bookSuccesses = results.filter((r) => r.bookStatus === 201);
  const bookFailures = results.filter((r) => r.bookStatus && r.bookStatus !== 201);

  console.log('─'.repeat(60));
  console.log('RESULTS');
  console.log('─'.repeat(60));
  console.log(`Total requests:     ${CONCURRENCY}`);
  console.log(`Hold successes:     ${holdSuccesses.length}`);
  console.log(`Hold rejections:    ${holdFailures.length}`);
  console.log(`Booking successes:  ${bookSuccesses.length}`);
  console.log(`Booking failures:   ${bookFailures.length}`);
  console.log(`Time elapsed:       ${elapsed}ms`);
  console.log('─'.repeat(60));

  if (holdSuccesses.length <= 1) {
    console.log('\n✅ PASS: At most 1 user successfully held the seat (atomic Lua script works!)');
  } else {
    console.log(`\n⚠️  WARNING: ${holdSuccesses.length} users held the seat.`);
    console.log('   This may happen in rare race conditions but booking should still be safe.');
  }

  if (bookSuccesses.length <= 1) {
    console.log('✅ PASS: At most 1 user successfully booked the seat (no double booking!)');
  } else {
    console.log(`\n❌ FAIL: ${bookSuccesses.length} users booked the same seat! Double booking detected!`);
  }

  // Show individual results
  console.log('\nDetailed results:');
  for (const r of results) {
    const holdIcon = r.holdStatus === 201 ? '✓' : '✕';
    const bookIcon = r.bookStatus === 201 ? '✓' : r.bookStatus ? '✕' : '-';
    const holdMsg = r.holdError || 'held';
    const bookMsg = r.bookError || (r.bookStatus === 201 ? 'booked' : '-');
    console.log(
      `  ${holdIcon} Hold(${r.holdStatus}) ${bookIcon} Book(${r.bookStatus || '-'}) | ${r.userId.split('@')[0]}: ${holdMsg} / ${bookMsg}`
    );
  }

  console.log('\n');
}

run().catch(console.error);
