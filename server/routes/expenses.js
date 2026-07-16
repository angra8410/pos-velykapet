const express = require('express');
const router = express.Router();
const db = require('../db');

// ---------------------------------------------------------------
// GET /api/expenses
// List expenses, optionally filtered by category
// ---------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const { category, limit = 100 } = req.query;
    let queryText = 'SELECT * FROM expenses';
    const queryParams = [];

    if (category) {
      queryText += ' WHERE category = $1';
      queryParams.push(category);
    }

    queryText += ` ORDER BY timestamp DESC LIMIT $${queryParams.length + 1}`;
    queryParams.push(parseInt(limit) || 100);

    const result = await db.query(queryText, queryParams);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// POST /api/expenses
// Add a single expense entry
// ---------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const { timestamp, description, category, payment_method, amount, notes } = req.body;
    
    if (!timestamp || !description || !category || !payment_method || amount == null) {
      return res.status(400).json({ error: 'Missing required expense fields' });
    }

    const queryText = `
      INSERT INTO expenses (timestamp, description, category, payment_method, amount, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const params = [
      new Date(timestamp),
      description,
      category,
      payment_method,
      parseFloat(amount),
      notes || null
    ];

    const result = await db.query(queryText, params);
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------
// POST /api/expenses/bulk
// Bulk load multiple expenses (used for Excel importer migrations)
// ---------------------------------------------------------------
router.post('/bulk', async (req, res, next) => {
  const client = await db.connect();
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required and must not be empty' });
    }

    await client.query('BEGIN');

    const queryText = `
      INSERT INTO expenses (timestamp, description, category, payment_method, amount, notes)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;

    for (const row of rows) {
      const { timestamp, description, category, payment_method, amount, notes } = row;
      const params = [
        new Date(timestamp),
        description,
        category,
        payment_method,
        parseFloat(amount) || 0,
        notes || null
      ];
      await client.query(queryText, params);
    }

    await client.query('COMMIT');
    res.json({ success: true, count: rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------
// DELETE /api/expenses/:id
// Delete a specific expense entry
// ---------------------------------------------------------------
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await db.query('DELETE FROM expenses WHERE id = $1 RETURNING *', [id]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Expense entry not found' });
    }
    
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
