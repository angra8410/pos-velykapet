const express = require('express');
const router = express.Router();
const db = require('../db');

// ---------------------------------------------------------------
// GET /api/catalog
// List all catalog entries, with optional ?search= filter.
// ---------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let result;

    if (search) {
      result = await db.query(
        `SELECT barcode, product_name, category
           FROM master_catalog
          WHERE barcode ILIKE $1
             OR product_name ILIKE $1
          ORDER BY product_name
          LIMIT 100`,
        [`%${search}%`]
      );
    } else {
      result = await db.query(
        `SELECT barcode, product_name, category
           FROM master_catalog
          ORDER BY product_name`
      );
    }

    res.json({ data: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('[catalog] GET /', err);
    res.status(500).json({ error: 'Failed to fetch catalog' });
  }
});

// ---------------------------------------------------------------
// GET /api/catalog/:barcode
// Look up a single product by exact barcode — used at POS scan.
// ---------------------------------------------------------------
router.get('/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    const result = await db.query(
      `SELECT mc.barcode, mc.product_name, mc.category,
              p.supplier, p.cost_price, p.sale_price, p.rappi_price, p.stock
         FROM master_catalog mc
         LEFT JOIN products p ON p.barcode = mc.barcode
        WHERE mc.barcode = $1`,
      [barcode]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Barcode not found' });
    }

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[catalog] GET /:barcode', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ---------------------------------------------------------------
// POST /api/catalog
// Insert a single catalog entry.
// ---------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { barcode, product_name, category } = req.body;
    if (!barcode || !product_name || !category) {
      return res.status(400).json({ error: 'barcode, product_name and category are required' });
    }

    const result = await db.query(
      `INSERT INTO master_catalog (barcode, product_name, category)
            VALUES ($1, $2, $3)
       ON CONFLICT (barcode) DO UPDATE
           SET product_name = EXCLUDED.product_name,
               category     = EXCLUDED.category
         RETURNING *`,
      [barcode, product_name, category]
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    console.error('[catalog] POST /', err);
    res.status(500).json({ error: 'Insert failed' });
  }
});

// ---------------------------------------------------------------
// POST /api/catalog/bulk
// Bulk-upsert catalog entries from Excel import.
// Body: { rows: [{ barcode, product_name, category }, ...] }
// ---------------------------------------------------------------
router.post('/bulk', async (req, res) => {
  const client = await db.connect();
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required and must not be empty' });
    }

    await client.query('BEGIN');

    let inserted = 0;
    for (const row of rows) {
      const { barcode, product_name, category } = row;
      if (!barcode || !product_name || !category) continue;

      await client.query(
        `INSERT INTO master_catalog (barcode, product_name, category)
              VALUES ($1, $2, $3)
         ON CONFLICT (barcode) DO UPDATE
             SET product_name = EXCLUDED.product_name,
                 category     = EXCLUDED.category`,
        [barcode, product_name, category]
      );
      inserted++;
    }

    await client.query('COMMIT');
    res.status(201).json({ message: `Upserted ${inserted} catalog entries` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[catalog] POST /bulk', err);
    res.status(500).json({ error: 'Bulk import failed' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// DELETE /api/catalog/:barcode
// Remove a catalog entry (cascades to products).
// ---------------------------------------------------------------
router.delete('/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    await db.query('DELETE FROM master_catalog WHERE barcode = $1', [barcode]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('[catalog] DELETE /:barcode', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
