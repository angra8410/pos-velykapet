/**
 * POS Barcode Scanner & Shopping Cart Logic
 * 
 * Manages the interactive checkout flow. Scans barcodes, calculates quantities,
 * values, profit margins, updates local inventories, and commits transactions.
 */

const POS = {
  cart: [],
  currentOrigin: 'tienda', // tienda | Rappi | WhatsApp
  currentPaymentMethod: 'Breb-B', // Breb-B | Efectivo(Cash) | Bancolombia | Tarjeta Credito(TC)

  init() {
    this.setupListeners();
    this.renderCart();
    this.setupSearchLookup();
  },

  setupListeners() {
    // Barcode scanner input handling
    const scanInput = document.getElementById('pos-scan-input');
    const scanForm = document.getElementById('pos-scan-form');
    
    if (scanForm && scanInput) {
      scanForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const barcode = dbHelper.normalizeBarcode(scanInput.value);
        if (barcode) {
          await this.scanProduct(barcode);
          scanInput.value = '';
          scanInput.focus();
        }
      });
    }

    // Hotkey listener for F2 key to trigger price lookup
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F2') {
        e.preventDefault();
        this.openPriceLookupModal();
      }
    });

    // Origin selector change
    const originSelect = document.getElementById('pos-origin-select');
    if (originSelect) {
      originSelect.addEventListener('change', (e) => {
        this.currentOrigin = e.target.value;
        this.recalculatePrices();
      });
    }

    // Payment method selector change
    const paymentSelect = document.getElementById('pos-payment-select');
    if (paymentSelect) {
      paymentSelect.addEventListener('change', (e) => {
        this.currentPaymentMethod = e.target.value;
      });
    }

    // Checkout form submission
    const checkoutBtn = document.getElementById('pos-checkout-btn');
    if (checkoutBtn) {
      checkoutBtn.addEventListener('click', () => this.checkout());
    }

    // Clear cart button
    const clearBtn = document.getElementById('pos-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.cart = [];
        this.renderCart();
      });
    }
  },

  // Lookup and add product via barcode scan
  async scanProduct(originalBarcode) {
    try {
      const barcode = dbHelper.normalizeBarcode(originalBarcode);
      const product = await dbHelper.getProductByBarcode(barcode);
      
      if (!product) {
        this.showToast(`Barcode ${barcode} not found in catalog!`, 'error');
        this.playBeep(false);
        return;
      }

      // Determine price based on channel
      const price = this.getChannelPrice(product);

      // Check if product is already in cart
      const existingItem = this.cart.find(item => item.barcode === barcode);
      if (existingItem) {
        existingItem.quantity += 1;
      } else {
        this.cart.push({
          barcode: product.barcode,
          product_name: product.product_name,
          category: product.category,
          supplier: product.supplier,
          cost_price: product.cost_price,
          sale_price: product.sale_price,
          rappi_price: product.rappi_price,
          unit_price: price, // Active price
          quantity: 1
        });
      }

      this.playBeep(true);
      this.renderCart();
      this.showToast(`Added: ${product.product_name}`, 'success');
    } catch (err) {
      console.error('[POS] Scan error:', err);
      this.showToast('Scan lookup error', 'error');
    }
  },

  // Helper to determine the retail price based on the selected channel
  getChannelPrice(item) {
    if (this.currentOrigin === 'Rappi') {
      return Number(item.rappi_price) || Number(item.sale_price);
    }
    return Number(item.sale_price);
  },

  // Recalculate price of cart items if origin channel changes
  recalculatePrices() {
    this.cart.forEach(item => {
      item.unit_price = this.getChannelPrice(item);
    });
    this.renderCart();
  },

  // Change quantity manually
  updateQuantity(barcode, newQty) {
    const item = this.cart.find(item => item.barcode === barcode);
    if (item) {
      item.quantity = Math.max(1, parseInt(newQty) || 1);
      this.renderCart();
    }
  },

  // Change price manually
  updatePrice(barcode, newPrice) {
    const item = this.cart.find(item => item.barcode === barcode);
    if (item) {
      const parsedPrice = parseFloat(newPrice);
      item.unit_price = isNaN(parsedPrice) || parsedPrice < 0 ? 0 : parsedPrice;
      this.renderCart();
    }
  },

  // Remove item from cart
  removeItem(barcode) {
    this.cart = this.cart.filter(item => item.barcode !== barcode);
    this.renderCart();
    this.showToast('Item removed', 'info');
  },

  // Calculate totals and render HTML
  renderCart() {
    const tbody = document.getElementById('cart-items-tbody');
    const summaryTotal = document.getElementById('cart-total-amount');
    const summaryItems = document.getElementById('cart-total-items');
    const summaryProfit = document.getElementById('cart-total-profit');

    if (!tbody) return;

    if (this.cart.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="empty-cart-message">
            <span class="material-icons-outlined">qr_code_scanner</span>
            <p>Scan a barcode or type it to add items</p>
          </td>
        </tr>
      `;
      summaryTotal.innerText = '$0.00';
      summaryItems.innerText = '0';
      if (summaryProfit) summaryProfit.innerText = '$0.00';
      return;
    }

    let html = '';
    let totalCost = 0;
    let totalPrice = 0;
    let totalQty = 0;

    this.cart.forEach(item => {
      const lineCost = item.cost_price * item.quantity;
      const linePrice = item.unit_price * item.quantity;
      totalCost += lineCost;
      totalPrice += linePrice;
      totalQty += item.quantity;

      html += `
        <tr class="cart-row">
          <td>
            <div class="product-title">${item.product_name}</div>
            <div class="product-subtitle">${item.barcode} | ${item.supplier}</div>
          </td>
          <td class="text-right">
            <input type="number" class="price-input" value="${item.unit_price}" min="0" step="0.01"
                   style="width: 100px; text-align: right; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 4px 8px; color: var(--text-main); font-size: 13px;"
                   onchange="POS.updatePrice('${item.barcode}', this.value)">
          </td>
          <td>
            <div class="quantity-control">
              <button class="qty-btn" onclick="POS.updateQuantity('${item.barcode}', ${item.quantity - 1})">-</button>
              <input type="number" class="qty-input" value="${item.quantity}" min="1" 
                     onchange="POS.updateQuantity('${item.barcode}', this.value)">
              <button class="qty-btn" onclick="POS.updateQuantity('${item.barcode}', ${item.quantity + 1})">+</button>
            </div>
          </td>
          <td class="text-right font-medium">${dbHelper.formatCOP(linePrice)}</td>
          <td class="text-right text-success font-medium">${dbHelper.formatCOP(linePrice - lineCost)}</td>
          <td class="text-center">
            <button class="btn-icon delete" onclick="POS.removeItem('${item.barcode}')">
              <span class="material-icons-outlined">delete_outline</span>
            </button>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
    summaryTotal.innerText = dbHelper.formatCOP(totalPrice);
    summaryItems.innerText = totalQty;
    if (summaryProfit) {
      const profit = totalPrice - totalCost;
      summaryProfit.innerText = dbHelper.formatCOP(profit);
    }
  },

  // Finalize sale: save to Dexie, update local stock, trigger sync
  async checkout() {
    if (this.cart.length === 0) {
      this.showToast('Cart is empty!', 'error');
      return;
    }

    const deliveryTower = document.getElementById('delivery-tower')?.value.trim() || null;
    const deliveryApartment = document.getElementById('delivery-apartment')?.value.trim() || null;
    const deliveryComplex = document.getElementById('delivery-complex')?.value.trim() || null;
    const notes = document.getElementById('delivery-notes')?.value.trim() || null;
    const transactionCode = document.getElementById('transaction-code')?.value.trim() || null;
    
    const saleTypeSelect = document.getElementById('pos-sale-type-select');
    const saleType = saleTypeSelect ? saleTypeSelect.value : 'Venta Comercial';

    const totalAmount = this.cart.reduce((acc, item) => acc + (item.unit_price * item.quantity), 0);

    const saleRecord = {
      timestamp: new Date().toISOString(),
      origin: this.currentOrigin,
      payment_method: this.currentPaymentMethod,
      sale_type: saleType,
      transaction_code: transactionCode,
      total_amount: totalAmount,
      delivery_tower: deliveryTower,
      delivery_apartment: deliveryApartment,
      delivery_complex: deliveryComplex,
      notes: notes,
      synced: 0, // Mark unsynced for SyncEngine
      items: this.cart.map(item => ({
        barcode: item.barcode,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_cost: item.cost_price,
        unit_price: item.unit_price
      }))
    };

    let localId;
    try {
      // 1. Transactionally write sale and adjust local stock in Dexie
      await db.transaction('rw', db.sales, db.products, async () => {
        // Save sale header (generates auto local_id)
        localId = await db.sales.add(saleRecord);
        
        // Generate structured invoice number
        const year = new Date(saleRecord.timestamp).getFullYear().toString().slice(-2);
        const deviceId = localStorage.getItem('pos_device_id') || '1';
        const seq = String(localId).padStart(5, '0');
        const invoiceNum = `VK${year}${deviceId}${seq}`;
        
        await db.sales.update(localId, { invoice_number: invoiceNum });
        saleRecord.invoice_number = invoiceNum; // set on object in memory for receipt print
        
        // Update local stock for each product
        for (const item of saleRecord.items) {
          const product = await db.products.get(item.barcode);
          if (product) {
            const currentStock = parseInt(product.stock) || 0;
            const newStock = Math.max(0, currentStock - item.quantity);
            await db.products.update(item.barcode, { stock: newStock });
          }
        }
        
        console.log(`[POS] Sale saved locally with invoice_number ${invoiceNum} ✓`);
      });

      // 2. Play checkout success sound & notify user with receipt option
      this.playBeep(true);
      this.showCheckoutSuccessToast(saleRecord, localId);

      // 3. Clear cart & inputs
      this.cart = [];
      this.renderCart();
      this.clearInputs();

      // 4. Force trigger background sync to PostgreSQL
      SyncEngine.runSync().catch(console.error);

    } catch (err) {
      console.error('[POS] Checkout failed:', err);
      this.showToast('Checkout failed, transaction rolled back.', 'error');
    }
  },

  clearInputs() {
    ['delivery-tower', 'delivery-apartment', 'delivery-notes', 'transaction-code'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    
    // Reset select dropdowns
    const complex = document.getElementById('delivery-complex');
    if (complex) complex.selectedIndex = 0;

    const saleType = document.getElementById('pos-sale-type-select');
    if (saleType) saleType.selectedIndex = 0;

    const payment = document.getElementById('pos-payment-select');
    if (payment) {
      payment.selectedIndex = 0;
      this.currentPaymentMethod = payment.value;
    }

    const origin = document.getElementById('pos-origin-select');
    if (origin) {
      origin.selectedIndex = 0;
      this.currentOrigin = origin.value;
    }
  },

  // Feedback notifications
  showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <span class="toast-message">${msg}</span>
    `;
    container.appendChild(toast);
    
    // Auto-remove toast after 3s
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },

  // Audio cues for barcode scanner feedback
  playBeep(success = true) {
    try {
      const context = new (window.AudioContext || window.webkitAudioContext)();
      const osc = context.createOscillator();
      const gain = context.createGain();
      
      osc.connect(gain);
      gain.connect(context.destination);
      
      if (success) {
        osc.frequency.value = 1000;
        gain.gain.setValueAtTime(0.1, context.currentTime);
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.1);
        osc.stop(context.currentTime + 0.1);
      } else {
        osc.frequency.value = 300;
        gain.gain.setValueAtTime(0.25, context.currentTime);
        osc.start();
        gain.gain.exponentialRampToValueAtTime(0.01, context.currentTime + 0.35);
        osc.stop(context.currentTime + 0.35);
      }
    } catch (e) {
      // Audio context might be blocked by browser autoplay policies
      console.log('Audio feedback skipped');
    }
  },

  // Search autocomplete lookup by name
  async setupSearchLookup() {
    const searchInput = document.getElementById('pos-search-input');
    const dropdown = document.getElementById('pos-search-dropdown');
    if (!searchInput || !dropdown) return;

    searchInput.addEventListener('input', async () => {
      const query = searchInput.value.trim().toLowerCase();
      if (query.length < 2) {
        dropdown.innerHTML = '';
        dropdown.classList.add('hidden');
        return;
      }

      // Query local Dexie catalog
      const catalogMatches = await db.master_catalog
        .filter(item => item.product_name.toLowerCase().includes(query))
        .limit(10)
        .toArray();

      if (catalogMatches.length === 0) {
        dropdown.innerHTML = '<div class="search-item" style="cursor: default; color: var(--text-muted);">No products found</div>';
        dropdown.classList.remove('hidden');
        return;
      }

      let html = '';
      for (const match of catalogMatches) {
        // Fetch price and stock from products table
        const product = await db.products.get(match.barcode);
        
        const price = product ? this.getChannelPrice(product) : 0;
        const stock = product ? (product.stock || 0) : 0;

        html += `
          <div class="search-item" data-barcode="${match.barcode}">
            <div class="item-name">${match.product_name}</div>
            <div class="item-meta">
              <span>Barcode: ${match.barcode}</span>
              <span>Stock: ${stock} | Price: ${dbHelper.formatCOP(price)}</span>
            </div>
          </div>
        `;
      }

      dropdown.innerHTML = html;
      dropdown.classList.remove('hidden');

      // Bind click handlers to search items
      dropdown.querySelectorAll('.search-item').forEach(el => {
        el.addEventListener('click', async () => {
          const barcode = el.getAttribute('data-barcode');
          if (barcode) {
            await this.scanProduct(barcode);
            searchInput.value = '';
            dropdown.classList.add('hidden');
            searchInput.focus();
          }
        });
      });
    });

    // Hide dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });
  },

  // Dynamic success toast with Print Receipt button
  showCheckoutSuccessToast(saleRecord, localId) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast success';
    toast.style.width = '350px';
    toast.style.flexDirection = 'column';
    toast.style.alignItems = 'stretch';
    toast.style.gap = '10px';
    
    const printRecord = { ...saleRecord, local_id: localId };

    toast.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
        <span class="toast-message" style="font-weight: 600;">Sale registered successfully!</span>
        <span class="material-icons-outlined" style="cursor: pointer; font-size: 18px;" onclick="this.closest('.toast').remove()">close</span>
      </div>
      <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px;">
        <button id="toast-print-btn" class="btn-primary" style="padding: 6px 12px; font-size: 12px; height: auto; border-radius: 4px; display: flex; align-items: center; gap: 6px; cursor: pointer; width: auto; background-color: var(--color-success); border: none;">
          <span class="material-icons-outlined" style="font-size: 14px;">print</span>
          <span>Print Receipt</span>
        </button>
      </div>
    `;
    
    container.appendChild(toast);
    
    toast.querySelector('#toast-print-btn').addEventListener('click', () => {
      this.printReceipt(printRecord);
    });

    // Auto-remove after 8s
    setTimeout(() => {
      if (toast.parentNode) {
        toast.classList.add('fade-out');
        setTimeout(() => toast.remove(), 300);
      }
    }, 8000);
  },

  // 80mm thermal receipt generator via hidden iframe
  printReceipt(sale) {
    let iframe = document.getElementById('print-iframe');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.id = 'print-iframe';
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = 'none';
      document.body.appendChild(iframe);
    }

    const doc = iframe.contentWindow.document;
    doc.open();

    const itemsHtml = sale.items.map(item => {
      const lineTotal = item.unit_price * item.quantity;
      return `
        <tr>
          <td style="padding: 6px 4px; vertical-align: top; text-align: left;">${item.product_name}<br/><span style="font-size: 9px; color: #555;">${item.barcode}</span></td>
          <td style="padding: 6px 4px; text-align: center; vertical-align: top;">${item.quantity}</td>
          <td style="padding: 6px 4px; text-align: right; vertical-align: top;">${dbHelper.formatCOP(item.unit_price)}</td>
          <td style="padding: 6px 4px; text-align: right; vertical-align: top;">${dbHelper.formatCOP(lineTotal)}</td>
        </tr>
      `;
    }).join('');

    const formattedDate = new Date(sale.timestamp).toLocaleString();
    const deliveryInfo = sale.delivery_apartment 
      ? `
        <div style="border-top: 1px dashed #000; padding-top: 6px; margin-top: 6px; font-size: 12px;">
          <strong>Entrega Domicilio:</strong><br/>
          Conjunto: ${sale.delivery_complex || 'N/A'}<br/>
          Torre: ${sale.delivery_tower || 'N/A'} - Apto: ${sale.delivery_apartment}<br/>
          ${sale.notes ? `Notas: ${sale.notes}` : ''}
        </div>
      `
      : '';

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${sale.invoice_number || `Ticket_L-${sale.local_id}`}</title>
        <style>
          @page {
            size: auto;
            margin: 0mm;
          }
          body {
            font-family: 'Courier New', Courier, monospace;
            width: 80mm;
            margin: 0;
            padding: 10px;
            font-size: 13px;
            color: #000;
            line-height: 1.3;
          }
          .header {
            text-align: center;
            margin-bottom: 12px;
          }
          .header h2 {
            margin: 0 0 4px 0;
            font-size: 18px;
            font-weight: bold;
          }
          .info-table {
            width: 100%;
            font-size: 12px;
            margin-bottom: 10px;
          }
          .items-table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 10px;
          }
          .items-table th {
            border-bottom: 1px solid #000;
            border-top: 1px solid #000;
            padding: 4px 0;
            font-size: 11px;
            text-align: left;
          }
          .totals-table {
            width: 100%;
            margin-top: 6px;
            border-top: 1px double #000;
            padding-top: 6px;
          }
          .text-right { text-align: right; }
          .text-center { text-align: center; }
          .divider { border-top: 1px dashed #000; margin: 8px 0; }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>VELYKAPET</h2>
          <div style="font-size: 11px;">POS & Inventory System</div>
          <div style="font-size: 11px;">Consintiendo a tu Mascota</div>
        </div>

        <table class="info-table">
          <tr>
            <td>Fecha:</td>
            <td class="text-right">${formattedDate}</td>
          </tr>
          <tr>
            <td>Origen:</td>
            <td class="text-right">${String(sale.origin).toUpperCase()}</td>
          </tr>
          <tr>
            <td>Pago:</td>
            <td class="text-right">${sale.payment_method}</td>
          </tr>
          ${sale.transaction_code ? `<tr><td>Ref:</td><td class="text-right">${sale.transaction_code}</td></tr>` : ''}
          <tr>
            <td>Factura Nro:</td>
            <td class="text-right">${sale.invoice_number || `#L-${sale.local_id}`}</td>
          </tr>
        </table>

        <table class="items-table">
          <thead>
            <tr>
              <th style="width: 40%; text-align: left; padding: 6px 4px;">Producto</th>
              <th style="width: 12%; text-align: center; padding: 6px 4px;">Cant</th>
              <th style="width: 24%; text-align: right; padding: 6px 4px;">Precio</th>
              <th style="width: 24%; text-align: right; padding: 6px 4px;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <table class="totals-table">
          <tr>
            <td style="font-weight: bold; padding: 6px 4px;">TOTAL:</td>
            <td class="text-right" style="font-weight: bold; font-size: 15px; padding: 6px 4px;">${dbHelper.formatCOP(sale.total_amount)}</td>
          </tr>
        </table>

        ${deliveryInfo}

        <div class="divider"></div>
        <div class="text-center" style="font-size: 11px; margin-top: 10px;">
          ¡Gracias por tu compra!<br/>
          VelyKaPet - Consintiendo a tu mascota
        </div>
      </body>
      </html>
    `;

    doc.write(htmlContent);
    doc.close();

    setTimeout(() => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    }, 250);
  },

  openPriceLookupModal() {
    const modal = document.getElementById('price-lookup-modal');
    const input = document.getElementById('price-lookup-input');
    const result = document.getElementById('price-lookup-result');
    if (!modal) return;
    
    // Reset lookup result
    if (result) result.classList.add('hidden');
    if (input) input.value = '';
    
    modal.classList.remove('hidden');
    setTimeout(() => {
      if (input) input.focus();
    }, 100);
  },

  closePriceLookupModal() {
    const modal = document.getElementById('price-lookup-modal');
    if (modal) modal.classList.add('hidden');
    
    // Focus back on POS barcode scanner input
    const posInput = document.getElementById('pos-scan-input');
    if (posInput) posInput.focus();
  },

  async handlePriceLookupSubmit(event) {
    event.preventDefault();
    const input = document.getElementById('price-lookup-input');
    if (!input) return;
    const barcode = dbHelper.normalizeBarcode(input.value);
    if (barcode) {
      await this.lookupProductPrice(barcode);
    }
  },

  async lookupProductPrice(barcode) {
    const resultDiv = document.getElementById('price-lookup-result');
    if (!resultDiv) return;

    try {
      const product = await dbHelper.getProductByBarcode(barcode);
      if (!product) {
        this.showToast(`Product with barcode ${barcode} not found!`, 'error');
        this.playBeep(false);
        resultDiv.classList.add('hidden');
        return;
      }

      this.playBeep(true);
      
      // Update result details
      document.getElementById('lookup-res-name').innerText = product.product_name;
      document.getElementById('lookup-res-barcode').innerText = `Barcode: ${product.barcode}`;
      document.getElementById('lookup-res-retail').innerText = dbHelper.formatCOP(product.sale_price);
      document.getElementById('lookup-res-rappi').innerText = dbHelper.formatCOP(product.rappi_price);
      
      // Stock
      const stock = product.stock || 0;
      const stockPill = document.getElementById('lookup-res-stock-pill');
      const stockText = document.getElementById('lookup-res-stock-text');
      
      stockPill.innerText = `${stock} units`;
      if (stock <= 0) {
        stockPill.className = 'stock-pill negative';
        stockText.innerText = 'Out of Stock';
      } else {
        stockPill.className = 'stock-pill positive';
        stockText.innerText = 'In Stock';
      }

      // Expiration Date
      const expVal = document.getElementById('lookup-res-expiration');
      if (product.expiration_date) {
        const formattedDate = new Date(product.expiration_date + 'T00:00:00').toLocaleDateString('es-CO', {
          day: '2-digit', month: '2-digit', year: 'numeric'
        });
        expVal.innerText = formattedDate;
        
        // Highlight if expired or near expiration
        const expDate = new Date(product.expiration_date + 'T00:00:00');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const timeDiff = expDate.getTime() - today.getTime();
        const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
        
        if (daysDiff < 0) {
          expVal.style.color = 'var(--color-danger)';
          expVal.innerText += ' (EXPIRED / VENCIDO)';
        } else if (daysDiff <= 30) {
          expVal.style.color = '#f59e0b'; // amber
          expVal.innerText += ` (Vence en ${daysDiff} días)`;
        } else {
          expVal.style.color = '';
        }
      } else {
        expVal.innerText = 'N/A';
        expVal.style.color = '';
      }

      // Add to Cart Button binding
      const addBtn = document.getElementById('lookup-add-to-cart-btn');
      // Recreate to clear previous event listeners
      const newAddBtn = addBtn.cloneNode(true);
      addBtn.replaceWith(newAddBtn);
      
      newAddBtn.addEventListener('click', async () => {
        await this.scanProduct(barcode);
        this.closePriceLookupModal();
      });

      resultDiv.classList.remove('hidden');
      
      // Clear input and focus it again so they can scan multiple items in a row
      const input = document.getElementById('price-lookup-input');
      if (input) {
        input.value = '';
        input.focus();
      }

    } catch (err) {
      console.error('[POS] Lookup error:', err);
      this.showToast('Error during price lookup', 'error');
    }
  }
};
