/**
 * Backend API Fetch wrappers
 */

const API_BASE = '/api';

const api = {
  // Helper to append Authorization header automatically
  async fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('pos_auth_token');
    if (!options.headers) options.headers = {};
    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(url, options);
    if (res.status === 401 && !url.includes('/auth/verify') && !url.includes('/health')) {
      console.warn('[API] Unauthorized request. Clearing token and forcing login.');
      localStorage.removeItem('pos_auth_token');
      if (window.App && typeof window.App.showLogin === 'function') {
        window.App.showLogin();
      }
      throw new Error('Authentication required');
    }
    return res;
  },

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

  // Verify POS lock password
  async verifyPassword(password) {
    const res = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!res.ok) {
      throw new Error('Invalid password');
    }
    return await res.json();
  },

  // Upload bulk catalog entries
  async importCatalogBulk(rows) {
    const res = await this.fetchWithAuth(`${API_BASE}/catalog/bulk`, {
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
    const res = await this.fetchWithAuth(`${API_BASE}/products/bulk`, {
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
    const res = await this.fetchWithAuth(`${API_BASE}/sync`, {
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
    const res = await this.fetchWithAuth(`${API_BASE}/sync/status`);
    if (!res.ok) throw new Error('Failed to get sync status');
    return await res.json();
  },

  // Upload bulk expenses entries
  async importExpensesBulk(rows) {
    const res = await this.fetchWithAuth(`${API_BASE}/expenses/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Bulk expenses import failed');
    }
    return await res.json();
  },

  // Get recent expenses list from server
  async getExpenses(limit = 100) {
    const res = await this.fetchWithAuth(`${API_BASE}/expenses?limit=${limit}`);
    if (!res.ok) throw new Error('Failed to get expenses list');
    return await res.json();
  },

  // Add single expense entry
  async addExpense(expensePayload) {
    const res = await this.fetchWithAuth(`${API_BASE}/expenses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(expensePayload)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to add expense entry');
    }
    return await res.json();
  },

  // Delete a specific expense entry
  async deleteExpense(id) {
    const res = await this.fetchWithAuth(`${API_BASE}/expenses/${id}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to delete expense entry');
    }
    return await res.json();
  },

  // Delete a specific product record by barcode (cascades on server)
  async deleteProduct(barcode) {
    const res = await this.fetchWithAuth(`${API_BASE}/catalog/${barcode}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to delete product');
    }
    return await res.json();
  },

  // Get all catalog entries from server
  async getCatalog() {
    const res = await this.fetchWithAuth(`${API_BASE}/catalog`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to fetch catalog from server');
    }
    return await res.json();
  },

  // Get all products from server
  async getProducts() {
    const res = await this.fetchWithAuth(`${API_BASE}/products`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to fetch products from server');
    }
    return await res.json();
  }
};
