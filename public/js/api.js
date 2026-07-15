/**
 * Backend API Fetch wrappers
 */

const API_BASE = '/api';

const api = {
  // Check backend server health
  async checkHealth() {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn('[API] Health check failed:', err.message);
      return null;
    }
  },

  // Upload bulk catalog entries
  async importCatalogBulk(rows) {
    const res = await fetch(`${API_BASE}/catalog/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Bulk catalog import failed');
    }
    return await res.json();
  },

  // Upload bulk products entries
  async importProductsBulk(rows) {
    const res = await fetch(`${API_BASE}/products/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Bulk products import failed');
    }
    return await res.json();
  },

  // Sync sales from local DB to server
  async syncSales(salesPayload) {
    const res = await fetch(`${API_BASE}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sales: salesPayload })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Sales synchronization failed');
    }
    return await res.json();
  },

  // Get status of latest sync from server
  async getSyncStatus() {
    const res = await fetch(`${API_BASE}/sync/status`);
    if (!res.ok) throw new Error('Failed to get sync status');
    return await res.json();
  }
};
