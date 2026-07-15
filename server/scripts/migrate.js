/**
 * Migration runner — run with: npm run migrate
 *
 * Reads server/migrations/*.sql files in order and executes them
 * against the database. Safe to re-run (all DDL uses IF NOT EXISTS).
 */
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const dbUrl = process.env.DATABASE_URL || '';
const isRailwayInternal = dbUrl.includes('railway.internal');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isRailwayInternal ? false : { rejectUnauthorized: false },
});

async function runMigrations() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort(); // ensures 001_ runs before 002_

  console.log(`[migrate] Found ${files.length} migration file(s)`);

  const client = await pool.connect();
  try {
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      console.log(`[migrate] Running: ${file}`);
      await client.query(sql);
      console.log(`[migrate] ✓ ${file} applied`);
    }
    console.log('[migrate] All migrations complete ✓');
  } catch (err) {
    console.error('[migrate] FAILED:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
