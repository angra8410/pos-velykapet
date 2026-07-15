/**
 * Main Application View Controller & Router
 * 
 * Orchestrates navigation tabs, bootstraps modules, manages searching,
 * Excel imports UI bindings, and analytics logs renderings.
 */

const App = {
  activeTab: 'tab-pos',

  async init() {
    this.setupRouter();
    this.setupImporterUI();
    this.setupSearch();
    
    // Bootstrap other modules
    SyncEngine.init();
    POS.init();

    // Initial data load
    await this.loadInventory();
    await this.loadReports();
  },

  // Setup tab routing
  setupRouter() {
    const navButtons = document.querySelectorAll('.nav-btn');
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        
        // Update active class on buttons
        navButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Toggle visibility of views
        document.querySelectorAll('.tab-view').forEach(view => {
          view.classList.remove('active');
        });
        const activeView = document.getElementById(targetTab);
        if (activeView) activeView.classList.add('active');

        this.activeTab = targetTab;
        
        // Trigger tab specific loads
        if (targetTab === 'tab-inventory') {
          this.loadInventory();
        } else if (targetTab === 'tab-reports') {
          this.loadReports();
        }
      });
    });
  },

  // Bind Excel file pickers and progress UI
  setupImporterUI() {
    const catalogInput = document.getElementById('file-catalog-input');
    const inventoryInput = document.getElementById('file-inventory-input');

    if (catalogInput) {
      catalogInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await this.handleImport(file, 'catalog');
        catalogInput.value = ''; // clear input
      });
    }

    if (inventoryInput) {
      inventoryInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await this.handleImport(file, 'inventory');
        inventoryInput.value = ''; // clear
      });
    }
  },

  // Core handler for importing catalog/inventory Excel files
  async handleImport(file, type) {
    const progressCard = document.getElementById('import-progress-card');
    const progressTitle = document.getElementById('progress-title');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const progressStatus = document.getElementById('progress-status');

    if (!progressCard) return;

    progressCard.classList.remove('hidden');
    progressTitle.innerText = `Parsing ${type === 'catalog' ? 'Master Catalog' : 'Live Inventory'}...`;
    progressBarFill.style.width = '0%';
    progressStatus.innerText = 'Reading file...';

    const updateProgress = (text, percent) => {
      progressStatus.innerText = text;
      progressBarFill.style.width = `${percent}%`;
    };

    try {
      // 1. Parse Excel buffer to Workbook
      const workbook = await ExcelImporter.parseFile(file);
      
      // Get first sheet or try to find a sheet matching our targeted names
      let sheetName = workbook.SheetNames[0];
      if (type === 'catalog') {
        const found = workbook.SheetNames.find(n => n.toLowerCase().includes('barr'));
        if (found) sheetName = found;
      } else {
        const found = workbook.SheetNames.find(n => n.toLowerCase().includes('defin') || n.toLowerCase().includes('stock'));
        if (found) sheetName = found;
      }

      updateProgress(`Reading sheet: "${sheetName}"...`, 20);

      // 2. Convert sheet to JSON
      const worksheet = workbook.Sheets[sheetName];
      const rawJson = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });

      if (rawJson.length === 0) {
        throw new Error(`Sheet "${sheetName}" is empty!`);
      }

      updateProgress('Auto-detecting headers...', 30);
      
      // Extract headers from first row
      const headers = Object.keys(rawJson[0]);
      
      // Detect column maps
      const mapping = ExcelImporter.detectHeaders(headers, type);
      
      // Ensure we mapped the critical barcode field
      if (!mapping.barcode) {
        throw new Error(`Failed to map Barcode column. Headers found: ${headers.join(', ')}`);
      }
      if (type === 'catalog' && !mapping.product_name) {
        throw new Error('Failed to map Product Name / Description column.');
      }

      updateProgress('Transforming data...', 35);
      
      // Map raw rows to database schema
      const rows = ExcelImporter.transformData(rawJson, mapping, type);

      if (rows.length === 0) {
        throw new Error('No valid rows found after mapping column headers.');
      }

      // 3. Save locally & Push to server
      if (type === 'catalog') {
        await ExcelImporter.importCatalog(rows, updateProgress);
      } else {
        await ExcelImporter.importProducts(rows, updateProgress);
      }

      POS.showToast('Import completed successfully!', 'success');
      await this.loadInventory();

    } catch (err) {
      console.error(err);
      updateProgress(`Error: ${err.message}`, 100);
      progressBarFill.style.backgroundColor = 'var(--color-danger)';
      POS.showToast('Import failed: ' + err.message, 'error');
    }
  },

  // Load local inventory and render data table
  async loadInventory() {
    const tbody = document.getElementById('inventory-tbody');
    if (!tbody) return;

    try {
      const products = await db.products.toArray();
      
      if (products.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="8" class="text-center" style="padding: 40px 0;">
              No products found. Go to <strong>Excel Importer</strong> to import products.
            </td>
          </tr>
        `;
        return;
      }

      let html = '';
      for (const p of products) {
        const cat = await db.master_catalog.get(p.barcode);
        const name = cat ? cat.product_name : 'Unknown Product';
        const category = cat ? cat.category : 'General';
        
        const stock = parseInt(p.stock) || 0;
        const stockClass = stock <= 5 ? 'low' : 'normal';

        html += `
          <tr>
            <td class="font-medium">${p.barcode}</td>
            <td>${name}</td>
            <td><span class="category-tag">${category}</span></td>
            <td>${p.supplier || 'N/A'}</td>
            <td class="text-right">$${Number(p.cost_price).toFixed(2)}</td>
            <td class="text-right">$${Number(p.sale_price).toFixed(2)}</td>
            <td class="text-right">$${Number(p.rappi_price).toFixed(2)}</td>
            <td class="text-center">
              <span class="stock-pill ${stockClass}">${stock} units</span>
            </td>
          </tr>
        `;
      }
      tbody.innerHTML = html;
    } catch (err) {
      console.error('[App] Failed to load inventory:', err);
    }
  },

  // Setup search filter for inventory table
  setupSearch() {
    const searchInput = document.getElementById('inventory-search-input');
    if (!searchInput) return;

    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      const rows = document.querySelectorAll('#inventory-tbody tr');

      rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        if (text.includes(query)) {
          row.style.display = '';
        } else {
          row.style.display = 'none';
        }
      });
    });
  },

  // Load analytics reports and recent sales log
  async loadReports() {
    const tbody = document.getElementById('report-sales-tbody');
    const kpiRevenue = document.getElementById('report-kpi-revenue');
    const kpiSales = document.getElementById('report-kpi-sales');
    const kpiProfit = document.getElementById('report-kpi-profit');
    const serverSalesCount = document.getElementById('report-server-sales-count');
    const lastSyncTime = document.getElementById('report-last-sync-time');

    try {
      // 1. Fetch recent sales log from server (Postgres)
      const res = await api.checkHealth();
      if (res) {
        // If server is online, fetch sales logs and metadata
        const salesRes = await fetch('/api/sales?limit=15');
        if (salesRes.ok) {
          const salesData = await salesRes.json();
          this.renderSalesLogTable(salesData.data);
        }

        // Fetch sync status
        const syncStatus = await api.getSyncStatus();
        if (syncStatus && syncStatus.data) {
          const data = syncStatus.data;
          serverSalesCount.innerText = `${data.total_sales} transactions`;
          lastSyncTime.innerText = data.last_sync ? new Date(data.last_sync).toLocaleString() : 'Never';
        }
      } else {
        // Fallback to local Dexie logs if offline
        const localSales = await db.sales.orderBy('timestamp').reverse().limit(15).toArray();
        this.renderSalesLogTable(localSales);
        serverSalesCount.innerText = 'Offline';
        lastSyncTime.innerText = 'Offline';
      }

      // 2. Calculate Today's KPIs locally from Dexie (ensures local-first offline KPI accuracy)
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const sales = await db.sales.where('timestamp').above(todayStart.toISOString()).toArray();

      let revenue = 0;
      let profit = 0;

      sales.forEach(sale => {
        revenue += Number(sale.total_amount) || 0;
        
        // Sum profit of line items
        if (Array.isArray(sale.items)) {
          sale.items.forEach(item => {
            const cost = Number(item.unit_cost) || 0;
            const price = Number(item.unit_price) || 0;
            profit += (price - cost) * (item.quantity || 1);
          });
        }
      });

      kpiRevenue.innerText = `$${revenue.toFixed(2)}`;
      kpiSales.innerText = sales.length;
      kpiProfit.innerText = `$${profit.toFixed(2)}`;

    } catch (err) {
      console.error('[App] Failed to load reports:', err);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">Failed to load reports: ${err.message}</td></tr>`;
      }
    }
  },

  // Helper to render sales logs in reports table
  renderSalesLogTable(sales) {
    const tbody = document.getElementById('report-sales-tbody');
    if (!tbody) return;

    if (!sales || sales.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center">No sales registered yet.</td>
        </tr>
      `;
      return;
    }

    let html = '';
    sales.forEach(s => {
      const date = new Date(s.timestamp).toLocaleString();
      const origin = String(s.origin || 'tienda').toUpperCase();
      const payment = s.payment_method || 'Efectivo';
      const itemsCount = s.item_count !== undefined ? s.item_count : (s.items ? s.items.length : 0);
      const total = Number(s.total_amount) || 0;
      const apt = s.delivery_apartment ? `${s.delivery_complex || ''} Apto ${s.delivery_apartment}` : 'N/A';

      html += `
        <tr>
          <td>${date}</td>
          <td><span class="origin-tag ${origin.toLowerCase()}">${origin}</span></td>
          <td>${payment}</td>
          <td class="text-center">${itemsCount}</td>
          <td class="text-right font-medium">$${total.toFixed(2)}</td>
          <td>${apt}</td>
          <td><span class="report-notes">${s.notes || ''}</span></td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
  }
};

// Bootstrap application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  App.init().catch(console.error);
});
