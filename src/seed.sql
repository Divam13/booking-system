-- Seed data for Railway Booking System
-- 2 trains, 6 stations each, 3 coaches x 40 seats, 7 travel dates

-- Train 1: Rajdhani Express
INSERT INTO trains (train_number, train_name, total_coaches, seats_per_coach)
VALUES ('12301', 'Rajdhani Express', 3, 40)
ON CONFLICT (train_number) DO NOTHING;

-- Train 2: Shatabdi Express
INSERT INTO trains (train_number, train_name, total_coaches, seats_per_coach)
VALUES ('12002', 'Shatabdi Express', 3, 40)
ON CONFLICT (train_number) DO NOTHING;

-- Stations for Train 1 (Rajdhani Express): 6 stations, 5 segments
INSERT INTO train_stations (train_id, station_name, station_index)
VALUES
  ((SELECT id FROM trains WHERE train_number = '12301'), 'New Delhi', 0),
  ((SELECT id FROM trains WHERE train_number = '12301'), 'Kanpur', 1),
  ((SELECT id FROM trains WHERE train_number = '12301'), 'Allahabad', 2),
  ((SELECT id FROM trains WHERE train_number = '12301'), 'Mughal Sarai', 3),
  ((SELECT id FROM trains WHERE train_number = '12301'), 'Patna', 4),
  ((SELECT id FROM trains WHERE train_number = '12301'), 'Kolkata', 5)
ON CONFLICT DO NOTHING;

-- Stations for Train 2 (Shatabdi Express): 6 stations, 5 segments
INSERT INTO train_stations (train_id, station_name, station_index)
VALUES
  ((SELECT id FROM trains WHERE train_number = '12002'), 'Mumbai Central', 0),
  ((SELECT id FROM trains WHERE train_number = '12002'), 'Surat', 1),
  ((SELECT id FROM trains WHERE train_number = '12002'), 'Vadodara', 2),
  ((SELECT id FROM trains WHERE train_number = '12002'), 'Ahmedabad', 3),
  ((SELECT id FROM trains WHERE train_number = '12002'), 'Ajmer', 4),
  ((SELECT id FROM trains WHERE train_number = '12002'), 'Jaipur', 5)
ON CONFLICT DO NOTHING;

-- Generate seats for both trains: 3 coaches (A, B, C) x 40 seats each
DO $$
DECLARE
  t_id INTEGER;
  coach CHAR(1);
  seat_num INTEGER;
BEGIN
  FOR t_id IN SELECT id FROM trains LOOP
    FOREACH coach IN ARRAY ARRAY['A', 'B', 'C'] LOOP
      FOR seat_num IN 1..40 LOOP
        INSERT INTO seats (train_id, coach, seat_number)
        VALUES (t_id, coach, seat_num)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- Generate 7 travel dates starting from tomorrow
DO $$
DECLARE
  t_id INTEGER;
  d DATE;
  day_offset INTEGER;
BEGIN
  FOR t_id IN SELECT id FROM trains LOOP
    FOR day_offset IN 1..7 LOOP
      d := CURRENT_DATE + day_offset;
      INSERT INTO travel_dates (train_id, travel_date)
      VALUES (t_id, d)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

-- Initialize seat_availability for all seats x dates with empty bitmask
DO $$
DECLARE
  s_id INTEGER;
  d DATE;
BEGIN
  FOR s_id IN SELECT id FROM seats LOOP
    FOR d IN SELECT travel_date FROM travel_dates WHERE train_id = (SELECT train_id FROM seats WHERE id = s_id) LOOP
      INSERT INTO seat_availability (seat_id, travel_date, occupied_mask)
      VALUES (s_id, d, 0)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;
