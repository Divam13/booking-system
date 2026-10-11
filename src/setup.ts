import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { config } from './config';

async function setup() {
  // First connect to 'postgres' database to create our database if it doesn't exist
  const adminPool = new Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: 'postgres',
  });

  try {
    const result = await adminPool.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [config.db.database]
    );

    if (result.rowCount === 0) {
      console.log(`Creating database '${config.db.database}'...`);
      await adminPool.query(`CREATE DATABASE "${config.db.database}"`);
      console.log('Database created.');
    } else {
      console.log(`Database '${config.db.database}' already exists.`);
    }
  } finally {
    await adminPool.end();
  }

  // Now connect to our database and run schema + seed
  const appPool = new Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
  });

  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const seedPath = path.join(__dirname, 'seed.sql');

    console.log('Running schema...');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    await appPool.query(schemaSql);
    console.log('Schema applied.');

    console.log('Running seed...');
    const seedSql = fs.readFileSync(seedPath, 'utf-8');
    await appPool.query(seedSql);
    console.log('Seed data inserted.');

    // Verify
    const trains = await appPool.query('SELECT COUNT(*) FROM trains');
    const seats = await appPool.query('SELECT COUNT(*) FROM seats');
    const dates = await appPool.query('SELECT COUNT(*) FROM travel_dates');
    const avail = await appPool.query('SELECT COUNT(*) FROM seat_availability');

    console.log(`\nDatabase summary:`);
    console.log(`  Trains:       ${trains.rows[0].count}`);
    console.log(`  Seats:        ${seats.rows[0].count}`);
    console.log(`  Travel dates: ${dates.rows[0].count}`);
    console.log(`  Availability: ${avail.rows[0].count}`);
    console.log('\nSetup complete!');
  } finally {
    await appPool.end();
  }
}

setup().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
