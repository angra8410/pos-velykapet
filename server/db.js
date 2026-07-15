const { Pool } = require('pg');

// Railway connections (both internal private network and public TCP proxy)
// do NOT use client-side SSL — the proxy handles transport security externally.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || '',
  ssl: false,
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

