/**
 * Dexie.js Local Database Setup
 * 
 * Defines local offline schema matching the backend Postgres schema.
 * All sales are stored locally first, then synced to the server in the background.
 */

// Initialize Dexie database
const db = new Dexie('VelyKaPetPOS');

db.version(1).stores({
  // &barcode is the primary key (unique, indexed)
  master_catalog: '&barcode, category',
  
  // &barcode is the primary key (unique, indexed)
  products: '&barcode, supplier',
  
  // ++local_id is auto-incrementing key.
  // We index: timestamp, synced, origin, payment_method for quick reports & sync filtering.
  sales: '++local_id, timestamp, synced, origin, payment_method'
});

db.version(2).stores({
  master_catalog: '&barcode, category',
  products: '&barcode, supplier',
  sales: '++local_id, timestamp, synced, origin, payment_method',
  expenses: '++local_id, timestamp, synced, category'
});

// Helper functions for common Dexie operations
const dbHelper = {
  // Normalize barcode by trimming and removing leading zeros
  normalizeBarcode(barcode) {
    if (barcode === undefined || barcode === null) return '';
    const cleaned = String(barcode).trim();
    const stripped = cleaned.replace(/^0+/, '');
    return stripped === '' ? '0' : stripped;
  },

  // Format currency with COP style dot separators for thousands, omitting all decimals
  formatCOP(amount) {
    const num = Math.round(Number(amount) || 0);
    const integerPart = String(num).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `$${integerPart}`;
  },

  // Retrieve item details joined with catalog details by barcode
  async getProductByBarcode(originalBarcode) {
    const barcode = this.normalizeBarcode(originalBarcode);
    const product = await db.products.get(barcode);

    if (!product) return null;
    
    const catalog = await db.master_catalog.get(barcode);
    return {
      barcode: product.barcode,
      product_name: catalog ? catalog.product_name : 'Unknown Product',
      category: catalog ? catalog.category : 'Unknown',
      supplier: product.supplier,
      cost_price: Number(product.cost_price) || 0,
      sale_price: Number(product.sale_price) || 0,
      rappi_price: Number(product.rappi_price) || 0,
      stock: parseInt(product.stock) || 0
    };
  },

  // Clear all local tables (useful for complete refresh / reset)
  async clearAll() {
    await db.transaction('rw', db.master_catalog, db.products, db.sales, db.expenses, async () => {
      await db.master_catalog.clear();
      await db.products.clear();
      await db.sales.clear();
      await db.expenses.clear();
    });
    console.log('[Dexie] Local database cleared.');
  },

  // One-time startup migration to normalize existing local barcodes
  async migrateLocalBarcodes() {
    console.log('[Dexie] Checking local barcodes for normalization...');
    await db.transaction('rw', db.products, db.master_catalog, async () => {
      const allProducts = await db.products.toArray();
      for (const p of allProducts) {
        const norm = this.normalizeBarcode(p.barcode);
        if (norm !== p.barcode) {
          console.log(`[Dexie] Normalizing product barcode: ${p.barcode} -> ${norm}`);
          await db.products.delete(p.barcode);
          p.barcode = norm;
          await db.products.put(p);
        }
      }
      
      const allCatalog = await db.master_catalog.toArray();
      for (const c of allCatalog) {
        const norm = this.normalizeBarcode(c.barcode);
        if (norm !== c.barcode) {
          console.log(`[Dexie] Normalizing catalog barcode: ${c.barcode} -> ${norm}`);
          await db.master_catalog.delete(c.barcode);
          c.barcode = norm;
          await db.master_catalog.put(c);
        }
      }
    });
    console.log('[Dexie] Local barcode normalization check complete.');
  },

  // Backfill invoice numbers for existing local sales records
  async backfillInvoiceNumbers() {
    console.log('[Dexie] Checking local sales for invoice numbering backfill...');
    await db.transaction('rw', db.sales, async () => {
      const allSales = await db.sales.toArray();
      let updatedCount = 0;
      for (const s of allSales) {
        if (!s.invoice_number) {
          const year = new Date(s.timestamp).getFullYear().toString().slice(-2);
          const deviceId = localStorage.getItem('pos_device_id') || '1';
          const seq = String(s.local_id).padStart(5, '0');
          const invoiceNum = `VK-${year}-${deviceId}-${seq}`;
          
          await db.sales.update(s.local_id, { invoice_number: invoiceNum, synced: 0 });
          updatedCount++;
        }
      }
      if (updatedCount > 0) {
        console.log(`[Dexie] Backfilled invoice numbers for ${updatedCount} sales. Triggering sync...`);
      }
    });
  }
};

