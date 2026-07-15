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
      product_name: ['product_name', 'product', 'producto', 'name', 'nombre', 'descripcion', 'description'],
      category: ['category', 'categoria', 'tipo', 'group', 'grupo']
    },
    inventory: {
      barcode: ['codigo de barra', 'codigo de barras', 'codigo', 'barcode', 'codigos', 'barcodes'],
      supplier: ['supplier', 'proveedor', 'marca', 'supplier_name'],
      cost_price: ['cost_price', 'cost', 'costo', 'precio costo', 'costo_precio'],
      sale_price: ['sale_price', 'price', 'precio', 'retail', 'venta', 'precio venta', 'sale'],
      rappi_price: ['rappi_price', 'rappi', 'precio rappi', 'rappi price'],
      stock: ['stock', 'cantidad', 'inventario', 'qty', 'quantity', 'existencias'],
      // Extra fields to automatically populate master_catalog from inventory sheet if missing
      product_name: ['product_name', 'product', 'producto', 'name', 'nombre', 'descripcion', 'description'],
      category: ['category', 'categoria', 'tipo', 'group', 'grupo']
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
      // Find the index of the first header that matches one of the aliases
      const foundIdx = lowerHeaders.findIndex(header => 
        aliases.some(alias => header === alias || header.includes(alias))
      );
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

  // Transform raw sheet JSON data based on detected mapping
  transformData(rawJson, mapping, type) {
    return rawJson.map(row => {
      const item = {};
      
      if (type === 'catalog') {
        item.barcode = String(row[mapping.barcode] || '').trim();
        item.product_name = String(row[mapping.product_name] || '').trim();
        item.category = String(row[mapping.category] || 'General').trim();
        
        // Skip rows without valid barcode or name
        if (!item.barcode || !item.product_name) return null;
      } else {
        item.barcode = String(row[mapping.barcode] || '').trim();
        item.supplier = String(row[mapping.supplier] || 'Unknown').trim();
        item.cost_price = this.parseNumber(row[mapping.cost_price]);
        item.sale_price = this.parseNumber(row[mapping.sale_price]);
        item.rappi_price = this.parseNumber(row[mapping.rappi_price]) || item.sale_price; // fallback to sale price
        item.stock = this.parseIntNumber(row[mapping.stock]);
        
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
  }
};
