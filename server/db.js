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
  // Run schema migration to add sale_type if it does not exist
  client.query("ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_type VARCHAR(50) DEFAULT 'Venta Comercial';", (alterErr) => {
    release();
    if (alterErr) {
      console.error('[DB] Failed to run schema migration for sale_type:', alterErr.message);
    } else {
      console.log('[DB] Database schema migration for sale_type completed successfully.');
    }
  });
  console.log('[DB] Connected to PostgreSQL ✓');
});

module.exports = pool;

