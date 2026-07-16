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
    this.setupInventoryScanner();
    
    const authenticated = this.checkAuthStatus();
    if (!authenticated) {
      return; // Stop initialization, wait for login
    }

    await this.bootstrapApp();
  },

  async bootstrapApp() {
    // Bootstrap other modules
    SyncEngine.init();
    POS.init();

    // Initial data load
    await this.loadInventory();
    await this.loadReports();

    // Auto-pull database on first-time load/new device
    try {
      const productCount = await db.products.count();
      if (productCount === 0 && SyncEngine.onlineStatus) {
        console.log('[App] Local database is empty. Triggering automatic cloud pull...');
        POS.showToast('Empty database detected. Syncing catalog from cloud...', 'info');
        this.handlePullFromCloud().catch(console.error);
      }
    } catch (dbErr) {
      console.warn('[App] Failed to check local db count for auto-pull:', dbErr);
    }
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
    const expensesInput = document.getElementById('file-expenses-input');

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

    if (expensesInput) {
      expensesInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await this.handleImport(file, 'expenses');
        expensesInput.value = ''; // clear
      });
    }

    const pullCloudBtn = document.getElementById('btn-pull-cloud');
    if (pullCloudBtn) {
      pullCloudBtn.addEventListener('click', () => this.handlePullFromCloud());
    }
  },

  // Core handler for importing catalog/inventory/expenses Excel files
  async handleImport(file, type) {
    const progressCard = document.getElementById('import-progress-card');
    const progressTitle = document.getElementById('progress-title');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const progressStatus = document.getElementById('progress-status');

    if (!progressCard) return;

    progressCard.classList.remove('hidden');
    progressTitle.innerText = `Parsing ${type === 'catalog' ? 'Master Catalog' : (type === 'inventory' ? 'Live Inventory' : 'Expenses Log')}...`;
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
      } else if (type === 'inventory') {
        const found = workbook.SheetNames.find(n => n.toLowerCase().includes('defin') || n.toLowerCase().includes('stock'));
        if (found) sheetName = found;
      } else if (type === 'expenses') {
        const found = workbook.SheetNames.find(n => n.toLowerCase().includes('gastos'));
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
      
      // Ensure we mapped the critical barcode/amount fields
      if (type !== 'expenses' && !mapping.barcode) {
        throw new Error(`Failed to map Barcode column. Headers found: ${headers.join(', ')}`);
      }
      if (type === 'catalog' && !mapping.product_name) {
        throw new Error('Failed to map Product Name / Description column.');
      }
      if (type === 'expenses' && (!mapping.amount || !mapping.description)) {
        throw new Error(`Failed to map Description or Amount columns for expenses. Headers found: ${headers.join(', ')}`);
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
      } else if (type === 'inventory') {
        await ExcelImporter.importProducts(rows, updateProgress);
      } else if (type === 'expenses') {
        await ExcelImporter.importExpenses(rows, updateProgress);
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

  // Pull catalog and inventory from the cloud database into IndexedDB
  async handlePullFromCloud() {
    const progressCard = document.getElementById('import-progress-card');
    const progressTitle = document.getElementById('progress-title');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const progressStatus = document.getElementById('progress-status');

    if (!progressCard) return;

    progressCard.classList.remove('hidden');
    progressTitle.innerText = 'Downloading Cloud Data...';
    progressBarFill.style.width = '0%';
    progressBarFill.style.backgroundColor = 'var(--color-primary)';
    progressStatus.innerText = 'Connecting to server...';

    const updateProgress = (text, percent) => {
      progressStatus.innerText = text;
      progressBarFill.style.width = `${percent}%`;
    };

    try {
      await this.pullFromCloud(updateProgress);
      POS.showToast('Cloud database downloaded successfully!', 'success');
      await this.loadInventory();
      // Hide progress indicator after success delay
      setTimeout(() => progressCard.classList.add('hidden'), 2000);
    } catch (err) {
      console.error(err);
      updateProgress(`Error: ${err.message}`, 100);
      progressBarFill.style.backgroundColor = 'var(--color-danger)';
      POS.showToast('Cloud pull failed: ' + err.message, 'error');
    }
  },

  async pullFromCloud(progressCallback) {
    if (!SyncEngine.onlineStatus) {
      throw new Error('System is offline. Cannot connect to the cloud server.');
    }

    if (progressCallback) progressCallback('Fetching Master Catalog from cloud...', 15);
    const catalogRes = await api.getCatalog();
    const catalogRows = catalogRes.data || [];

    if (progressCallback) progressCallback(`Saving ${catalogRows.length} catalog items locally...`, 40);
    // Bulk put catalog into Dexie
    if (catalogRows.length > 0) {
      await db.transaction('rw', db.master_catalog, async () => {
        await db.master_catalog.clear();
        await db.master_catalog.bulkPut(catalogRows);
      });
    }

    if (progressCallback) progressCallback('Fetching Live Inventory from cloud...', 60);
    const productsRes = await api.getProducts();
    const productsRows = productsRes.data || [];

    if (progressCallback) progressCallback(`Saving ${productsRows.length} product records locally...`, 80);
    if (productsRows.length > 0) {
      await db.transaction('rw', db.products, db.master_catalog, async () => {
        await db.products.clear();
        
        // Map products response to local schema and fill catalog if missing
        const productsToPut = [];
        const missingCatalogEntries = [];
        
        for (const p of productsRows) {
          productsToPut.push({
            barcode: p.barcode,
            supplier: p.supplier || 'Unknown',
            cost_price: Number(p.cost_price) || 0,
            sale_price: Number(p.sale_price) || 0,
            rappi_price: Number(p.rappi_price) || Number(p.sale_price) || 0,
            stock: parseInt(p.stock) || 0,
            updated_at: p.updated_at || new Date().toISOString()
          });

          // Check if catalog has it
          const exists = await db.master_catalog.get(p.barcode);
          if (!exists) {
            missingCatalogEntries.push({
              barcode: p.barcode,
              product_name: p.product_name || 'Product ' + p.barcode,
              category: p.category || 'General'
            });
          }
        }

        if (missingCatalogEntries.length > 0) {
          await db.master_catalog.bulkPut(missingCatalogEntries);
        }
        await db.products.bulkPut(productsToPut);
      });
    }

    if (progressCallback) progressCallback('Cloud synchronization complete ✓', 100);
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
            <td colspan="9" class="text-center" style="padding: 40px 0;">
              No products found. 
              <button class="btn-primary" onclick="App.handlePullFromCloud()" style="display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; margin-left: 8px; cursor: pointer; height: auto; border: none; border-radius: 4px; font-weight: 500;">
                <span class="material-icons-outlined" style="font-size: 16px;">cloud_download</span>
                <span>Pull from Cloud</span>
              </button>
              or go to the <strong>Excel Importer</strong>.
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
        const stockClass = stock <= 0 ? 'negative' : 'positive';

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
            <td class="text-center">
              <button class="btn-icon" onclick="App.openAdjustmentModal('${p.barcode}')" style="color: var(--color-primary); cursor: pointer;">
                <span class="material-icons-outlined">edit</span>
              </button>
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
    const expensesTbody = document.getElementById('report-expenses-tbody');
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
        const salesRes = await api.fetchWithAuth('/api/sales?limit=15');
        if (salesRes.ok) {
          const salesData = await salesRes.json();
          this.renderSalesLogTable(salesData.data);
        }

        // Fetch recent expenses log from server
        try {
          const expensesData = await api.getExpenses(15);
          if (expensesData && expensesData.data) {
            this.renderExpensesLogTable(expensesData.data);
          }
        } catch (expErr) {
          console.warn('[App] Failed to load expenses from server:', expErr);
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

        const localExpenses = await db.expenses.orderBy('timestamp').reverse().limit(15).toArray();
        this.renderExpensesLogTable(localExpenses);

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
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">Failed to load reports: ${err.message}</td></tr>`;
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
          <td colspan="8" class="text-center">No sales registered yet.</td>
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
      
      const serverId = s.id || 'null';
      const localId = s.local_id || 'null';

      html += `
        <tr>
          <td>${date}</td>
          <td><span class="origin-tag ${origin.toLowerCase()}">${origin}</span></td>
          <td>${payment}</td>
          <td class="text-center">${itemsCount}</td>
          <td class="text-right font-medium">$${total.toFixed(2)}</td>
          <td>${apt}</td>
          <td><span class="report-notes">${s.notes || ''}</span></td>
          <td class="text-center">
            <button class="btn-icon delete" onclick="App.deleteSale(${serverId}, ${localId})">
              <span class="material-icons-outlined">delete_outline</span>
            </button>
          </td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
  },

  // Void / delete a completed sale
  async deleteSale(serverId, localId) {
    console.log('[App] deleteSale invoked:', { serverId, localId });
    
    const confirmed = await this.showConfirm('Are you absolutely sure you want to void this sale? This will permanently delete the transaction and return the items back to inventory stock.', 'Void Sale');
    if (!confirmed) {
      console.log('[App] deleteSale cancelled by user');
      return;
    }

    try {
      // 1. If online and has a server ID, delete from PostgreSQL database first
      if (SyncEngine.onlineStatus && serverId) {
        const res = await api.fetchWithAuth(`/api/sales/${serverId}`, { method: 'DELETE' });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to delete sale from server');
        }
      }

      // 2. Fetch the sale details from local Dexie to know what to restock
      if (localId) {
        const sale = await db.sales.get(localId);
        if (sale) {
          await db.transaction('rw', db.sales, db.products, async () => {
            // Return items back to local stock
            if (Array.isArray(sale.items)) {
              for (const item of sale.items) {
                const product = await db.products.get(item.barcode);
                if (product) {
                  const currentStock = parseInt(product.stock) || 0;
                  await db.products.update(item.barcode, { stock: currentStock + item.quantity });
                }
              }
            }
            // Delete from local IndexedDB
            await db.sales.delete(localId);
          });
        }
      }

      POS.showToast('Sale voided and stock restored!', 'success');
      
      // 3. Reload views
      await this.loadInventory();
      await this.loadReports();

    } catch (err) {
      console.error('[App] Failed to delete sale:', err);
      POS.showToast(err.message, 'error');
    }
  },

  // Custom confirm dialog helper returning a Promise
  async showConfirm(message, acceptText = 'Confirm') {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirm-modal');
      const msgEl = document.getElementById('confirm-modal-message');
      const cancelBtn = document.getElementById('confirm-modal-cancel');
      const acceptBtn = document.getElementById('confirm-modal-accept');

      if (!modal) {
        resolve(confirm(message));
        return;
      }

      if (message) msgEl.innerText = message;
      if (acceptBtn) acceptBtn.innerText = acceptText;
      modal.classList.remove('hidden');

      const cleanup = (result) => {
        modal.classList.add('hidden');
        // Clone elements to remove all attached listeners
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
        acceptBtn.replaceWith(acceptBtn.cloneNode(true));
        resolve(result);
      };

      document.getElementById('confirm-modal-cancel').addEventListener('click', () => cleanup(false));
      document.getElementById('confirm-modal-accept').addEventListener('click', () => cleanup(true));
    });
  },

  // Scanner form inside Inventory Stock tab
  setupInventoryScanner() {
    const scanForm = document.getElementById('inventory-scan-form');
    const scanInput = document.getElementById('inventory-scan-input');
    if (!scanForm || !scanInput) return;

    scanForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const barcode = dbHelper.normalizeBarcode(scanInput.value);
      if (!barcode) return;

      scanInput.value = '';
      scanInput.blur();
      
      const product = await db.products.get(barcode);
      if (product) {
        this.openAdjustmentModal(barcode);
      } else {
        this.openNewProductModal(barcode);
      }
    });
  },

  // Open modal in registration mode
  openNewProductModal(prefilledBarcode = '') {
    const modal = document.getElementById('inventory-modal');
    if (!modal) return;

    const barcode = dbHelper.normalizeBarcode(prefilledBarcode);

    document.getElementById('inventory-modal-title').innerText = 'Register New Product';
    document.getElementById('inventory-modal-icon').className = 'material-icons-outlined modal-icon text-success';
    
    // Hide Delete button in registration mode
    const deleteBtn = document.getElementById('inv-modal-delete');
    if (deleteBtn) deleteBtn.style.display = 'none';

    const barcodeInput = document.getElementById('inv-modal-barcode');
    barcodeInput.value = barcode;
    barcodeInput.removeAttribute('readonly');
    barcodeInput.style.backgroundColor = '';
    barcodeInput.style.color = '';

    document.getElementById('inv-modal-name').value = '';
    document.getElementById('inv-modal-category').value = '';
    document.getElementById('inv-modal-supplier').value = '';
    document.getElementById('inv-modal-cost').value = '';
    document.getElementById('inv-modal-retail').value = '';
    document.getElementById('inv-modal-rappi').value = '';
    document.getElementById('inv-modal-stock').value = '0';
    document.getElementById('inv-modal-adjust').value = '0';
    document.getElementById('inv-modal-adjust').placeholder = 'Initial stock level';

    modal.classList.remove('hidden');
    if (barcode) {
      document.getElementById('inv-modal-name').focus();
    } else {
      barcodeInput.focus();
    }
  },

  // Open modal in edit/adjustment mode
  async openAdjustmentModal(barcode) {
    const modal = document.getElementById('inventory-modal');
    if (!modal) return;

    barcode = dbHelper.normalizeBarcode(barcode);
    const product = await db.products.get(barcode);
    const catalog = await db.master_catalog.get(barcode);

    if (!product) {
      this.openNewProductModal(barcode);
      return;
    }

    document.getElementById('inventory-modal-title').innerText = 'Adjust Product Details';
    document.getElementById('inventory-modal-icon').className = 'material-icons-outlined modal-icon text-primary';

    // Show Delete button in edit mode
    const deleteBtn = document.getElementById('inv-modal-delete');
    if (deleteBtn) deleteBtn.style.display = 'block';

    const barcodeInput = document.getElementById('inv-modal-barcode');
    barcodeInput.value = barcode;
    barcodeInput.setAttribute('readonly', 'true');
    barcodeInput.style.backgroundColor = 'var(--border-color)';
    barcodeInput.style.color = 'var(--text-muted)';

    document.getElementById('inv-modal-name').value = catalog ? catalog.product_name : '';
    document.getElementById('inv-modal-category').value = catalog ? catalog.category : '';
    document.getElementById('inv-modal-supplier').value = product.supplier || '';
    document.getElementById('inv-modal-cost').value = product.cost_price || 0;
    document.getElementById('inv-modal-retail').value = product.sale_price || 0;
    document.getElementById('inv-modal-rappi').value = product.rappi_price || 0;
    document.getElementById('inv-modal-stock').value = product.stock || 0;
    document.getElementById('inv-modal-adjust').value = '0';
    document.getElementById('inv-modal-adjust').placeholder = 'e.g. 10 or -5';

    modal.classList.remove('hidden');
    document.getElementById('inv-modal-adjust').focus();
  },

  closeInventoryModal() {
    const modal = document.getElementById('inventory-modal');
    if (modal) modal.classList.add('hidden');
  },

  // Form submission: save to Dexie and sync to Postgres
  async saveAdjustment(event) {
    event.preventDefault();

    const barcode = dbHelper.normalizeBarcode(document.getElementById('inv-modal-barcode').value);
    const name = document.getElementById('inv-modal-name').value.trim();
    const category = document.getElementById('inv-modal-category').value.trim();
    const supplier = document.getElementById('inv-modal-supplier').value.trim() || 'Unknown';
    
    const costPrice = parseFloat(document.getElementById('inv-modal-cost').value) || 0;
    const salePrice = parseFloat(document.getElementById('inv-modal-retail').value) || 0;
    const rappiPrice = parseFloat(document.getElementById('inv-modal-rappi').value) || salePrice;
    
    const currentStock = parseInt(document.getElementById('inv-modal-stock').value) || 0;
    const adjustQty = parseInt(document.getElementById('inv-modal-adjust').value) || 0;
    
    const isNew = !document.getElementById('inv-modal-barcode').hasAttribute('readonly');
    const finalStock = Math.max(0, isNew ? adjustQty : (currentStock + adjustQty));

    const catalogRecord = {
      barcode,
      product_name: name,
      category
    };

    const productRecord = {
      barcode,
      supplier,
      cost_price: costPrice,
      sale_price: salePrice,
      rappi_price: rappiPrice,
      stock: finalStock,
      updated_at: new Date().toISOString()
    };

    try {
      // 1. Save locally to Dexie (transactional)
      await db.transaction('rw', db.master_catalog, db.products, async () => {
        await db.master_catalog.put(catalogRecord);
        await db.products.put(productRecord);
      });

      console.log(`[Inventory] Manually saved barcode: ${barcode} in Dexie.`);

      // 2. Post to server PostgreSQL database (optional sync now, otherwise background sync handles it)
      if (SyncEngine.onlineStatus) {
        try {
          await api.importCatalogBulk([catalogRecord]);
          await api.importProductsBulk([productRecord]);
          console.log(`[Inventory] Successfully pushed updates for barcode: ${barcode} to PostgreSQL server.`);
        } catch (serverErr) {
          console.warn('[Inventory] Direct server sync failed, relying on background queue:', serverErr);
        }
      }

      POS.showToast('Product saved successfully!', 'success');
      this.closeInventoryModal();
      
      // 3. Refresh Inventory Table View
      await this.loadInventory();

    } catch (err) {
      console.error('[Inventory] Failed to save product:', err);
      POS.showToast('Failed to save product: ' + err.message, 'error');
    }
  },

  // Delete current product in inventory modal
  async deleteProductCurrent() {
    const barcodeInput = document.getElementById('inv-modal-barcode');
    if (!barcodeInput) return;
    const barcode = dbHelper.normalizeBarcode(barcodeInput.value);
    if (!barcode) return;

    const confirmed = await this.showConfirm('Are you absolutely sure you want to delete this product? This will permanently remove it from the catalog and inventory.', 'Delete Product');
    if (!confirmed) return;

    try {
      if (SyncEngine.onlineStatus) {
        // Call server route to delete from Postgres (cascading)
        await api.deleteProduct(barcode);
      } else {
        POS.showToast('Deleting offline. Note: product will reappear if synced or pulled from cloud later.', 'warning');
      }

      // Delete locally from Dexie
      await db.transaction('rw', db.master_catalog, db.products, async () => {
        await db.master_catalog.delete(barcode);
        await db.products.delete(barcode);
      });

      POS.showToast('Product deleted successfully!', 'success');
      this.closeInventoryModal();
      await this.loadInventory();

    } catch (err) {
      console.error('[Inventory] Failed to delete product:', err);
      POS.showToast('Failed to delete product: ' + err.message, 'error');
    }
  },

  // Auth Check on Startup
  checkAuthStatus() {
    const token = localStorage.getItem('pos_auth_token');
    const modal = document.getElementById('login-modal');
    if (!token) {
      if (modal) {
        modal.classList.remove('hidden');
        setTimeout(() => document.getElementById('login-password').focus(), 100);
      }
      return false;
    }
    if (modal) modal.classList.add('hidden');
    return true;
  },

  // Shows login screen (triggered on 401 Unauthorized API error)
  showLogin() {
    const modal = document.getElementById('login-modal');
    if (modal) {
      modal.classList.remove('hidden');
      document.getElementById('login-password').value = '';
      setTimeout(() => document.getElementById('login-password').focus(), 100);
    }
  },

  // Handle verification form submit
  async handleLoginSubmit(event) {
    event.preventDefault();
    const passwordInput = document.getElementById('login-password');
    const password = passwordInput.value.trim();
    if (!password) return;

    try {
      let token;
      // If we are online, verify with server. Otherwise, verify with local hash.
      if (SyncEngine.onlineStatus) {
        const res = await api.verifyPassword(password);
        token = res.token;
        localStorage.setItem('pos_offline_hash', btoa(password));
      } else {
        const offlineHash = localStorage.getItem('pos_offline_hash');
        if (offlineHash && btoa(password) === offlineHash) {
          token = offlineHash;
        } else {
          throw new Error('Invalid password (offline mode)');
        }
      }

      localStorage.setItem('pos_auth_token', token);
      document.getElementById('login-modal').classList.add('hidden');
      POS.showToast('System unlocked!', 'success');
      
      await this.bootstrapApp();

    } catch (err) {
      console.error('[Auth] Verification failed:', err);
      POS.showToast('Invalid password. Access denied.', 'error');
      passwordInput.value = '';
      passwordInput.focus();
    }
  },

  // Open manual expense creation modal
  openExpenseModal() {
    const modal = document.getElementById('expense-modal');
    if (!modal) return;
    
    // Reset form fields
    document.getElementById('expense-form').reset();
    
    // Set date field to local current time
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    document.getElementById('expense-date').value = `${year}-${month}-${day}T${hours}:${minutes}`;

    modal.classList.remove('hidden');
  },

  // Close manual expense modal
  closeExpenseModal() {
    const modal = document.getElementById('expense-modal');
    if (modal) modal.classList.add('hidden');
  },

  // Handle manual expense form submission
  async handleExpenseSubmit(event) {
    event.preventDefault();
    const dateVal = document.getElementById('expense-date').value;
    const amountVal = document.getElementById('expense-amount').value;
    const descriptionVal = document.getElementById('expense-description').value.trim();
    const categoryVal = document.getElementById('expense-category').value.trim();
    const paymentVal = document.getElementById('expense-payment').value;
    const notesVal = document.getElementById('expense-notes').value.trim();

    if (!dateVal || !amountVal || !descriptionVal || !categoryVal) {
      POS.showToast('Please fill out all required fields.', 'error');
      return;
    }

    const expenseRecord = {
      timestamp: new Date(dateVal).toISOString(),
      amount: parseFloat(amountVal),
      description: descriptionVal,
      category: categoryVal,
      payment_method: paymentVal,
      notes: notesVal || null
    };

    try {
      // 1. Save locally to Dexie (marked as unsynced first)
      let localId;
      await db.transaction('rw', db.expenses, async () => {
        localId = await db.expenses.add({ ...expenseRecord, synced: 0 });
      });

      console.log(`[Expense] Saved locally with localId: ${localId}`);

      // 2. If online, attempt to push directly to PostgreSQL
      if (SyncEngine.onlineStatus) {
        try {
          await api.addExpense(expenseRecord);
          // Mark as synced locally
          await db.expenses.update(localId, { synced: 1 });
          console.log(`[Expense] Pushed and synced localId: ${localId} to server.`);
        } catch (serverErr) {
          console.warn('[Expense] Failed to push directly to server, will sync in background:', serverErr);
        }
      }

      POS.showToast('Expense recorded successfully!', 'success');
      this.closeExpenseModal();

      // 3. Reload reports view
      await this.loadReports();

    } catch (err) {
      console.error('[Expense] Failed to save expense:', err);
      POS.showToast('Failed to save expense: ' + err.message, 'error');
    }
  },

  // Render recent expenses log
  renderExpensesLogTable(expenses) {
    const tbody = document.getElementById('report-expenses-tbody');
    if (!tbody) return;

    if (!expenses || expenses.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No expenses recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = expenses.map(exp => {
      const dateStr = new Date(exp.timestamp).toLocaleString();
      const amountStr = Number(exp.amount).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
      const idVal = exp.id || `local_${exp.local_id}`;

      return `
        <tr>
          <td>${dateStr}</td>
          <td>${exp.description}</td>
          <td><span class="badge badge-normal">${exp.category}</span></td>
          <td>${exp.payment_method}</td>
          <td class="text-right text-danger font-semibold">-${amountStr}</td>
          <td class="text-muted" style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${exp.notes || ''}
          </td>
          <td class="text-center">
            <button class="btn-void" onclick="App.deleteExpenseTrigger('${idVal}', ${exp.local_id || 'null'})" title="Delete Expense">
              <span class="material-icons-outlined">delete</span>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  },

  // Trigger voiding/deleting an expense entry
  async deleteExpenseTrigger(idVal, localId) {
    const confirmed = await this.showConfirm('Are you absolutely sure you want to delete this expense entry? This action is permanent.');
    if (!confirmed) return;

    try {
      // 1. If it has a database ID (numeric), delete from PostgreSQL
      if (SyncEngine.onlineStatus && !String(idVal).startsWith('local_')) {
        await api.deleteExpense(idVal);
        console.log(`[Expense] Deleted expense ID ${idVal} from server.`);
      }

      // 2. Delete locally from Dexie
      if (localId) {
        await db.expenses.delete(localId);
      } else if (String(idVal).startsWith('local_')) {
        const parsedLocalId = parseInt(idVal.split('_')[1]);
        if (!isNaN(parsedLocalId)) {
          await db.expenses.delete(parsedLocalId);
        }
      }

      POS.showToast('Expense entry deleted successfully.', 'success');
      await this.loadReports();

    } catch (err) {
      console.error('[Expense] Failed to delete expense:', err);
      POS.showToast('Failed to delete expense: ' + err.message, 'error');
    }
  }
};

// Bootstrap application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  App.init().catch(console.error);
});
