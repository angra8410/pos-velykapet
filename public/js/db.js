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

// Helper functions for common Dexie operations
const dbHelper = {
  // Clear all local tables (useful for complete refresh / reset)
  async clearAll() {
    await db.transaction('rw', db.master_catalog, db.products, db.sales, async () => {
      await db.master_catalog.clear();
      await db.products.clear();
      await db.sales.clear();
    });
    console.log('[Dexie] Local database cleared.');
  },

  // Retrieve item details joined with catalog details by barcode
  async getProductByBarcode(barcode) {
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
  }
};
