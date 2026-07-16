/**
 * Duplicate Barcode Clean-up Script
 * Run with: npm run clean-duplicates
 * 
 * Scans the Railway PostgreSQL database for barcodes with leading zeros.
 * Merges stock levels and logs, keeps the normalized barcode (no leading zeros),
 * and removes duplicate entries to ensure a clean database.
 */
require('dotenv').config();
const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL || '';
const isRailwayInternal = dbUrl.includes('railway.internal');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isRailwayInternal ? false : { rejectUnauthorized: false },
});

function normalizeBarcode(barcode) {
  if (barcode === undefined || barcode === null) return '';
  const cleaned = String(barcode).trim();
  const stripped = cleaned.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

async function cleanDuplicates() {
  console.log('[cleanup] Starting database cleanup for duplicate barcodes...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get all catalog items
    const { rows: catalogRows } = await client.query(
      'SELECT barcode, product_name, category FROM master_catalog'
    );

    console.log(`[cleanup] Found ${catalogRows.length} catalog items.`);

    let mergeCount = 0;
    let renameCount = 0;

    for (const row of catalogRows) {
      const originalBarcode = row.barcode;
      const normalized = normalizeBarcode(originalBarcode);

      if (normalized === originalBarcode) {
        continue; // Already normalized
      }

      // Check if normalized version already exists in master_catalog
      const { rows: existsNorm } = await client.query(
        'SELECT barcode FROM master_catalog WHERE barcode = $1',
        [normalized]
      );

      const normalizedExists = existsNorm.length > 0;

      if (normalizedExists) {
        // --- MERGE CASE ---
        console.log(`[cleanup] Merging duplicate: "${originalBarcode}" -> "${normalized}"`);

        // Check product presence
        const { rows: origProd } = await client.query(
          'SELECT stock, cost_price, sale_price, rappi_price, supplier FROM products WHERE barcode = $1',
          [originalBarcode]
        );
        const { rows: normProd } = await client.query(
          'SELECT stock, cost_price, sale_price, rappi_price, supplier FROM products WHERE barcode = $1',
          [normalized]
        );

        if (origProd.length > 0 && normProd.length > 0) {
          // Both exist in products. Merge them.
          const op = origProd[0];
          const np = normProd[0];

          const mergedStock = (parseInt(op.stock) || 0) + (parseInt(np.stock) || 0);
          
          // Keep best price info
          const cost = Number(np.cost_price) || Number(op.cost_price) || 0;
          const sale = Number(np.sale_price) || Number(op.sale_price) || 0;
          const rappi = Number(np.rappi_price) || Number(op.rappi_price) || sale;
          const supplier = np.supplier !== 'Unknown' ? np.supplier : (op.supplier || 'Unknown');

          // Update normalized product
          await client.query(
            `UPDATE products 
                SET stock = $1, cost_price = $2, sale_price = $3, rappi_price = $4, supplier = $5, updated_at = NOW()
              WHERE barcode = $6`,
            [mergedStock, cost, sale, rappi, supplier, normalized]
          );

          // Update sale_items
          await client.query(
            'UPDATE sale_items SET barcode = $1 WHERE barcode = $2',
            [normalized, originalBarcode]
          );

          // Delete leading-zero version
          await client.query('DELETE FROM products WHERE barcode = $1', [originalBarcode]);
          await client.query('DELETE FROM master_catalog WHERE barcode = $1', [originalBarcode]);

        } else if (origProd.length > 0) {
          // Only original (leading-zero) exists in products. Move it to normalized.
          const op = origProd[0];
          await client.query(
            `INSERT INTO products (barcode, supplier, cost_price, sale_price, rappi_price, stock, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (barcode) DO UPDATE
             SET stock = EXCLUDED.stock, cost_price = EXCLUDED.cost_price, sale_price = EXCLUDED.sale_price, rappi_price = EXCLUDED.rappi_price`,
            [normalized, op.supplier || 'Unknown', op.cost_price || 0, op.sale_price || 0, op.rappi_price || 0, op.stock || 0]
          );

          await client.query(
            'UPDATE sale_items SET barcode = $1 WHERE barcode = $2',
            [normalized, originalBarcode]
          );

          await client.query('DELETE FROM products WHERE barcode = $1', [originalBarcode]);
          await client.query('DELETE FROM master_catalog WHERE barcode = $1', [originalBarcode]);

        } else {
          // Neither or only normalized exists in products. Just delete leading-zero catalog row.
          await client.query(
            'UPDATE sale_items SET barcode = $1 WHERE barcode = $2',
            [normalized, originalBarcode]
          );
          await client.query('DELETE FROM master_catalog WHERE barcode = $1', [originalBarcode]);
        }

        mergeCount++;
      } else {
        // --- RENAME CASE ---
        console.log(`[cleanup] Normalizing barcode: "${originalBarcode}" -> "${normalized}"`);

        // Insert new normalized catalog entry
        await client.query(
          'INSERT INTO master_catalog (barcode, product_name, category) VALUES ($1, $2, $3)',
          [normalized, row.product_name, row.category]
        );

        // Update product barcode if exists
        await client.query(
          'UPDATE products SET barcode = $1 WHERE barcode = $2',
          [normalized, originalBarcode]
        );

        // Update sale items
        await client.query(
          'UPDATE sale_items SET barcode = $1 WHERE barcode = $2',
          [normalized, originalBarcode]
        );

        // Delete old catalog row (cascades or we deleted product reference already)
        await client.query('DELETE FROM master_catalog WHERE barcode = $1', [originalBarcode]);

        renameCount++;
      }
    }

    // 2. Cleanup any orphaned/unnormalized barcodes left in sale_items
    const { rows: saleItemBarcodes } = await client.query(
      "SELECT DISTINCT barcode FROM sale_items WHERE barcode LIKE '0%'"
    );
    let saleItemFixes = 0;
    for (const sib of saleItemBarcodes) {
      const normSib = normalizeBarcode(sib.barcode);
      if (normSib !== sib.barcode) {
        await client.query(
          'UPDATE sale_items SET barcode = $1 WHERE barcode = $2',
          [normSib, sib.barcode]
        );
        saleItemFixes++;
      }
    }

    await client.query('COMMIT');
    console.log(`[cleanup] Merged ${mergeCount} duplicates.`);
    console.log(`[cleanup] Normalized ${renameCount} barcodes.`);
    console.log(`[cleanup] Fixed ${saleItemFixes} unnormalized barcodes in sale items.`);
    console.log('[cleanup] Cleanup successfully committed ✓');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[cleanup] Failed to run database cleanup:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

cleanDuplicates();
