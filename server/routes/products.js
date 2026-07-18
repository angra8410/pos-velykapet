const express = require('express');
const router = express.Router();
const db = require('../db');

// ---------------------------------------------------------------
// GET /api/products
// List all products with their catalog info joined.
// ---------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.id, p.barcode, mc.product_name, mc.category,
              p.supplier, p.cost_price, p.sale_price, p.rappi_price,
              p.stock, p.updated_at, p.expiration_date
         FROM products p
         JOIN master_catalog mc ON mc.barcode = p.barcode
        ORDER BY mc.product_name`
    );
    res.json({ data: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('[products] GET /', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// ---------------------------------------------------------------
// GET /api/products/:barcode
// Fetch a single product record by barcode.
// ---------------------------------------------------------------
router.get('/:barcode', async (req, res) => {
  try {
    const { barcode } = req.params;
    const result = await db.query(
      `SELECT p.id, p.barcode, mc.product_name, mc.category,
              p.supplier, p.cost_price, p.sale_price, p.rappi_price,
              p.stock, p.updated_at, p.expiration_date
         FROM products p
         JOIN master_catalog mc ON mc.barcode = p.barcode
        WHERE p.barcode = $1`,
      [barcode]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[products] GET /:barcode', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ---------------------------------------------------------------
// POST /api/products
// Insert or update a product record (upsert by barcode).
// ---------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { barcode, supplier, cost_price, sale_price, rappi_price, stock, expiration_date } = req.body;
    if (!barcode) {
      return res.status(400).json({ error: 'barcode is required' });
    }

    const result = await db.query(
      `INSERT INTO products (barcode, supplier, cost_price, sale_price, rappi_price, stock, expiration_date, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (barcode) DO UPDATE
           SET supplier    = EXCLUDED.supplier,
               cost_price  = EXCLUDED.cost_price,
               sale_price  = EXCLUDED.sale_price,
               rappi_price = EXCLUDED.rappi_price,
               stock       = EXCLUDED.stock,
               expiration_date = EXCLUDED.expiration_date,
               updated_at  = NOW()
         RETURNING *`,
      [barcode, supplier || null, cost_price || 0, sale_price || 0, rappi_price || 0, stock || 0, expiration_date || null]
    );

    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    console.error('[products] POST /', err);
    res.status(500).json({ error: 'Upsert failed' });
  }
});

// ---------------------------------------------------------------
// POST /api/products/bulk
// Bulk-upsert product records from the Inventario DEFINITIVO import.
// Body: { rows: [{ barcode, supplier, cost_price, sale_price, rappi_price, stock }, ...] }
// ---------------------------------------------------------------
router.post('/bulk', async (req, res) => {
  const client = await db.connect();
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required and must not be empty' });
    }

    await client.query('BEGIN');

    let upserted = 0;
    for (const row of rows) {
      const { barcode, supplier, cost_price, sale_price, rappi_price, stock, product_name, category, expiration_date } = row;
      if (!barcode) continue;

      // Ensure the barcode exists in master_catalog first to prevent FK violation
      await client.query(
        `INSERT INTO master_catalog (barcode, product_name, category)
              VALUES ($1, $2, $3)
         ON CONFLICT (barcode) DO NOTHING`,
        [barcode, product_name || 'Product ' + barcode, category || 'General']
      );

      await client.query(
        `INSERT INTO products (barcode, supplier, cost_price, sale_price, rappi_price, stock, expiration_date, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (barcode) DO UPDATE
             SET supplier    = EXCLUDED.supplier,
                 cost_price  = EXCLUDED.cost_price,
                 sale_price  = EXCLUDED.sale_price,
                 rappi_price = EXCLUDED.rappi_price,
                 stock       = EXCLUDED.stock,
                 expiration_date = EXCLUDED.expiration_date,
                 updated_at  = NOW()`,
        [barcode, supplier || null, cost_price || 0, sale_price || 0, rappi_price || 0, stock || 0, expiration_date || null]
      );
      upserted++;
    }

    await client.query('COMMIT');
    res.status(201).json({ message: `Upserted ${upserted} product records` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[products] POST /bulk', err);
    res.status(500).json({ error: 'Bulk upsert failed' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// PATCH /api/products/:barcode/stock
// Adjust stock by a delta (positive = restock, negative = sold).
// Body: { delta: -1 }
// ---------------------------------------------------------------
router.patch('/:barcode/stock', async (req, res) => {
  try {
    const { barcode } = req.params;
    const { delta } = req.body;

    if (delta === undefined || isNaN(Number(delta))) {
      return res.status(400).json({ error: 'delta (integer) is required' });
    }

    const result = await db.query(
      `UPDATE products
          SET stock      = GREATEST(0, stock + $1),
              updated_at = NOW()
        WHERE barcode = $2
        RETURNING stock`,
      [Number(delta), barcode]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({ barcode, new_stock: result.rows[0].stock });
  } catch (err) {
    console.error('[products] PATCH /:barcode/stock', err);
    res.status(500).json({ error: 'Stock update failed' });
  }
});

module.exports = router;
