const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL || '';
const isRailwayInternal = dbUrl.includes('railway.internal');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isRailwayInternal ? false : { rejectUnauthorized: false },
});

// Catch pool errors to prevent process crashes on network dropouts or database disconnects
pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle database client:', err.message);
});

// Catch client-level errors on active connections to prevent process crashes
pool.on('connect', (client) => {
  client.on('error', (err) => {
    console.error('[DB] Database client error:', err.message);
  });
});

// Verify connection on startup — non-fatal so the healthcheck
// endpoint can still respond even if DB is momentarily unavailable.
pool.connect((err, client, release) => {
  if (err) {
    console.warn('[DB] Warning: could not connect on startup:', err.message);
    console.warn('[DB] Make sure DATABASE_URL is set and the Postgres service is linked in Railway.');
    return;
  }
  // Run schema migrations for sale_type and invoice_number if they do not exist
  const migrationQuery = `
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_type VARCHAR(50) DEFAULT 'Venta Comercial';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(100);
    UPDATE sales 
       SET invoice_number = 'VK' || TO_CHAR(timestamp, 'YY') || '1' || LPAD(local_id::text, 5, '0')
     WHERE invoice_number IS NULL AND local_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS purchases (
        id                  SERIAL PRIMARY KEY,
        local_id            INT,
        timestamp           TIMESTAMP NOT NULL,
        barcode             VARCHAR(100) NOT NULL REFERENCES master_catalog (barcode) ON DELETE CASCADE,
        supplier            VARCHAR(150),
        quantity            INT NOT NULL,
        cost_price          NUMERIC(12, 2) NOT NULL,
        total_price         NUMERIC(12, 2) NOT NULL,
        status              VARCHAR(100) DEFAULT 'Disponible',
        lot_reference       VARCHAR(150),
        notes               TEXT,
        created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_purchases_timestamp ON purchases (timestamp);
    CREATE INDEX IF NOT EXISTS idx_purchases_barcode   ON purchases (barcode);
    CREATE INDEX IF NOT EXISTS idx_purchases_supplier  ON purchases (supplier);
    CREATE INDEX IF NOT EXISTS idx_purchases_local_id  ON purchases (local_id);
  `;
  client.query(migrationQuery, (alterErr) => {
    release();
    if (alterErr) {
      console.error('[DB] Failed to run schema migrations:', alterErr.message);
    } else {
      console.log('[DB] Database schema migrations completed successfully.');
    }
  });
  console.log('[DB] Connected to PostgreSQL ✓');
});

module.exports = pool;

