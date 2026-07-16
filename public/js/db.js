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

  // Retrieve item details joined with catalog details by barcode
  // Supports robust matching for padded/stripped barcodes (Excel number formatting fixes)
  async getProductByBarcode(originalBarcode) {
    const barcode = String(originalBarcode).trim();
    let product = await db.products.get(barcode);
    let matchedBarcode = barcode;

    // 1. If not found, try stripping leading zeros (case where Excel lost leading zeros but scanner has them)
    if (!product && barcode.startsWith('0')) {
      const stripped = barcode.replace(/^0+/, '');
      product = await db.products.get(stripped);
      if (product) matchedBarcode = stripped;
    }

    // 2. If still not found, try padding to UPC (12 digits) with leading zeros
    if (!product && barcode.length < 12) {
      const padded12 = barcode.padStart(12, '0');
      product = await db.products.get(padded12);
      if (product) matchedBarcode = padded12;
    }

    // 3. If still not found, try padding to EAN (13 digits)
    if (!product && barcode.length < 13) {
      const padded13 = barcode.padStart(13, '0');
      product = await db.products.get(padded13);
      if (product) matchedBarcode = padded13;
    }

    if (!product) return null;
    
    const catalog = await db.master_catalog.get(matchedBarcode);
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
  }
};

