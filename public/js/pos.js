/**
 * POS Barcode Scanner & Shopping Cart Logic
 * 
 * Manages the interactive checkout flow. Scans barcodes, calculates quantities,
 * values, profit margins, updates local inventories, and commits transactions.
 */

const POS = {
  cart: [],
  currentOrigin: 'tienda', // tienda | Rappi | WhatsApp
  currentPaymentMethod: 'Efectivo', // Efectivo | Nequi | Bancolombia | TC

  init() {
    this.setupListeners();
    this.renderCart();
  },

  setupListeners() {
    // Barcode scanner input handling
    const scanInput = document.getElementById('pos-scan-input');
    const scanForm = document.getElementById('pos-scan-form');
    
    if (scanForm && scanInput) {
      scanForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const barcode = scanInput.value.trim();
        if (barcode) {
          await this.scanProduct(barcode);
          scanInput.value = '';
          scanInput.focus();
        }
      });
    }

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
  async scanProduct(barcode) {
    try {
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
          <td class="text-right">$${item.unit_price.toFixed(2)}</td>
          <td>
            <div class="quantity-control">
              <button class="qty-btn" onclick="POS.updateQuantity('${item.barcode}', ${item.quantity - 1})">-</button>
              <input type="number" class="qty-input" value="${item.quantity}" min="1" 
                     onchange="POS.updateQuantity('${item.barcode}', this.value)">
              <button class="qty-btn" onclick="POS.updateQuantity('${item.barcode}', ${item.quantity + 1})">+</button>
            </div>
          </td>
          <td class="text-right font-medium">$${linePrice.toFixed(2)}</td>
          <td class="text-right text-success font-medium">$${(linePrice - lineCost).toFixed(2)}</td>
          <td class="text-center">
            <button class="btn-icon delete" onclick="POS.removeItem('${item.barcode}')">
              <span class="material-icons-outlined">delete_outline</span>
            </button>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
    summaryTotal.innerText = `$${totalPrice.toFixed(2)}`;
    summaryItems.innerText = totalQty;
    if (summaryProfit) {
      const profit = totalPrice - totalCost;
      summaryProfit.innerText = `$${profit.toFixed(2)}`;
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

    const totalAmount = this.cart.reduce((acc, item) => acc + (item.unit_price * item.quantity), 0);

    const saleRecord = {
      timestamp: new Date().toISOString(),
      origin: this.currentOrigin,
      payment_method: this.currentPaymentMethod,
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

    try {
      // 1. Transactionally write sale and adjust local stock in Dexie
      await db.transaction('rw', db.sales, db.products, async () => {
        // Save sale header (generates auto local_id)
        const localId = await db.sales.add(saleRecord);
        
        // Update local stock for each product
        for (const item of saleRecord.items) {
          const product = await db.products.get(item.barcode);
          if (product) {
            const currentStock = parseInt(product.stock) || 0;
            const newStock = Math.max(0, currentStock - item.quantity);
            await db.products.update(item.barcode, { stock: newStock });
          }
        }
        
        console.log(`[POS] Sale saved locally with local_id ${localId} ✓`);
      });

      // 2. Play checkout success sound & notify user
      this.playBeep(true);
      this.showToast('Sale registered successfully!', 'success');

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
    ['delivery-tower', 'delivery-apartment', 'delivery-complex', 'delivery-notes', 'transaction-code'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
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
  }
};
