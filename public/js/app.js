/**
 * Main Application View Controller & Router
 * 
 * Orchestrates navigation tabs, bootstraps modules, manages searching,
 * Excel imports UI bindings, and analytics logs renderings.
 */

const App = {
  activeTab: 'tab-pos',

  async init() {
    this.setupTheme();
    this.setupRouter();
    this.setupImporterUI();
    this.setupSearch();
    this.setupInventoryScanner();
    this.setupModals();
    
    const authenticated = this.checkAuthStatus();
    if (!authenticated) {
      return; // Stop initialization, wait for login
    }

    await this.bootstrapApp();
  },

  async bootstrapApp() {
    // One-time startup migration to normalize existing local barcodes
    try {
      await dbHelper.migrateLocalBarcodes();
    } catch (migErr) {
      console.warn('[App] Local barcode migration failed:', migErr);
    }

    // Initialize device ID settings
    if (!localStorage.getItem('pos_device_id')) {
      localStorage.setItem('pos_device_id', '1');
    }
    const deviceIdInput = document.getElementById('settings-device-id');
    if (deviceIdInput) {
      deviceIdInput.value = localStorage.getItem('pos_device_id') || '1';
      deviceIdInput.addEventListener('change', (e) => {
        let val = parseInt(e.target.value) || 1;
        if (val < 1) val = 1;
        if (val > 99) val = 99;
        e.target.value = val;
        localStorage.setItem('pos_device_id', String(val));
        POS.showToast(`Device ID updated to ${val}`, 'success');
      });
    }

    // Run backfill for old invoice numbers
    try {
      await dbHelper.backfillInvoiceNumbers();
    } catch (bfErr) {
      console.warn('[App] Invoice backfill failed:', bfErr);
    }

    // Bootstrap other modules
    SyncEngine.init();
    POS.init();

    // Trigger sync to push backfilled invoices
    SyncEngine.runSync().catch(console.error);

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

  // Setup 3-state theme switching (Dark, Light, System)
  setupTheme() {
    const savedTheme = localStorage.getItem('pos_theme') || 'system';
    this.updateThemeIcon(savedTheme);

    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        const currentTheme = localStorage.getItem('pos_theme') || 'system';
        let nextTheme = 'dark';
        if (currentTheme === 'dark') {
          nextTheme = 'light';
        } else if (currentTheme === 'light') {
          nextTheme = 'system';
        } else {
          nextTheme = 'dark';
        }
        
        localStorage.setItem('pos_theme', nextTheme);
        document.documentElement.setAttribute('data-theme', nextTheme);
        this.updateThemeIcon(nextTheme);
      });
    }
  },

  updateThemeIcon(theme) {
    const iconEl = document.getElementById('theme-toggle-icon');
    const btnEl = document.getElementById('theme-toggle-btn');
    if (!iconEl) return;
    
    if (theme === 'light') {
      iconEl.innerText = 'light_mode';
      if (btnEl) btnEl.title = 'Theme: Light';
    } else if (theme === 'dark') {
      iconEl.innerText = 'dark_mode';
      if (btnEl) btnEl.title = 'Theme: Dark';
    } else {
      iconEl.innerText = 'brightness_auto';
      if (btnEl) btnEl.title = 'Theme: System';
    }
  },

  // Setup tab routing
  setupRouter() {
    const navButtons = document.querySelectorAll('.nav-btn');
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        this.switchTab(targetTab);
      });
    });

    // Restore saved tab on load
    const savedTab = localStorage.getItem('pos_active_tab') || 'tab-pos';
    this.switchTab(savedTab);

    // Sidebar Toggler Button
    const btnToggle = document.getElementById('btn-toggle-sidebar');
    const sidebar = document.getElementById('app-sidebar');
    if (btnToggle && sidebar) {
      // Load saved collapse status
      const isCollapsed = localStorage.getItem('pos_sidebar_collapsed') === 'true';
      if (isCollapsed) {
        sidebar.classList.add('collapsed');
      }

      btnToggle.addEventListener('click', () => {
        const collapsed = sidebar.classList.toggle('collapsed');
        localStorage.setItem('pos_sidebar_collapsed', String(collapsed));
      });
    }

    // Brand Logo Click handler: expand sidebar and switch to home (POS Checkout)
    const brandLogo = document.querySelector('.header-logo');
    if (brandLogo) {
      brandLogo.addEventListener('click', () => {
        // Expand sidebar if it was collapsed
        if (sidebar && sidebar.classList.contains('collapsed')) {
          sidebar.classList.remove('collapsed');
          localStorage.setItem('pos_sidebar_collapsed', 'false');
        }
        // Switch to POS Checkout (Home view)
        this.switchTab('tab-pos');
      });
    }
  },

  switchTab(targetTab) {
    const navButtons = document.querySelectorAll('.nav-btn');
    const btn = Array.from(navButtons).find(b => b.getAttribute('data-tab') === targetTab);
    if (!btn) return;

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
    localStorage.setItem('pos_active_tab', targetTab);
    
    // Trigger tab specific loads
    if (targetTab === 'tab-inventory') {
      this.loadInventory();
    } else if (targetTab === 'tab-reports') {
      this.loadReports();
    } else if (targetTab === 'tab-purchases') {
      this.loadPurchases();
    }
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

    const purchasesInput = document.getElementById('file-purchases-input');
    if (purchasesInput) {
      purchasesInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await this.handleImport(file, 'purchases');
        purchasesInput.value = ''; // clear
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
    progressTitle.innerText = `Parsing ${type === 'catalog' ? 'Master Catalog' : (type === 'inventory' ? 'Live Inventory' : (type === 'purchases' ? 'Purchases Log' : 'Expenses Log'))}...`;
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
      } else if (type === 'purchases') {
        const found = workbook.SheetNames.find(n => n.toLowerCase().includes('compra'));
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
      } else if (type === 'purchases') {
        await ExcelImporter.importPurchases(rows, updateProgress);
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
            expiration_date: p.expiration_date || null,
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
      // 1. Populate category filter dropdown dynamically
      const categorySelect = document.getElementById('inventory-category-select');
      if (categorySelect && !categorySelect.dataset.populated) {
        const allCatalog = await db.master_catalog.toArray();
        const categories = [...new Set(allCatalog.map(c => c.category).filter(Boolean))].sort();
        
        const currentValue = categorySelect.value;
        categorySelect.innerHTML = '<option value="">All Categories</option>' +
          categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
        categorySelect.value = currentValue;
        
        categorySelect.dataset.populated = 'true';
      }

      const products = await db.products.toArray();
      
      if (products.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="11" class="text-center" style="padding: 40px 0;">
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

      // Read filters
      const selectedCat = categorySelect ? categorySelect.value : '';
      const searchInput = document.getElementById('inventory-search-input');
      const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';

      let html = '';
      for (const p of products) {
        const cat = await db.master_catalog.get(p.barcode);
        const name = cat ? cat.product_name : 'Unknown Product';
        const category = cat ? cat.category : 'General';
        
        // Apply category filter
        if (selectedCat && category !== selectedCat) continue;
        
        // Apply search query filter
        const supplier = p.supplier || '';
        const barcode = p.barcode || '';
        if (searchQuery && 
            !name.toLowerCase().includes(searchQuery) && 
            !barcode.toLowerCase().includes(searchQuery) && 
            !supplier.toLowerCase().includes(searchQuery) && 
            !category.toLowerCase().includes(searchQuery)) {
          continue;
        }

        const stock = parseInt(p.stock) || 0;
        const stockClass = stock <= 0 ? 'negative' : 'positive';

        const dateStr = p.updated_at ? new Date(p.updated_at).toLocaleString('es-CO', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }) : 'N/A';

        // Expiration date tracking
        let expStr = 'N/A';
        let expStyle = '';
        if (p.expiration_date) {
          const expDate = new Date(p.expiration_date + 'T00:00:00');
          expStr = expDate.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
          
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const timeDiff = expDate.getTime() - today.getTime();
          const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
          
          if (daysDiff < 0) {
            expStr += ' (VENCIDO)';
            expStyle = 'color: var(--color-danger); font-weight: bold;';
          } else if (daysDiff <= 30) {
            expStr += ` (Vence ${daysDiff}d)`;
            expStyle = 'color: #f59e0b; font-weight: bold;';
          }
        }

        html += `
          <tr>
            <td class="font-medium">${p.barcode}</td>
            <td>${name}</td>
            <td><span class="category-tag">${category}</span></td>
            <td>${p.supplier || 'N/A'}</td>
            <td class="text-right">${dbHelper.formatCOP(p.cost_price)}</td>
            <td class="text-right">${dbHelper.formatCOP(p.sale_price)}</td>
            <td class="text-right">${dbHelper.formatCOP(p.rappi_price)}</td>
            <td class="text-center">
              <span class="stock-pill ${stockClass}">${stock} units</span>
            </td>
            <td class="text-center" style="${expStyle}">${expStr}</td>
            <td class="text-center text-muted" style="font-size: 13px;">${dateStr}</td>
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

  // Setup search filter and category filter for inventory table
  setupSearch() {
    const searchInput = document.getElementById('inventory-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', () => this.loadInventory());
    }

    const categorySelect = document.getElementById('inventory-category-select');
    if (categorySelect) {
      categorySelect.addEventListener('change', () => this.loadInventory());
    }

    const purSearchInput = document.getElementById('purchase-search-input');
    if (purSearchInput) {
      purSearchInput.addEventListener('input', () => this.loadPurchases());
    }

    // Purchases Log Filters
    const purFromInput = document.getElementById('purchase-filter-from');
    if (purFromInput) {
      purFromInput.addEventListener('change', () => this.loadPurchases());
    }

    const purToInput = document.getElementById('purchase-filter-to');
    if (purToInput) {
      purToInput.addEventListener('change', () => this.loadPurchases());
    }

    const purSupplierSelect = document.getElementById('purchase-supplier-select');
    if (purSupplierSelect) {
      purSupplierSelect.addEventListener('change', () => this.loadPurchases());
    }

    const purCategorySelect = document.getElementById('purchase-category-select');
    if (purCategorySelect) {
      purCategorySelect.addEventListener('change', () => this.loadPurchases());
    }
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
      // 1. Populate category filter dropdown dynamically
      const salesCategorySelect = document.getElementById('sales-filter-category');
      if (salesCategorySelect && !salesCategorySelect.dataset.populated) {
        const allCatalog = await db.master_catalog.toArray();
        const categories = [...new Set(allCatalog.map(c => c.category).filter(Boolean))].sort();
        
        const currentValue = salesCategorySelect.value;
        salesCategorySelect.innerHTML = '<option value="">Todas</option>' +
          categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
        salesCategorySelect.value = currentValue;
        
        salesCategorySelect.dataset.populated = 'true';
      }

      // Read filter values
      const dateFrom = document.getElementById('sales-filter-from')?.value || '';
      const dateTo = document.getElementById('sales-filter-to')?.value || '';
      const selectedCategory = salesCategorySelect ? salesCategorySelect.value : '';
      const limitEl = document.getElementById('sales-filter-limit');
      const limitVal = Number(limitEl ? limitEl.value : 50);

      // Fetch category mapping for client-side filtering and KPI calculations
      const allCatalog = await db.master_catalog.toArray();
      const barcodeToCategory = {};
      allCatalog.forEach(c => {
        barcodeToCategory[c.barcode] = c.category;
      });

      const res = await api.checkHealth();

      if (res) {
        // If server is online, fetch sales logs and metadata
        let url = `/api/sales?limit=${limitVal}`;
        if (dateFrom) url += `&from=${dateFrom}`;
        if (dateTo) url += `&to=${dateTo}`;
        if (selectedCategory) url += `&category=${encodeURIComponent(selectedCategory)}`;

        const salesRes = await api.fetchWithAuth(url);
        if (salesRes.ok) {
          const salesData = await salesRes.json();
          this.renderSalesLogTable(salesData.data);
        }

        // Fetch recent expenses log from server
        try {
          const expensesData = await api.getExpenses(limitVal);
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
        let localSales = await db.sales.orderBy('timestamp').reverse().toArray();
        localSales = localSales.filter(s => {
          if (dateFrom && s.timestamp < dateFrom) return false;
          if (dateTo && s.timestamp > dateTo + 'T23:59:59') return false;
          if (selectedCategory) {
            const hasCategoryItem = Array.isArray(s.items) && s.items.some(item => {
              const cat = barcodeToCategory[item.barcode];
              return cat === selectedCategory;
            });
            if (!hasCategoryItem) return false;
          }
          return true;
        });

        this.renderSalesLogTable(localSales.slice(0, limitVal));

        let localExpenses = await db.expenses.orderBy('timestamp').reverse().toArray();
        localExpenses = localExpenses.filter(e => {
          if (dateFrom && e.timestamp < dateFrom) return false;
          if (dateTo && e.timestamp > dateTo + 'T23:59:59') return false;
          return true;
        });

        this.renderExpensesLogTable(localExpenses.slice(0, limitVal));

        serverSalesCount.innerText = 'Offline';
        lastSyncTime.innerText = 'Offline';
      }

      // 2. Calculate KPIs locally from Dexie based on selected filters (or fallback to today)
      let kpiSalesList = await db.sales.toArray();
      
      // Apply filters for KPIs
      kpiSalesList = kpiSalesList.filter(s => {
        if (dateFrom) {
          if (s.timestamp < dateFrom) return false;
        } else {
          // If no "desde" is specified, default to today for KPIs (original behavior)
          const todayStartStr = new Date();
          todayStartStr.setHours(0, 0, 0, 0);
          if (s.timestamp < todayStartStr.toISOString()) return false;
        }
        
        if (dateTo) {
          if (s.timestamp > dateTo + 'T23:59:59') return false;
        }
        
        if (selectedCategory) {
          const hasCategoryItem = Array.isArray(s.items) && s.items.some(item => {
            const cat = barcodeToCategory[item.barcode];
            return cat === selectedCategory;
          });
          if (!hasCategoryItem) return false;
        }
        return true;
      });

      let revenue = 0;
      let profit = 0;

      kpiSalesList.forEach(sale => {
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

      kpiRevenue.innerText = dbHelper.formatCOP(revenue);
      kpiSales.innerText = kpiSalesList.length;
      kpiProfit.innerText = dbHelper.formatCOP(profit);

      // Update KPI card headers dynamically
      const isFiltered = dateFrom || dateTo || selectedCategory;
      const labelPrefix = isFiltered ? "Period's" : "Today's";
      
      const reportsTab = document.getElementById('tab-reports');
      const revSpan = reportsTab ? reportsTab.querySelector('.kpi-card:nth-child(1) .kpi-details span') : null;
      const salesSpan = reportsTab ? reportsTab.querySelector('.kpi-card:nth-child(2) .kpi-details span') : null;
      const profitSpan = reportsTab ? reportsTab.querySelector('.kpi-card:nth-child(3) .kpi-details span') : null;
      
      if (revSpan) revSpan.innerText = `${labelPrefix} Revenue`;
      if (salesSpan) salesSpan.innerText = `${labelPrefix} Transactions`;
      if (profitSpan) profitSpan.innerText = `${labelPrefix} Estimated Profit`;

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
      const saleType = s.sale_type || 'Venta Comercial';
      const itemsCount = s.item_count !== undefined ? s.item_count : (s.items ? s.items.length : 0);
      const total = Number(s.total_amount) || 0;
      const apt = s.delivery_apartment ? `${s.delivery_complex || ''} Apto ${s.delivery_apartment}` : 'N/A';
      
      const serverId = s.id || 'null';
      const localId = s.local_id || 'null';

      html += `
        <tr id="sale-row-${serverId || localId}" class="sale-row-clickable" onclick="App.handleSaleRowClick(event, ${serverId}, ${localId})">
          <td>
            <strong style="color: var(--text-main); font-size: 13px;">${s.invoice_number || `#L-${localId}`}</strong>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${date}</div>
          </td>
          <td><span class="origin-tag ${origin.toLowerCase()}">${origin}</span></td>
          <td>${payment}</td>
          <td class="text-center"><span class="sale-type-tag">${saleType}</span></td>
          <td class="text-center">${itemsCount}</td>
          <td class="text-right font-medium">${dbHelper.formatCOP(total)}</td>
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

  handleSaleRowClick(event, serverId, localId) {
    // If they clicked the delete button or delete icon, don't toggle
    if (event.target.closest('.delete')) {
      return;
    }
    this.toggleSaleDetails(serverId, localId);
  },

  async toggleSaleDetails(serverId, localId) {
    const mainRow = document.getElementById(`sale-row-${serverId || localId}`);
    if (!mainRow) return;

    const existingDetails = document.getElementById(`details-row-${serverId || localId}`);
    if (existingDetails) {
      existingDetails.remove();
      mainRow.classList.remove('expanded');
      return;
    }

    // Show a small loading indicator
    mainRow.classList.add('expanded');
    const loadingRow = document.createElement('tr');
    loadingRow.id = `details-row-${serverId || localId}`;
    loadingRow.className = 'details-row';
    loadingRow.innerHTML = `
      <td colspan="9" style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 12px;">
        <span class="material-icons-outlined spinner" style="vertical-align: middle; font-size: 16px; margin-right: 6px;">sync</span> Cargando productos...
      </td>
    `;
    mainRow.parentNode.insertBefore(loadingRow, mainRow.nextSibling);

    let items = [];
    try {
      // 1. Try to fetch from server if online and serverId is valid
      const online = await api.checkHealth();
      if (online && serverId && serverId !== 'null' && serverId !== 'undefined') {
        const res = await api.fetchWithAuth(`/api/sales/${serverId}`);
        if (res.ok) {
          const body = await res.json();
          if (body && body.data) {
            items = body.data.items || [];
          }
        }
      } else {
        // 2. Fallback to local Dexie
        const localSale = await db.sales.get(Number(localId));
        if (localSale) {
          items = localSale.items || [];
        }
      }
    } catch (err) {
      console.warn('[App] Failed to fetch sale details:', err);
    }

    // Render items
    if (items.length === 0) {
      loadingRow.innerHTML = `
        <td colspan="9" style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 12px;">
          No se pudieron cargar los detalles del pedido.
        </td>
      `;
      return;
    }

    loadingRow.innerHTML = `
      <td colspan="9" style="padding: 0;">
        <div class="sale-details-container" style="padding: 16px; background: rgba(255,255,255,0.02); border-bottom: 1px solid var(--border-color); margin: 0;">
          <h4 style="margin: 0 0 10px 0; color: var(--text-main); font-size: 13px; font-weight: 600; display: flex; align-items: center;">
            <span class="material-icons-outlined" style="margin-right: 6px; font-size: 18px; color: #8b5cf6;">shopping_bag</span>
            Detalles del Pedido (${items.length} productos)
          </h4>
          <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
            <thead>
              <tr style="border-bottom: 1px solid rgba(255,255,255,0.1); color: var(--text-muted); text-align: left;">
                <th style="padding: 8px; font-weight: 500; text-align: left;">Producto</th>
                <th style="padding: 8px; font-weight: 500; text-align: center; width: 15%;">Cantidad</th>
                <th style="padding: 8px; font-weight: 500; text-align: right; width: 25%;">Precio Unitario</th>
                <th style="padding: 8px; font-weight: 500; text-align: right; width: 25%;">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(item => `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">
                  <td style="padding: 8px; color: var(--text-main);">
                    <div style="font-weight: 500;">${item.product_name || 'Producto Desconocido'}</div>
                    <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">${item.barcode}</div>
                  </td>
                  <td style="padding: 8px; text-align: center; color: var(--text-main); font-weight: 500;">${item.quantity}</td>
                  <td style="padding: 8px; text-align: right; color: var(--text-main);">${dbHelper.formatCOP(item.unit_price)}</td>
                  <td style="padding: 8px; text-align: right; color: var(--text-main); font-weight: 600;">${dbHelper.formatCOP(item.unit_price * item.quantity)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </td>
    `;
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

  // Setup click-away listeners and dirty-state tracking for modals
  setupModals() {
    this.isInventoryDirty = false;
    this.isExpenseDirty = false;
    this.isPurchaseDirty = false;

    // Track input events to mark form as dirty
    const invForm = document.getElementById('inventory-modal-form');
    if (invForm) {
      invForm.addEventListener('input', () => {
        this.isInventoryDirty = true;
      });
    }

    const expForm = document.getElementById('expense-form');
    if (expForm) {
      expForm.addEventListener('input', () => {
        this.isExpenseDirty = true;
      });
    }

    const purForm = document.getElementById('purchase-modal-form');
    if (purForm) {
      purForm.addEventListener('input', () => {
        this.isPurchaseDirty = true;
      });
    }

    // Click-away overlays
    const invModal = document.getElementById('inventory-modal');
    if (invModal) {
      invModal.addEventListener('click', (e) => {
        if (e.target === invModal) {
          this.closeInventoryModal();
        }
      });
    }

    const expModal = document.getElementById('expense-modal');
    if (expModal) {
      expModal.addEventListener('click', (e) => {
        if (e.target === expModal) {
          this.closeExpenseModal();
        }
      });
    }

    const purModal = document.getElementById('purchase-modal');
    if (purModal) {
      purModal.addEventListener('click', (e) => {
        if (e.target === purModal) {
          this.closePurchaseModal();
        }
      });
    }

    // Autocomplete/lookup barcode in purchase modal
    const purBarcode = document.getElementById('pur-modal-barcode');
    if (purBarcode) {
      purBarcode.addEventListener('change', async (e) => {
        const barcode = dbHelper.normalizeBarcode(e.target.value);
        if (!barcode) return;
        
        const product = await dbHelper.getProductByBarcode(barcode);
        if (product) {
          document.getElementById('pur-modal-name').value = product.product_name || '';
          document.getElementById('pur-modal-category').value = product.category || '';
          if (product.supplier) document.getElementById('pur-modal-supplier').value = product.supplier;
          if (product.cost_price) document.getElementById('pur-modal-cost').value = product.cost_price;
          this.calculatePurchaseTotal();
        } else {
          // If not in products, check master_catalog
          const cat = await db.master_catalog.get(barcode);
          if (cat) {
            document.getElementById('pur-modal-name').value = cat.product_name || '';
            document.getElementById('pur-modal-category').value = cat.category || '';
          }
        }
      });
    }
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

    if (this.isInventoryDirty) {
      this.showConfirm('You have unsaved changes. Do you want to discard them and register a new product?', 'Discard & Continue').then(discard => {
        if (discard) {
          this.isInventoryDirty = false;
          this.openNewProductModal(prefilledBarcode);
        }
      });
      return;
    }

    this.isInventoryDirty = false; // Reset dirty state
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
    document.getElementById('inv-modal-expiration').value = '';
    
    const updatedAtEl = document.getElementById('inv-modal-updated-at');
    if (updatedAtEl) updatedAtEl.innerText = 'N/A';

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

    if (this.isInventoryDirty) {
      const discard = await this.showConfirm('You have unsaved changes. Do you want to discard them and edit this product?', 'Discard & Continue');
      if (!discard) return;
      this.isInventoryDirty = false;
    }

    this.isInventoryDirty = false; // Reset dirty state
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
    document.getElementById('inv-modal-expiration').value = product.expiration_date ? product.expiration_date.slice(0, 10) : '';
    
    const updatedAtEl = document.getElementById('inv-modal-updated-at');
    if (updatedAtEl) {
      updatedAtEl.innerText = product.updated_at ? new Date(product.updated_at).toLocaleString('es-CO', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }) : 'N/A';
    }

    modal.classList.remove('hidden');
    document.getElementById('inv-modal-adjust').focus();
  },

  async closeInventoryModal(force = false) {
    if (this.isInventoryDirty && !force) {
      const discard = await this.showConfirm('You have unsaved changes. Are you sure you want to discard them?', 'Discard Changes');
      if (!discard) return;
    }
    this.isInventoryDirty = false;
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
    const rappiRaw = document.getElementById('inv-modal-rappi').value;
    const rappiPrice = (rappiRaw === '' || isNaN(parseFloat(rappiRaw))) ? salePrice : parseFloat(rappiRaw);
    
    const currentStock = parseInt(document.getElementById('inv-modal-stock').value) || 0;
    const adjustQty = parseInt(document.getElementById('inv-modal-adjust').value) || 0;
    const expirationDate = document.getElementById('inv-modal-expiration').value || null;
    
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
      expiration_date: expirationDate,
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
      this.closeInventoryModal(true);
      
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
      this.closeInventoryModal(true);
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
    
    this.isExpenseDirty = false; // Reset dirty state
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
  async closeExpenseModal(force = false) {
    if (this.isExpenseDirty && !force) {
      const discard = await this.showConfirm('You have unsaved changes. Are you sure you want to discard them?', 'Discard Changes');
      if (!discard) return;
    }
    this.isExpenseDirty = false;
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
      this.closeExpenseModal(true);

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
      const amountStr = dbHelper.formatCOP(exp.amount);
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
  },

  // Open manual purchase creation modal
  openNewPurchaseModal() {
    const modal = document.getElementById('purchase-modal');
    if (!modal) return;

    this.isPurchaseDirty = false; // Reset dirty state
    
    // Set date field to local current time
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    document.getElementById('pur-modal-date').value = `${year}-${month}-${day}T${hours}:${minutes}`;

    document.getElementById('pur-modal-barcode').value = '';
    document.getElementById('pur-modal-name').value = '';
    document.getElementById('pur-modal-category').value = '';
    document.getElementById('pur-modal-supplier').value = '';
    document.getElementById('pur-modal-quantity').value = '';
    document.getElementById('pur-modal-cost').value = '';
    document.getElementById('pur-modal-total').value = '';
    document.getElementById('pur-modal-status').value = 'Disponible';
    document.getElementById('pur-modal-lot').value = '';
    document.getElementById('pur-modal-notes').value = '';
    document.getElementById('pur-modal-update-inv').checked = true;

    modal.classList.remove('hidden');
    setTimeout(() => document.getElementById('pur-modal-barcode').focus(), 100);
  },

  // Close manual purchase modal
  async closePurchaseModal(force = false) {
    if (this.isPurchaseDirty && !force) {
      const discard = await this.showConfirm('You have unsaved changes. Are you sure you want to discard them?', 'Discard Changes');
      if (!discard) return;
    }
    this.isPurchaseDirty = false;
    const modal = document.getElementById('purchase-modal');
    if (modal) modal.classList.add('hidden');
  },

  // Auto-calculate purchase total
  calculatePurchaseTotal() {
    const qtyInput = document.getElementById('pur-modal-quantity');
    const costInput = document.getElementById('pur-modal-cost');
    const totalInput = document.getElementById('pur-modal-total');

    if (qtyInput && costInput && totalInput) {
      const qty = parseInt(qtyInput.value) || 0;
      const cost = parseFloat(costInput.value) || 0;
      totalInput.value = (qty * cost).toFixed(2);
    }
  },

  // Save manual purchase
  async savePurchase(event) {
    event.preventDefault();

    const timestamp = document.getElementById('pur-modal-date').value;
    const barcode = dbHelper.normalizeBarcode(document.getElementById('pur-modal-barcode').value);
    const name = document.getElementById('pur-modal-name').value.trim();
    const category = document.getElementById('pur-modal-category').value.trim();
    const supplier = document.getElementById('pur-modal-supplier').value.trim() || 'Unknown';
    const quantity = parseInt(document.getElementById('pur-modal-quantity').value) || 0;
    const costPrice = parseFloat(document.getElementById('pur-modal-cost').value) || 0;
    const totalPrice = parseFloat(document.getElementById('pur-modal-total').value) || (quantity * costPrice);
    const status = document.getElementById('pur-modal-status').value;
    const lotReference = document.getElementById('pur-modal-lot').value.trim() || null;
    const notes = document.getElementById('pur-modal-notes').value.trim() || null;
    const updateInventory = document.getElementById('pur-modal-update-inv').checked;

    if (!timestamp || !barcode || !name || quantity <= 0 || costPrice < 0) {
      POS.showToast('Please fill out all required fields correctly.', 'error');
      return;
    }

    const purchaseRecord = {
      timestamp: new Date(timestamp).toISOString(),
      barcode,
      product_name: name,
      category,
      supplier,
      quantity,
      cost_price: costPrice,
      total_price: totalPrice,
      status,
      lot_reference: lotReference,
      notes
    };

    try {
      // 1. Save locally in Dexie
      let localId;
      await db.transaction('rw', db.purchases, db.master_catalog, db.products, async () => {
        // Ensure master_catalog record exists
        await db.master_catalog.put({
          barcode,
          product_name: name,
          category
        });

        // Insert purchase record (unsynced)
        localId = await db.purchases.add({ ...purchaseRecord, synced: 0 });

        // Update inventory if checked
        if (updateInventory) {
          const existing = await db.products.get(barcode);
          if (existing) {
            await db.products.update(barcode, {
              stock: (existing.stock || 0) + quantity,
              cost_price: costPrice,
              supplier,
              updated_at: new Date().toISOString()
            });
          } else {
            await db.products.put({
              barcode,
              supplier,
              cost_price: costPrice,
              sale_price: 0,
              rappi_price: 0,
              stock: quantity,
              updated_at: new Date().toISOString()
            });
          }
        }
      });

      console.log(`[Purchase] Saved locally with localId: ${localId}`);

      // 2. If online, attempt to push directly to PostgreSQL
      if (SyncEngine.onlineStatus) {
        try {
          await api.addPurchase({ ...purchaseRecord, update_inventory: updateInventory });
          // Mark as synced locally
          await db.purchases.update(localId, { synced: 1 });
          console.log(`[Purchase] Pushed and synced localId: ${localId} to server.`);
        } catch (serverErr) {
          console.warn('[Purchase] Failed to push directly to server, will sync in background:', serverErr);
        }
      }

      POS.showToast('Purchase recorded successfully!', 'success');
      this.closePurchaseModal(true);

      // 3. Reload views
      if (this.activeTab === 'tab-purchases') {
        await this.loadPurchases();
      } else if (this.activeTab === 'tab-inventory') {
        await this.loadInventory();
      }

    } catch (err) {
      console.error('[Purchase] Failed to save purchase:', err);
      POS.showToast('Failed to save purchase: ' + err.message, 'error');
    }
  },

  // Load and render purchases list
  async loadPurchases() {
    const tbody = document.getElementById('purchases-tbody');
    if (!tbody) return;

    try {
      // 1. Fetch category & supplier mappings for filters from catalog and purchases
      const supplierSelect = document.getElementById('purchase-supplier-select');
      const categorySelect = document.getElementById('purchase-category-select');
      
      const allPurchases = await db.purchases.toArray();

      if (supplierSelect && !supplierSelect.dataset.populated) {
        const suppliers = [...new Set(allPurchases.map(p => p.supplier).filter(Boolean))].sort();
        supplierSelect.innerHTML = '<option value="">All Suppliers</option>' +
          suppliers.map(sup => `<option value="${sup}">${sup}</option>`).join('');
        supplierSelect.dataset.populated = 'true';
      }

      if (categorySelect && !categorySelect.dataset.populated) {
        const categories = [...new Set(allPurchases.map(p => p.category).filter(Boolean))].sort();
        categorySelect.innerHTML = '<option value="">All Categories</option>' +
          categories.map(cat => `<option value="${cat}">${cat}</option>`).join('');
        categorySelect.dataset.populated = 'true';
      }

      // 2. Read filter values
      const dateFrom = document.getElementById('purchase-filter-from')?.value || '';
      const dateTo = document.getElementById('purchase-filter-to')?.value || '';
      const selectedSup = supplierSelect ? supplierSelect.value : '';
      const selectedCat = categorySelect ? categorySelect.value : '';
      const searchInput = document.getElementById('purchase-search-input');
      const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';

      let list = [];

      // If online, fetch purchases list from server
      if (SyncEngine.onlineStatus) {
        try {
          const params = { limit: 250 };
          if (dateFrom) params.from = dateFrom;
          if (dateTo) params.to = dateTo;
          if (selectedCat) params.category = selectedCat;
          if (selectedSup) params.supplier = selectedSup;
          
          const serverRes = await api.getPurchases(params);
          if (serverRes && serverRes.success) {
            list = serverRes.data;
          }
        } catch (serverErr) {
          console.warn('[Purchase] Failed to fetch purchases from server, using local fallback:', serverErr);
          list = allPurchases;
        }
      } else {
        list = allPurchases;
      }

      // 3. Fallback client-side filtering if offline or server load failed
      if (!SyncEngine.onlineStatus || list === allPurchases) {
        list = allPurchases.filter(p => {
          if (dateFrom && p.timestamp < dateFrom) return false;
          if (dateTo && p.timestamp > dateTo + 'T23:59:59') return false;
          if (selectedSup && p.supplier !== selectedSup) return false;
          if (selectedCat && p.category !== selectedCat) return false;
          return true;
        });
      }

      // Apply client-side text search (helps filter by name/barcode)
      if (searchQuery) {
        list = list.filter(p => 
          (p.product_name || '').toLowerCase().includes(searchQuery) ||
          (p.barcode || '').toLowerCase().includes(searchQuery) ||
          (p.notes || '').toLowerCase().includes(searchQuery)
        );
      }

      // Sort by date DESC
      list.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Calculate KPI metrics matching the filters (uses full local DB if present, or fallback to server list)
      const kpiSource = (allPurchases && allPurchases.length > 0) ? allPurchases : list;
      const filteredAllPurchases = kpiSource.filter(p => {
        if (dateFrom && p.timestamp < dateFrom) return false;
        if (dateTo && p.timestamp > dateTo + 'T23:59:59') return false;
        if (selectedSup && p.supplier !== selectedSup) return false;
        if (selectedCat && p.category !== selectedCat) return false;
        if (searchQuery) {
          return (p.product_name || '').toLowerCase().includes(searchQuery) ||
                 (p.barcode || '').toLowerCase().includes(searchQuery) ||
                 (p.notes || '').toLowerCase().includes(searchQuery);
        }
        return true;
      });

      let spent = 0;
      let itemsCount = 0;
      filteredAllPurchases.forEach(p => {
        spent += Number(p.total_price) || 0;
        itemsCount += parseInt(p.quantity) || 0;
      });

      document.getElementById('purchase-kpi-total-amount').innerText = dbHelper.formatCOP(spent);
      document.getElementById('purchase-kpi-total-items').innerText = itemsCount.toLocaleString();

      const purchasesTab = document.getElementById('tab-purchases');
      const spentSpan = purchasesTab ? purchasesTab.querySelector('.kpi-card:nth-child(1) .kpi-details span') : null;
      const itemsSpan = purchasesTab ? purchasesTab.querySelector('.kpi-card:nth-child(2) .kpi-details span') : null;
      
      const isPurFiltered = dateFrom || dateTo || selectedSup || selectedCat || searchQuery;
      const purLabelPrefix = isPurFiltered ? "Period's" : "Total";
      
      if (spentSpan) spentSpan.innerText = `${purLabelPrefix} spent on purchases`;
      if (itemsSpan) itemsSpan.innerText = `${purLabelPrefix} purchased items`;

      if (list.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="12" class="text-center text-muted" style="padding: 40px 0;">No purchases found matching filters.</td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = list.map(p => {
        const dateStr = new Date(p.timestamp).toLocaleString('es-CO', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        });
        const unitCost = dbHelper.formatCOP(p.cost_price);
        const totalCost = dbHelper.formatCOP(p.total_price);
        const idVal = p.id || `local_${p.local_id}`;

        return `
          <tr>
            <td>${dateStr}</td>
            <td><code>${p.barcode}</code></td>
            <td><strong class="product-title-cell">${p.product_name}</strong></td>
            <td><span class="category-tag">${p.category || 'General'}</span></td>
            <td>${p.supplier || 'Unknown'}</td>
            <td class="text-right"><strong>${p.quantity}</strong></td>
            <td class="text-right">${unitCost}</td>
            <td class="text-right font-medium text-success">${totalCost}</td>
            <td class="text-center">
              <span class="stock-pill ${p.status === 'Disponible' ? 'positive' : 'negative'}">
                ${p.status}
              </span>
            </td>
            <td>${p.lot_reference || '<span class="text-muted">N/A</span>'}</td>
            <td style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${p.notes || ''}">
              ${p.notes || ''}
            </td>
            <td class="text-center">
              <button class="btn-icon delete" onclick="App.deletePurchaseTrigger('${idVal}', ${p.local_id || 'null'})" style="color: var(--color-danger); cursor: pointer;" title="Delete purchase">
                <span class="material-icons-outlined">delete_outline</span>
              </button>
            </td>
          </tr>
        `;
      }).join('');

    } catch (err) {
      console.error('[Purchase] Failed to load purchases list:', err);
      tbody.innerHTML = `<tr><td colspan="12" class="text-center text-danger">Error loading purchases: ${err.message}</td></tr>`;
    }
  },

  // Delete a purchase entry
  async deletePurchaseTrigger(idVal, localId) {
    const confirmed = await this.showConfirm('Are you absolutely sure you want to delete this purchase entry? This will permanently remove the record and adjust the product stock level.', 'Delete Purchase');
    if (!confirmed) return;

    try {
      let purchase;
      if (localId) {
        purchase = await db.purchases.get(localId);
      } else if (String(idVal).startsWith('local_')) {
        const parsedLocalId = parseInt(idVal.split('_')[1]);
        if (!isNaN(parsedLocalId)) {
          purchase = await db.purchases.get(parsedLocalId);
        }
      }

      // Revert product stock locally
      if (purchase) {
        await db.transaction('rw', db.purchases, db.products, async () => {
          const prod = await db.products.get(purchase.barcode);
          if (prod) {
            await db.products.update(purchase.barcode, {
              stock: Math.max(0, (prod.stock || 0) - purchase.quantity),
              updated_at: new Date().toISOString()
            });
          }
          await db.purchases.delete(purchase.local_id);
        });
      }

      // If online and it has a server ID, delete from PostgreSQL database
      if (SyncEngine.onlineStatus && idVal && !String(idVal).startsWith('local_')) {
        await api.deletePurchase(idVal);
        console.log(`[Purchase] Deleted purchase ID ${idVal} from server.`);
      }

      POS.showToast('Purchase entry deleted and inventory adjusted.', 'success');
      
      // Reload reports and purchases views
      if (this.activeTab === 'tab-purchases') {
        await this.loadPurchases();
      } else if (this.activeTab === 'tab-inventory') {
        await this.loadInventory();
      }

    } catch (err) {
      console.error('[Purchase] Failed to delete purchase:', err);
      POS.showToast('Failed to delete purchase: ' + err.message, 'error');
    }
  }
};

// Bootstrap application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  App.init().catch(console.error);
});
