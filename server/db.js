const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL || '';
const isRailwayInternal = dbUrl.includes('railway.internal');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isRailwayInternal ? false : { rejectUnauthorized: false },
});

// Verify connection on startup — non-fatal so the healthcheck
// endpoint can still respond even if DB is momentarily unavailable.
pool.connect((err, client, release) => {
  if (err) {
    console.warn('[DB] Warning: could not connect on startup:', err.message);
    console.warn('[DB] Make sure DATABASE_URL is set and the Postgres service is linked in Railway.');
    return;
  }
  release();
  console.log('[DB] Connected to PostgreSQL ✓');
});

module.exports = pool;

