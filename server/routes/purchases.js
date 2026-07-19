const express = require('express');
const router = express.Router();
const db = require('../db');

// ---------------------------------------------------------------
// GET /api/purchases
// List purchases with optional filtering by date range, category, supplier, barcode
// Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD&category=Bienestar&supplier=CDM&limit=100
// ---------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const { from, to, category, supplier, barcode, limit = 5000 } = req.query;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (from) {
      conditions.push(`p.timestamp >= $${idx++}`);
      params.push(from);
    }
    if (to) {
      conditions.push(`p.timestamp <= $${idx++}`);
      params.push(to + ' 23:59:59');
    }
    if (category) {
      conditions.push(`mc.category = $${idx++}`);
      params.push(category);
    }
    if (supplier) {
      conditions.push(`p.supplier = $${idx++}`);
      params.push(supplier);
    }
    if (barcode) {
      conditions.push(`p.barcode = $${idx++}`);
      params.push(barcode);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const queryText = `
      SELECT p.id, p.local_id, p.timestamp, p.barcode, mc.product_name, mc.category,
             p.supplier, p.quantity, p.cost_price, p.total_price, p.status, p.lot_reference, p.notes
        FROM purchases p
        JOIN master_catalog mc ON mc.barcode = p.barcode
        ${whereClause}
       ORDER BY p.timestamp DESC
       LIMIT $${idx++}
    `;
    params.push(parseInt(limit) || 5000);

    const result = await db.query(queryText, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// POST /api/purchases
// Add a single purchase entry, optionally updating the live products table
// ---------------------------------------------------------------
router.post('/', async (req, res, next) => {
  const client = await db.connect();
  try {
    const {
      local_id, timestamp, barcode, product_name, category, supplier,
      quantity, cost_price, total_price, status, lot_reference, notes,
      update_inventory = false
    } = req.body;

    if (!timestamp || !barcode || !product_name || quantity == null || cost_price == null || total_price == null) {
      return res.status(400).json({ error: 'Missing required purchase fields' });
    }

    await client.query('BEGIN');

    // 1. Ensure master_catalog has the barcode
    await client.query(
      `INSERT INTO master_catalog (barcode, product_name, category)
            VALUES ($1, $2, $3)
       ON CONFLICT (barcode) DO UPDATE
          SET product_name = EXCLUDED.product_name,
              category = EXCLUDED.category`,
      [barcode, product_name, category || 'General']
    );

    // 2. Insert purchase record
    const insertPurchaseQuery = `
      INSERT INTO purchases (local_id, timestamp, barcode, supplier, quantity, cost_price, total_price, status, lot_reference, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
    const purchaseParams = [
      local_id || null,
      new Date(timestamp),
      barcode,
      supplier || null,
      parseInt(quantity),
      parseFloat(cost_price),
      parseFloat(total_price),
      status || 'Disponible',
      lot_reference || null,
      notes || null
    ];
    const purchaseRes = await client.query(insertPurchaseQuery, purchaseParams);
    const newPurchase = purchaseRes.rows[0];

    // 3. Update products stock and cost_price if requested
    if (update_inventory) {
      const upsertProductQuery = `
        INSERT INTO products (barcode, supplier, cost_price, stock, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (barcode) DO UPDATE
            SET stock       = products.stock + EXCLUDED.stock,
                cost_price  = EXCLUDED.cost_price,
                supplier    = EXCLUDED.supplier,
                updated_at  = NOW()
      `;
      await client.query(upsertProductQuery, [
        barcode,
        supplier || null,
        parseFloat(cost_price),
        parseInt(quantity)
      ]);
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: newPurchase });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// POST /api/purchases/bulk
// Bulk load multiple purchases (used for Excel importer migrations and background sync)
// ---------------------------------------------------------------
router.post('/bulk', async (req, res, next) => {
  const client = await db.connect();
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required and must not be empty' });
    }

    await client.query('BEGIN');

    // 1. Gather and insert unique catalog items in one bulk query
    const uniqueProducts = [];
    const seenBarcodes = new Set();
    for (const row of rows) {
      const barcode = row.barcode ? String(row.barcode).trim() : null;
      if (!barcode || !row.product_name) continue;
      if (!seenBarcodes.has(barcode)) {
        seenBarcodes.add(barcode);
        uniqueProducts.push({
          barcode,
          product_name: String(row.product_name).trim(),
          category: row.category ? String(row.category).trim() : 'General'
        });
      }
    }

    if (uniqueProducts.length > 0) {
      const catalogValues = [];
      const catalogPlaceholders = [];
      uniqueProducts.forEach((prod, index) => {
        const offset = index * 3;
        catalogPlaceholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
        catalogValues.push(prod.barcode, prod.product_name, prod.category);
      });
      const catalogQuery = `
        INSERT INTO master_catalog (barcode, product_name, category)
        VALUES ${catalogPlaceholders.join(', ')}
        ON CONFLICT (barcode) DO NOTHING
      `;
      await client.query(catalogQuery, catalogValues);
    }

    // 2. Prepare purchase insertions and handle active stock updates if requested
    const purchaseValues = [];
    const purchasePlaceholders = [];
    let paramIndex = 1;

    for (const row of rows) {
      const {
        local_id, timestamp, barcode, product_name, category, supplier,
        quantity, cost_price, total_price, status, lot_reference, notes,
        update_inventory = false
      } = row;

      if (!barcode || !product_name || quantity == null || cost_price == null) continue;

      purchasePlaceholders.push(`($${paramIndex}, $${paramIndex+1}, $${paramIndex+2}, $${paramIndex+3}, $${paramIndex+4}, $${paramIndex+5}, $${paramIndex+6}, $${paramIndex+7}, $${paramIndex+8}, $${paramIndex+9})`);
      purchaseValues.push(
        local_id || null,
        new Date(timestamp),
        barcode,
        supplier || null,
        parseInt(quantity),
        parseFloat(cost_price),
        parseFloat(total_price || (quantity * cost_price)),
        status || 'Disponible',
        lot_reference || null,
        notes || null
      );
      paramIndex += 10;

      // 3. Update products stock and cost_price (only for items marked with update_inventory = true, e.g., manual entries)
      if (update_inventory) {
        const upsertProductQuery = `
          INSERT INTO products (barcode, supplier, cost_price, stock, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (barcode) DO UPDATE
              SET stock       = products.stock + EXCLUDED.stock,
                  cost_price  = EXCLUDED.cost_price,
                  supplier    = EXCLUDED.supplier,
                  updated_at  = NOW()
        `;
        await client.query(upsertProductQuery, [
          barcode,
          supplier || null,
          parseFloat(cost_price),
          parseInt(quantity)
        ]);
      }
    }

    if (purchasePlaceholders.length > 0) {
      const purchaseQuery = `
        INSERT INTO purchases (local_id, timestamp, barcode, supplier, quantity, cost_price, total_price, status, lot_reference, notes)
        VALUES ${purchasePlaceholders.join(', ')}
      `;
      await client.query(purchaseQuery, purchaseValues);
    }

    await client.query('COMMIT');
    res.json({ success: true, count: rows.length });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      console.warn('[DB] Failed to rollback transaction:', rbErr.message);
    }
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// DELETE /api/purchases/:id
// Void/delete a specific purchase entry
// ---------------------------------------------------------------
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM purchases WHERE id = $1 RETURNING *', [id]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Purchase entry not found' });
    }
    
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
