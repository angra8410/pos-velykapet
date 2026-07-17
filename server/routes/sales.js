const express = require('express');
const router = express.Router();
const db = require('../db');

// ---------------------------------------------------------------
// GET /api/sales
// List sales with optional date range filters.
// Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD&origin=tienda&limit=50&offset=0
// ---------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { from, to, origin, payment_method, limit = 50, offset = 0 } = req.query;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (from) { conditions.push(`s.timestamp >= $${idx++}`); params.push(from); }
    if (to)   { conditions.push(`s.timestamp <= $${idx++}`); params.push(to + ' 23:59:59'); }
    if (origin)         { conditions.push(`s.origin = $${idx++}`); params.push(origin); }
    if (payment_method) { conditions.push(`s.payment_method = $${idx++}`); params.push(payment_method); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await db.query(
      `SELECT s.id, s.local_id, s.timestamp, s.origin, s.payment_method,
              s.transaction_code, s.total_amount,
              s.delivery_tower, s.delivery_apartment, s.delivery_complex,
              s.notes, s.created_at, s.sale_type,
              COUNT(si.id)::INT AS item_count
         FROM sales s
         LEFT JOIN sale_items si ON si.sale_id = s.id
         ${where}
         GROUP BY s.id
         ORDER BY s.timestamp DESC
         LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, Number(limit), Number(offset)]
    );

    res.json({ data: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('[sales] GET /', err);
    res.status(500).json({ error: 'Failed to fetch sales' });
  }
});

// ---------------------------------------------------------------
// GET /api/sales/:id
// Fetch a single sale with its line items.
// ---------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const saleRes = await db.query('SELECT * FROM sales WHERE id = $1', [id]);
    if (saleRes.rowCount === 0) {
      return res.status(404).json({ error: 'Sale not found' });
    }

    const itemsRes = await db.query(
      `SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id`,
      [id]
    );

    res.json({ data: { ...saleRes.rows[0], items: itemsRes.rows } });
  } catch (err) {
    console.error('[sales] GET /:id', err);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// ---------------------------------------------------------------
// POST /api/sales
// Create a new sale with its line items in a single transaction.
// Automatically decrements stock for each item sold.
// Body: {
//   local_id, timestamp, origin, payment_method, transaction_code,
//   total_amount, delivery_tower, delivery_apartment, delivery_complex,
//   notes,
//   items: [{ barcode, product_name, quantity, unit_cost, unit_price }]
// }
// ---------------------------------------------------------------
router.post('/', async (req, res) => {
  const client = await db.connect();
  try {
    const {
      local_id, timestamp, origin, payment_method, transaction_code,
      total_amount, delivery_tower, delivery_apartment, delivery_complex,
      notes, items, sale_type,
    } = req.body;

    // Validate required fields
    if (!timestamp || !origin || !payment_method || !total_amount) {
      return res.status(400).json({
        error: 'timestamp, origin, payment_method and total_amount are required',
      });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array must not be empty' });
    }

    await client.query('BEGIN');

    // Insert the sale header
    const saleRes = await client.query(
      `INSERT INTO sales
         (local_id, timestamp, origin, payment_method, transaction_code,
          total_amount, delivery_tower, delivery_apartment, delivery_complex, notes, sale_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        local_id || null, timestamp, origin, payment_method,
        transaction_code || null, total_amount,
        delivery_tower || null, delivery_apartment || null,
        delivery_complex || null, notes || null,
        sale_type || 'Venta Comercial',
      ]
    );
    const saleId = saleRes.rows[0].id;

    // Insert each line item and decrement stock
    for (const item of items) {
      const { barcode, product_name, quantity, unit_cost, unit_price } = item;

      await client.query(
        `INSERT INTO sale_items (sale_id, barcode, product_name, quantity, unit_cost, unit_price)
              VALUES ($1, $2, $3, $4, $5, $6)`,
        [saleId, barcode, product_name, quantity, unit_cost, unit_price]
      );

      // Decrement stock — floor at 0
      await client.query(
        `UPDATE products
            SET stock      = GREATEST(0, stock - $1),
                updated_at = NOW()
          WHERE barcode = $2`,
        [quantity, barcode]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ data: { id: saleId, local_id } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[sales] POST /', err);
    res.status(500).json({ error: 'Sale creation failed' });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// GET /api/sales/report/summary
// Daily/monthly summary for dashboard KPIs.
// Query params: ?period=day|month&date=YYYY-MM-DD
// ---------------------------------------------------------------
router.get('/report/summary', async (req, res) => {
  try {
    const { period = 'day', date = new Date().toISOString().slice(0, 10) } = req.query;

    const truncUnit = period === 'month' ? 'month' : 'day';

    const result = await db.query(
      `SELECT
         DATE_TRUNC($1, s.timestamp)                   AS period,
         s.origin,
         s.payment_method,
         COUNT(s.id)::INT                               AS sale_count,
         SUM(s.total_amount)                            AS total_revenue,
         SUM(si.total_cost)                             AS total_cost,
         SUM(si.profit)                                 AS total_profit
       FROM sales s
       JOIN sale_items si ON si.sale_id = s.id
       WHERE DATE_TRUNC($1, s.timestamp) = DATE_TRUNC($1, $2::TIMESTAMP)
       GROUP BY 1, 2, 3
       ORDER BY 1 DESC, total_revenue DESC`,
      [truncUnit, date]
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[sales] GET /report/summary', err);
    res.status(500).json({ error: 'Report failed' });
  }
});

// ---------------------------------------------------------------
// DELETE /api/sales/:id
// Deletes a sale, restructures inventory stock, cascades line items.
// ---------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const client = await db.connect();
  try {
    const { id } = req.params;

    await client.query('BEGIN');

    // 1. Fetch sale items to return quantities to stock
    const itemsRes = await client.query(
      'SELECT barcode, quantity FROM sale_items WHERE sale_id = $1',
      [id]
    );

    if (itemsRes.rowCount === 0) {
      const saleHeader = await client.query('SELECT id FROM sales WHERE id = $1', [id]);
      if (saleHeader.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Sale not found' });
      }
    }

    // 2. Restock items (add back quantities)
    for (const item of itemsRes.rows) {
      const { barcode, quantity } = item;
      await client.query(
        `UPDATE products 
            SET stock      = stock + $1, 
                updated_at = NOW() 
          WHERE barcode    = $2`,
        [quantity, barcode]
      );
    }

    // 3. Delete sale header (cascades to sale_items)
    const deleteRes = await client.query('DELETE FROM sales WHERE id = $1 RETURNING local_id', [id]);
    const localId = deleteRes.rows[0]?.local_id || null;

    await client.query('COMMIT');
    res.json({ message: 'Sale voided successfully', voided_id: id, local_id: localId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[sales] DELETE /:id', err);
    res.status(500).json({ error: 'Failed to delete/void sale' });
  } finally {
    client.release();
  }
});

module.exports = router;

