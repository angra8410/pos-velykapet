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

// Verify connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error('[DB] Connection error:', err.message);
    process.exit(1);
  }
  release();
  console.log('[DB] Connected to PostgreSQL ✓');
});

module.exports = pool;
