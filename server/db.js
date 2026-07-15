const { Pool } = require('pg');

// On Railway, the DATABASE_URL env var is injected automatically
// by the Postgres addon. Locally, copy .env.example → .env.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres uses SSL in production
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// Verify connection on startup — non-fatal so the healthcheck
// endpoint can still respond even if DB is momentarily unavailable.
pool.connect((err, client, release) => {
  if (err) {
    console.warn('[DB] Warning: could not connect on startup:', err.message);
    console.warn('[DB] Make sure DATABASE_URL is set and the Postgres service is linked in Railway.');
    return; // Don't crash — routes will fail individually if DB is down
  }
  release();
  console.log('[DB] Connected to PostgreSQL ✓');
});

module.exports = pool;
