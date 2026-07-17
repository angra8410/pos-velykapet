const XLSX = require('xlsx');
const { Pool } = require('pg');
require('dotenv').config();

const dbUrl = process.env.DATABASE_URL || '';
const isRailwayInternal = dbUrl.includes('railway.internal');

const pool = new Pool({
  connectionString: dbUrl,
  ssl: isRailwayInternal ? false : { rejectUnauthorized: false },
});

const filePath = 'C:\\Users\\antoi\\Downloads\\All_Files\\projects\\velykapet-bi\\Data_Cliente_Multidominio.xlsx';

// Excel Date Converter
function parseExcelDate(excelDate) {
  if (!excelDate) return new Date();
  if (typeof excelDate === 'string') {
    const d = new Date(excelDate);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date((excelDate - 25569) * 86400 * 1000);
}

// Clean text and numbers
const cleanStr = (val) => val === undefined || val === null ? '' : String(val).trim();
const cleanNum = (val) => {
  if (val === undefined || val === null) return 0;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
};

// Generate a clean text barcode for products that have no barcode in the catalog
function getFallbackBarcode(productName) {
  const clean = productName
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove accents
    .replace(/[^A-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `MIG-${clean.substring(0, 50)}`;
}

// Manual map for remaining typos and spelling variants
const manualBarcodeMap = {
  'comida humeda para perros pedigree razas pequenas sabor pollo x 100 gr': '706460249286',
  'comida humeda para perros pedigree adulto res x 100 gr': '706460249279',
  'comida humeda para perros pedigree adulto pollo x 100 gr': '7506460249231',
  'comida humeda para perros pedigree adulto pollo y cerdo 85 gr': '7506174515102',
  'evolve perro classic bandeja pavo': '73657009290',
  'simparica tabletas 10-20 kg': '5414736047935',
  'champu aloe vera canis & feliz x 200 ml': '5044646020',
  'snouts salmon deshidratado 100g': '0787416260319',
  'helado yogurt galleta 120g': 'VELY099',
  'gal-hldo - helado yogurt galleta 120g': 'VELY099',
  'helado yogurt chispas 120g': 'VELY096',
  'ch-hldo - helado yogurt chispas 120g': 'VELY096',
  'tranquilan gotas x 10 ml': 'VELY115',
  'br for dog cachorros razas pequenas 1 kg': 'VELY078',
};

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('[Migration] Connected to PostgreSQL. Starting import...');

    // 1. Fetch catalog to build name -> barcode map
    const catalogRes = await client.query('SELECT barcode, product_name FROM master_catalog');
    const catalogMap = new Map();
    const allCatalogNames = [];
    
    catalogRes.rows.forEach(row => {
      const normName = row.product_name.replace(/[\r\n\s]+/g, ' ').toLowerCase().trim();
      catalogMap.set(normName, row.barcode);
      allCatalogNames.push({ barcode: row.barcode, name: row.product_name, normName });
    });
    console.log(`[Migration] Loaded ${catalogMap.size} unique master catalog name references.`);

    // 2. Read spreadsheet
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets['VENTAS'];
    const rawRows = XLSX.utils.sheet_to_json(sheet);
    console.log(`[Migration] Read ${rawRows.length} rows from VENTAS sheet.`);

    // Date Range: Sept 1, 2025 to July 14, 2026
    const startDate = new Date('2025-09-01T00:00:00.000Z');
    const endDate = new Date('2026-07-14T23:59:59.999Z');

    // 3. Process & Map Rows
    const processedRows = [];
    let skippedOutOfRange = 0;

    rawRows.forEach((row, idx) => {
      const timestamp = parseExcelDate(row['Fecha']);
      if (timestamp < startDate || timestamp > endDate) {
        skippedOutOfRange++;
        return;
      }

      let barcode = cleanStr(row['Código producto'] || row['Código']);
      const productName = cleanStr(row['Producto'] || row['Nombre Producto'] || row['nombre']);
      const normProductName = productName.replace(/[\r\n\s]+/g, ' ').toLowerCase().trim();

      // Resolve barcode if blank
      if (!barcode) {
        // A. Check manual spelling map
        if (manualBarcodeMap[normProductName]) {
          barcode = manualBarcodeMap[normProductName];
        } 
        // B. Check catalog name map
        else if (catalogMap.has(normProductName)) {
          barcode = catalogMap.get(normProductName);
        } 
        // C. Check substring matching
        else {
          const match = allCatalogNames.find(c => 
            c.normName.includes(normProductName) || normProductName.includes(c.normName)
          );
          if (match) {
            barcode = match.barcode;
          } else {
            // D. Fallback to descriptive text barcode
            barcode = getFallbackBarcode(productName);
          }
        }
      }

      const keys = Object.keys(row);
      const priceKey = keys.find(k => k.toLowerCase().includes('precio unitario')) || '';
      const costKey = keys.find(k => k.toLowerCase().includes('costo unitario')) || '';
      const totalKey = keys.find(k => k.toLowerCase().includes('total venta')) || '';

      const unitPrice = cleanNum(row[priceKey]);
      const unitCost = cleanNum(row[costKey]);
      const totalAmount = cleanNum(row[totalKey]);
      const quantity = parseInt(row['Cantidad']) || 1;

      processedRows.push({
        idx,
        barcode,
        productName,
        quantity,
        unitCost,
        unitPrice,
        totalAmount,
        timestamp,
        origin: cleanStr(row['Origen (ej. tienda/online)'] || row['Origen'] || 'tienda'),
        paymentMethod: cleanStr(row['Método de pago'] || row['Pago'] || 'Efectivo'),
        transactionCode: cleanStr(row['Código Transacción'] || row['Referencia'] || ''),
        tower: cleanStr(row['Torre'] || ''),
        apto: cleanStr(row['Apto'] || ''),
        complex: cleanStr(row['Unidad'] || ''),
        notes: cleanStr(row['Notas'] || ''),
      });
    });

    console.log(`[Migration] Filtered ${processedRows.length} rows in range (Skipped ${skippedOutOfRange} out of range).`);

    // 4. Group rows into distinct sales
    const salesGroup = {};
    processedRows.forEach(row => {
      const dateStr = row.timestamp.toISOString().split('T')[0];
      const groupKey = `${dateStr}|${row.origin.toLowerCase()}|${row.paymentMethod.toLowerCase()}|${row.transactionCode.toLowerCase()}|${row.tower.toLowerCase()}|${row.apto.toLowerCase()}|${row.complex.toLowerCase()}`;

      if (!salesGroup[groupKey]) {
        salesGroup[groupKey] = {
          timestamp: row.timestamp,
          origin: row.origin,
          paymentMethod: row.paymentMethod,
          transactionCode: row.transactionCode,
          tower: row.tower,
          apto: row.apto,
          complex: row.complex,
          notes: row.notes,
          items: [],
          totalAmount: 0
        };
      }

      salesGroup[groupKey].items.push({
        barcode: row.barcode,
        productName: row.productName,
        quantity: row.quantity,
        unitCost: row.unitCost,
        unitPrice: row.unitPrice,
      });

      salesGroup[groupKey].totalAmount += row.totalAmount;
    });

    const groupedSalesList = Object.values(salesGroup);
    console.log(`[Migration] Grouped into ${groupedSalesList.length} unique sales transactions.`);

    // 5. Insert Sales into Database
    await client.query('BEGIN');
    let insertedSalesCount = 0;
    let insertedItemsCount = 0;
    let skippedSalesCount = 0;

    for (let i = 0; i < groupedSalesList.length; i++) {
      const sale = groupedSalesList[i];
      
      // Idempotency check: see if a sale with exact same timestamp, origin, paymentMethod and totalAmount already exists
      const existing = await client.query(
        `SELECT id FROM sales 
         WHERE timestamp = $1 AND origin = $2 AND payment_method = $3 AND total_amount = $4`,
        [sale.timestamp, sale.origin, sale.paymentMethod, sale.totalAmount]
      );

      if (existing.rows.length > 0) {
        skippedSalesCount++;
        continue;
      }

      // Generate invoice number
      const year = sale.timestamp.getFullYear().toString().slice(-2);
      const seqStr = String(insertedSalesCount + 1).padStart(5, '0');
      const invoiceNumber = `VK-HIST-${year}-${seqStr}`;

      // Insert sale header
      const saleRes = await client.query(
        `INSERT INTO sales (timestamp, origin, payment_method, transaction_code, total_amount, delivery_tower, delivery_apartment, delivery_complex, notes, sale_type, invoice_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Venta Comercial', $10)
         RETURNING id`,
        [
          sale.timestamp,
          sale.origin,
          sale.paymentMethod,
          sale.transactionCode || null,
          sale.totalAmount,
          sale.tower || null,
          sale.apto || null,
          sale.complex || null,
          sale.notes || null,
          invoiceNumber
        ]
      );

      const saleId = saleRes.rows[0].id;
      insertedSalesCount++;

      // Insert sale items
      for (const item of sale.items) {
        await client.query(
          `INSERT INTO sale_items (sale_id, barcode, product_name, quantity, unit_cost, unit_price)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            saleId,
            item.barcode,
            item.productName,
            item.quantity,
            item.unitCost,
            item.unitPrice
          ]
        );
        insertedItemsCount++;
      }
    }

    await client.query('COMMIT');
    console.log(`\n[Migration Success]`);
    console.log(`- Inserted sales: ${insertedSalesCount}`);
    console.log(`- Inserted items: ${insertedItemsCount}`);
    console.log(`- Skipped (already existed): ${skippedSalesCount}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Migration Error] Process rolled back:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
