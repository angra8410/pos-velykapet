const express = require('express');
const router = express.Router();
const db = require('../db');

// ---------------------------------------------------------------
// POST /api/sync
// Bulk sync endpoint: accepts a payload of sales (with items)
// from the browser's IndexedDB (Dexie) and upserts them into
// the production database. Designed to be idempotent via local_id.
//
// Body: {
//   sales: [{
//     local_id, timestamp, origin, payment_method, transaction_code,
//     total_amount, delivery_*, notes,
//     items: [{ barcode, product_name, quantity, unit_cost, unit_price }]
//   }]
// }
// ---------------------------------------------------------------
router.post('/', async (req, res) => {
  const client = await db.connect();
  try {
    const { sales } = req.body;
    if (!Array.isArray(sales) || sales.length === 0) {
      return res.status(400).json({ error: 'sales array is required and must not be empty' });
    }

    await client.query('BEGIN');

    const results = [];

    for (const sale of sales) {
      const {
        local_id, timestamp, origin, payment_method, transaction_code,
        total_amount, delivery_tower, delivery_apartment, delivery_complex,
        notes, items, sale_type, invoice_number,
      } = sale;

      // Skip if already synced (idempotency by local_id)
      if (local_id != null) {
        const existing = await client.query(
          'SELECT id FROM sales WHERE local_id = $1',
          [local_id]
        );
        if (existing.rowCount > 0) {
          results.push({ local_id, server_id: existing.rows[0].id, status: 'skipped' });
          continue;
        }
      }

      // Insert sale header
      const saleRes = await client.query(
        `INSERT INTO sales
           (local_id, timestamp, origin, payment_method, transaction_code,
            total_amount, delivery_tower, delivery_apartment, delivery_complex, notes, sale_type, invoice_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          local_id || null, timestamp, origin, payment_method,
          transaction_code || null, total_amount,
          delivery_tower || null, delivery_apartment || null,
          delivery_complex || null, notes || null,
          sale_type || 'Venta Comercial',
          invoice_number || null,
        ]
      );
      const serverId = saleRes.rows[0].id;

      // Insert line items
      if (Array.isArray(items)) {
        for (const item of items) {
          await client.query(
            `INSERT INTO sale_items (sale_id, barcode, product_name, quantity, unit_cost, unit_price)
                  VALUES ($1, $2, $3, $4, $5, $6)`,
            [serverId, item.barcode, item.product_name, item.quantity, item.unit_cost, item.unit_price]
          );
        }
      }

      results.push({ local_id, server_id: serverId, status: 'synced' });
    }

    await client.query('COMMIT');
    res.json({
      message: `Processed ${sales.length} sale(s)`,
      results,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[sync] POST /', err);
    res.status(500).json({ error: 'Sync failed' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// GET /api/sync/status
// Returns the timestamp of the latest synced sale, so the
// browser knows where to start its next sync batch.
// ---------------------------------------------------------------
router.get('/status', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT MAX(created_at) AS last_sync, COUNT(*)::INT AS total_sales FROM sales`
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('[sync] GET /status', err);
    res.status(500).json({ error: 'Status check failed' });
  }
});

module.exports = router;
