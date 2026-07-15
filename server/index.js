require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '10mb' })); // bulk imports can be large
app.use(express.urlencoded({ extended: true }));

// Serve the future frontend from /public
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------
// Health check — used by Railway's healthcheck probe
// ---------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ---------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------
app.use('/api/catalog',  require('./routes/catalog'));
app.use('/api/products', require('./routes/products'));
app.use('/api/sales',    require('./routes/sales'));
app.use('/api/sync',     require('./routes/sync'));

// ---------------------------------------------------------------
// Catch-all: serve index.html for client-side routing (SPA)
// ---------------------------------------------------------------
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '..', 'public', 'index.html');
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.json({ message: 'POS VelyKaPet API — Phase 1 Backend Ready ✓' });
  }
});

// ---------------------------------------------------------------
// Global error handler
// ---------------------------------------------------------------
app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------
// Start server
// ---------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[server] POS VelyKaPet running on port ${PORT} ✓`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
