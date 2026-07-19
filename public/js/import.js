/**
 * Excel File Importer
 * 
 * Uses SheetJS (XLSX) to parse uploaded spreadsheets in the browser.
 * Maps columns dynamically and saves data locally to Dexie, then sends it to the server.
 */

const ExcelImporter = {
  // Common column headers in Spanish/English to auto-detect
  mappings: {
    catalog: {
      barcode: ['codigo de barra', 'codigo de barras', 'codigo', 'barcode', 'barcodes', 'codigos'],
      product_name: ['nombre producto', 'product_name', 'product', 'producto', 'name', 'nombre', 'descripción', 'descripcion', 'description'],
      category: ['categoría', 'categoria', 'category', 'tipo', 'group', 'grupo']
    },
    inventory: {
      barcode: ['codigo de barra', 'codigo de barras', 'codigo', 'barcode', 'codigos', 'barcodes'],
      supplier: ['proveedor', 'supplier', 'marca', 'supplier_name'],
      cost_price: ['costo unitario', 'cost_price', 'cost', 'costo', 'precio costo', 'costo_precio'],
      sale_price: ['precio final venta', 'precio venta', 'sale_price', 'price', 'precio', 'retail', 'venta', 'sale'],
      rappi_price: ['precio rappi', 'rappi_price', 'rappi', 'rappi price'],
      stock: ['stock actual', 'stock_actual', 'stock', 'cantidad', 'inventario', 'qty', 'quantity', 'existencias'],
      expiration_date: ['fecha vencimiento', 'vencimiento', 'fecha_vencimiento', 'expiration_date', 'expiration', 'vence', 'vence_fecha', 'fecha de vencimiento'],
      // Extra fields to automatically populate master_catalog from inventory sheet if missing
      product_name: ['nombre producto', 'product_name', 'product', 'producto', 'name', 'nombre', 'descripción', 'descripcion', 'description'],
      category: ['categoría', 'categoria', 'category', 'tipo', 'group', 'grupo']
    },
    expenses: {
      timestamp: ['fecha', 'date', 'timestamp', 'dia'],
      description: ['descripción', 'descripcion', 'description', 'detalle', 'concepto'],
      category: ['categoría gasto', 'categoria gasto', 'categoría', 'categoria', 'category', 'tipo'],
      payment_method: ['método pago', 'metodo pago', 'pago', 'payment_method', 'metodo_pago'],
      amount: ['monto', 'valor', 'total', 'precio', 'amount', 'costo']
    },
    purchases: {
      timestamp: ['fecha', 'date', 'timestamp', 'dia', 'fecha compra'],
      barcode: ['código producto', 'codigo producto', 'codigo', 'barcode', 'codigos', 'barcodes', 'codigo de barra', 'codigo de barras'],
      product_name: ['producto', 'nombre producto', 'product_name', 'product', 'nombre', 'descripción', 'descripcion', 'description'],
      category: ['categoría', 'categoria', 'category', 'tipo', 'group', 'grupo'],
      supplier: ['proveedor', 'supplier', 'marca', 'supplier_name'],
      quantity: ['cantidad', 'quantity', 'qty', 'cantidad compra'],
      cost_price: ['costo unitario', 'cost_price', 'cost', 'costo', 'precio costo', 'costo_precio'],
      total_price: ['total compra', 'total_compra', 'total_price', 'total', 'valor total'],
      status: ['estado', 'status', 'disponible/vendido', 'estado (disponible/vendido)'],
      lot_reference: ['lote/referencia', 'lote', 'referencia', 'lot', 'reference', 'lote_referencia'],
      notes: ['notas', 'notes', 'comentarios', 'comentario']
    }
  },
  
  // Read and parse file
  async parseFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          resolve(workbook);
        } catch (err) {
          reject(new Error('Failed to parse Excel file structure: ' + err.message));
        }
      };
      reader.onerror = () => reject(new Error('File reading error'));
      reader.readAsArrayBuffer(file);
    });
  },

  // Map headers to schema columns
  detectHeaders(headers, type) {
    const map = {};
    const schemaKeys = Object.keys(this.mappings[type]);
    const lowerHeaders = headers.map(h => String(h).trim().toLowerCase());

    schemaKeys.forEach(key => {
      const aliases = this.mappings[type][key];
      // 1. Try exact matches first to prevent collisions (e.g. Proveedor vs Código proveedores)
      let foundIdx = lowerHeaders.findIndex(header => 
        aliases.some(alias => header === alias)
      );
      // 2. Fall back to partial matches if no exact match is found
      if (foundIdx === -1) {
        foundIdx = lowerHeaders.findIndex(header => 
          aliases.some(alias => header.includes(alias))
        );
      }
      
      if (foundIdx !== -1) {
        map[key] = headers[foundIdx]; // store original header name
      }
    });

    return map;
  },

  parseNumber(val) {
    if (val === undefined || val === null) return 0;
    if (typeof val === 'number') return val;
    const cleaned = String(val).replace(/[^0-9.-]/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  },

  parseIntNumber(val) {
    if (val === undefined || val === null) return 0;
    if (typeof val === 'number') return Math.floor(val);
    const cleaned = String(val).replace(/[^0-9-]/g, '');
    const parsed = parseInt(cleaned, 10);
    return isNaN(parsed) ? 0 : parsed;
  },

  parseDate(val) {
    if (!val) return null;
    try {
      // Excel dates can be parsed as Date object or serial number. If it is a string representation:
      const d = new Date(val);
      if (!isNaN(d.getTime())) {
        return d.toISOString().slice(0, 10);
      }
    } catch (e) {}
    return null;
  },

  parseExcelDate(val) {
    if (!val) return new Date();
    if (val instanceof Date && !isNaN(val.getTime())) return val;

    // If it's a number (or string of a number like "45916")
    const num = Number(val);
    if (!isNaN(num) && num > 30000 && num < 60000) {
      // Excel serial date starting from 1900-01-01
      return new Date(Math.round((num - 25569) * 86400 * 1000));
    }

    const str = String(val).trim();
    if (!str) return new Date();

    // Try standard ISO / JS date parse first
    let d = new Date(str);
    if (!isNaN(d.getTime())) return d;

    // Handle Spanish / Latin America date formats (DD/MM/YYYY or D/M/YYYY or YYYY/MM/DD)
    const parts = str.split(/[\/\-\.]/);
    if (parts.length === 3) {
      let day, month, year;
      if (parts[0].length === 4) {
        // YYYY-MM-DD or YYYY/MM/DD
        year = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10) - 1;
        day = parseInt(parts[2], 10);
      } else {
        const p0 = parseInt(parts[0], 10);
        const p1 = parseInt(parts[1], 10);
        const p2 = parseInt(parts[2], 10);
        const fullYear = p2 < 100 ? 2000 + p2 : p2;

        if (p0 > 12) {
          // p0 is Day, p1 is Month
          day = p0;
          month = p1 - 1;
          year = fullYear;
        } else if (p1 > 12) {
          // p1 is Day, p0 is Month
          day = p1;
          month = p0 - 1;
          year = fullYear;
        } else {
          // Spanish format defaults to DD/MM/YYYY
          day = p0;
          month = p1 - 1;
          year = fullYear;
        }
      }
      d = new Date(year, month, day);
      if (!isNaN(d.getTime())) return d;
    }

    return new Date();
  },

  // Transform raw sheet JSON data based on detected mapping
  transformData(rawJson, mapping, type) {
    if (type === 'purchases') {
      const purchasesList = [];
      rawJson.forEach(row => {
        const rawBarcode = row[mapping.barcode] || row['Barcode'] || row['Código producto'];
        const productName = String(row[mapping.product_name] || '').trim();
        
        // If there is no product name, we skip it
        if (!productName) return;

        // Clean barcode or generate a fallback barcode
        let barcode = dbHelper.normalizeBarcode(rawBarcode);
        if (!barcode) {
          barcode = dbHelper.generateFallbackBarcode(productName);
        }

        const quantity = this.parseIntNumber(row[mapping.quantity]) || 1;
        const costPrice = this.parseNumber(row[mapping.cost_price]);
        const totalPrice = this.parseNumber(row[mapping.total_price]) || (quantity * costPrice);
        const timestamp = row[mapping.timestamp];
        const dateVal = this.parseExcelDate(timestamp);
        const category = String(row[mapping.category] || 'General').trim();
        const supplier = String(row[mapping.supplier] || 'Unknown').trim();
        const status = String(row[mapping.status] || 'Disponible').trim();
        const lotRef = String(row[mapping.lot_reference] || '').trim();
        const notes = String(row[mapping.notes] || row['Notas'] || '').trim();

        purchasesList.push({
          timestamp: dateVal.toISOString(),
          barcode,
          product_name: productName,
          category,
          supplier,
          quantity,
          cost_price: costPrice,
          total_price: totalPrice,
          status,
          lot_reference: lotRef || null,
          notes: notes || null
        });
      });
      return purchasesList;
    }

    if (type === 'expenses') {
      const expensesList = [];
      rawJson.forEach(row => {
        const timestamp = row[mapping.timestamp];
        const description = row[mapping.description];
        const category = row[mapping.category];
        const payment_method = row[mapping.payment_method];
        const amount = row[mapping.amount];
        const notes = row['Notas'] || '';

        if (timestamp && description && amount != null) {
          expensesList.push({
            timestamp: new Date(timestamp).toISOString(),
            description: String(description).trim(),
            category: String(category || 'General').trim(),
            payment_method: String(payment_method || 'Other').trim(),
            amount: this.parseNumber(amount),
            notes: String(notes).trim()
          });
        }

        // Parse side-by-side secondary entry if it exists (repetition in GASTOS sheet)
        if (row['__EMPTY_3'] && row['__EMPTY_4'] && row['__EMPTY_7']) {
          expensesList.push({
            timestamp: new Date(row['__EMPTY_3']).toISOString(),
            description: String(row['__EMPTY_4']).trim(),
            category: String(row['__EMPTY_5'] || 'General').trim(),
            payment_method: String(row['__EMPTY_6'] || 'Other').trim(),
            amount: this.parseNumber(row['__EMPTY_7']),
            notes: String(row['__EMPTY_8'] || '').trim()
          });
        }
      });
      return expensesList;
    }

    return rawJson.map(row => {
      const item = {};
      
      if (type === 'catalog') {
        item.barcode = dbHelper.normalizeBarcode(row[mapping.barcode]);
        item.product_name = String(row[mapping.product_name] || '').trim();
        item.category = String(row[mapping.category] || 'General').trim();
        
        // Skip rows without valid barcode or name
        if (!item.barcode || !item.product_name) return null;
      } else {
        item.barcode = dbHelper.normalizeBarcode(row[mapping.barcode]);
        item.supplier = String(row[mapping.supplier] || 'Unknown').trim();
        item.cost_price = this.parseNumber(row[mapping.cost_price]);
        item.sale_price = this.parseNumber(row[mapping.sale_price]);
        item.rappi_price = this.parseNumber(row[mapping.rappi_price]) || item.sale_price; // fallback to sale price
        item.stock = this.parseIntNumber(row[mapping.stock]);
        item.expiration_date = mapping.expiration_date ? this.parseDate(row[mapping.expiration_date]) : null;
        
        // Map extra product_name and category columns from inventory sheet
        item.product_name = String(row[mapping.product_name] || '').trim();
        item.category = String(row[mapping.category] || 'General').trim();

        if (!item.barcode) return null;
      }
      return item;
    }).filter(Boolean);
  },

  // Import catalog rows (first Dexie, then PostgreSQL)
  async importCatalog(rows, progressCallback) {
    const batchSize = 250;
    const total = rows.length;

    progressCallback(`Saving ${total} catalog entries locally...`, 10);
    // 1. Bulk save to Dexie
    await db.transaction('rw', db.master_catalog, async () => {
      await db.master_catalog.bulkPut(rows);
    });

    progressCallback('Syncing catalog with production database...', 40);
    // 2. Bulk post to server in batches to prevent payload limits
    for (let i = 0; i < total; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const pct = Math.floor(40 + (i / total) * 50);
      progressCallback(`Syncing catalog batch ${i / batchSize + 1}...`, pct);
      await api.importCatalogBulk(batch);
    }
    
    progressCallback('Catalog imported successfully ✓', 100);
  },

  // Import product rows (first Dexie, then PostgreSQL)
  async importProducts(rows, progressCallback) {
    const batchSize = 250;
    const total = rows.length;

    progressCallback(`Saving ${total} product records locally...`, 10);
    // 1. Bulk save to Dexie
    await db.transaction('rw', db.products, db.master_catalog, async () => {
      // Auto-populate missing master_catalog entries from the inventory rows
      const catalogEntries = rows
        .filter(r => r.product_name)
        .map(r => ({
          barcode: r.barcode,
          product_name: r.product_name,
          category: r.category || 'General'
        }));

      if (catalogEntries.length > 0) {
        await db.master_catalog.bulkPut(catalogEntries);
      }

      await db.products.bulkPut(rows);
    });


    progressCallback('Syncing inventory with production database...', 40);
    // 2. Bulk post to server in batches
    for (let i = 0; i < total; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const pct = Math.floor(40 + (i / total) * 50);
      progressCallback(`Syncing inventory batch ${i / batchSize + 1}...`, pct);
      await api.importProductsBulk(batch);
    }

    progressCallback('Inventory imported successfully ✓', 100);
  },

  // Import expenses rows (first Dexie, then PostgreSQL)
  async importExpenses(rows, progressCallback) {
    const batchSize = 250;
    const total = rows.length;

    progressCallback(`Saving ${total} expenses locally...`, 10);
    // 1. Bulk save to Dexie
    await db.transaction('rw', db.expenses, async () => {
      const synced = (window.SyncEngine && SyncEngine.onlineStatus) ? 1 : 0;
      const dbRows = rows.map(r => ({ ...r, synced }));
      await db.expenses.bulkPut(dbRows);
    });

    progressCallback('Syncing expenses with production database...', 40);
    // 2. Bulk post to server in batches
    for (let i = 0; i < total; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const pct = Math.floor(40 + (i / total) * 50);
      progressCallback(`Syncing expenses batch ${i / batchSize + 1}...`, pct);
      await api.importExpensesBulk(batch);
    }

    progressCallback('Expenses imported successfully ✓', 100);
  },

  // Import purchases rows (first Dexie, then PostgreSQL)
  async importPurchases(rows, progressCallback) {
    const batchSize = 250;
    const total = rows.length;

    progressCallback(`Saving ${total} purchases locally...`, 10);
    // 1. Bulk save to Dexie
    await db.transaction('rw', db.purchases, db.master_catalog, async () => {
      // Auto-populate missing master_catalog entries from the purchases rows
      const catalogEntries = rows
        .filter(r => r.product_name)
        .map(r => ({
          barcode: r.barcode,
          product_name: r.product_name,
          category: r.category || 'General'
        }));

      if (catalogEntries.length > 0) {
        await db.master_catalog.bulkPut(catalogEntries);
      }

      const synced = (window.SyncEngine && SyncEngine.onlineStatus) ? 1 : 0;
      const dbRows = rows.map(r => ({ ...r, synced }));
      await db.purchases.bulkPut(dbRows);
    });

    progressCallback('Syncing purchases with production database...', 40);
    // 2. Bulk post to server in batches
    for (let i = 0; i < total; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const pct = Math.floor(40 + (i / total) * 50);
      progressCallback(`Syncing purchases batch ${i / batchSize + 1}...`, pct);
      await api.importPurchasesBulk(batch);
    }

    progressCallback('Purchases imported successfully ✓', 100);
  }
};
