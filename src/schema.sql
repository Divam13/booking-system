-- Railway Booking System Schema
-- Segment-based seat booking with bitmask occupancy tracking

-- Enable the btree_gist extension for exclusion constraints
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Trains table
CREATE TABLE IF NOT EXISTS trains (
  id            SERIAL PRIMARY KEY,
  train_number  VARCHAR(20) UNIQUE NOT NULL,
  train_name    VARCHAR(255) NOT NULL,
  total_coaches INTEGER NOT NULL DEFAULT 3,
  seats_per_coach INTEGER NOT NULL DEFAULT 40,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Train stations (ordered stops for each train)
CREATE TABLE IF NOT EXISTS train_stations (
  id            SERIAL PRIMARY KEY,
  train_id      INTEGER NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
  station_name  VARCHAR(255) NOT NULL,
  station_index INTEGER NOT NULL,  -- 0-based order in the route
  UNIQUE(train_id, station_index),
  UNIQUE(train_id, station_name)
);

CREATE INDEX IF NOT EXISTS idx_train_stations_train ON train_stations(train_id);

-- Seats table (one row per physical seat)
CREATE TABLE IF NOT EXISTS seats (
  id            SERIAL PRIMARY KEY,
  train_id      INTEGER NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
  coach         VARCHAR(10) NOT NULL,   -- e.g., 'A', 'B', 'C'
  seat_number   INTEGER NOT NULL,       -- 1..40
  UNIQUE(train_id, coach, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_seats_train ON seats(train_id);

-- Seat availability per date: tracks which segments are occupied via bitmask
CREATE TABLE IF NOT EXISTS seat_availability (
  id              SERIAL PRIMARY KEY,
  seat_id         INTEGER NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  travel_date     DATE NOT NULL,
  occupied_mask   INTEGER NOT NULL DEFAULT 0,  -- bitmask of occupied segments
  UNIQUE(seat_id, travel_date)
);

CREATE INDEX IF NOT EXISTS idx_seat_avail_date ON seat_availability(seat_id, travel_date);

-- Bookings table
CREATE TABLE IF NOT EXISTS bookings (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  train_id        INTEGER NOT NULL REFERENCES trains(id),
  seat_id         INTEGER NOT NULL REFERENCES seats(id),
  travel_date     DATE NOT NULL,
  from_station    VARCHAR(255) NOT NULL,
  to_station      VARCHAR(255) NOT NULL,
  from_index      INTEGER NOT NULL,
  to_index        INTEGER NOT NULL,
  segment_mask    INTEGER NOT NULL,         -- bitmask of segments booked
  status          VARCHAR(20) NOT NULL DEFAULT 'confirmed',  -- confirmed, cancelled
  idempotency_key VARCHAR(255) UNIQUE,      -- prevents duplicate bookings
  payment_id      VARCHAR(255),             -- simulated payment reference
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  cancelled_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_seat_date ON bookings(seat_id, travel_date);

-- Exclusion constraint: no two active bookings can overlap segments on the same seat+date
-- Uses GiST index with int4range for segment overlap detection
-- We use a CHECK + exclusion approach: only 'confirmed' bookings enforce exclusion
ALTER TABLE bookings
  ADD CONSTRAINT no_overlapping_segments
  EXCLUDE USING gist (
    seat_id WITH =,
    travel_date WITH =,
    int4range(from_index, to_index) WITH &&
  )
  WHERE (status = 'confirmed');

-- Travel dates table (available dates for booking)
CREATE TABLE IF NOT EXISTS travel_dates (
  id          SERIAL PRIMARY KEY,
  train_id    INTEGER NOT NULL REFERENCES trains(id) ON DELETE CASCADE,
  travel_date DATE NOT NULL,
  UNIQUE(train_id, travel_date)
);
