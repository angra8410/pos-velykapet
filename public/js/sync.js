/**
 * Background synchronization engine
 * 
 * Manages periodic and event-driven data sync from IndexedDB to the PostgreSQL backend.
 * Listens to network status changes and triggers sync automatically when online.
 */

const SyncEngine = {
  isSyncing: false,
  onlineStatus: navigator.onLine,

  // Initialize sync engine events
  init() {
    window.addEventListener('online', () => this.handleNetworkChange(true));
    window.addEventListener('offline', () => this.handleNetworkChange(false));
    
    // Periodically attempt sync every 30 seconds if online
    setInterval(() => {
      if (this.onlineStatus && !this.isSyncing) {
        this.runSync().catch(console.error);
      }
    }, 30000);
    
    this.updateUIStatus();
    // Initial sync run on startup
    if (this.onlineStatus) {
      this.runSync().catch(console.error);
    }
  },

  // Handle browser online/offline events
  handleNetworkChange(isOnline) {
    this.onlineStatus = isOnline;
    console.log(`[Sync] Browser is now ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
    this.updateUIStatus();
    if (isOnline) {
      this.runSync().catch(console.error);
    }
  },

  // Perform bulk sync of unsynced transactions and expenses
  async runSync() {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.updateUIStatus();

    try {
      // 1. Sync Sales
      const unsyncedSales = await db.sales.where('synced').equals(0).toArray();
      if (unsyncedSales.length > 0) {
        console.log(`[Sync] Pushing ${unsyncedSales.length} transaction(s) to server...`);
        const result = await api.syncSales(unsyncedSales);
        
        // Update local IndexedDB records to synced = 1 based on API response
        if (result && result.results) {
          await db.transaction('rw', db.sales, async () => {
            for (const item of result.results) {
              if (item.status === 'synced' || item.status === 'skipped') {
                await db.sales.update(item.local_id, { synced: 1 });
              }
            }
          });
          console.log(`[Sync] Successfully synchronized ${unsyncedSales.length} transaction(s) ✓`);
        }
      }

      // 2. Sync Expenses
      const unsyncedExpenses = await db.expenses.where('synced').equals(0).toArray();
      if (unsyncedExpenses.length > 0) {
        console.log(`[Sync] Pushing ${unsyncedExpenses.length} expense entry(ies) to server...`);
        const payload = unsyncedExpenses.map(({ local_id, synced, ...rest }) => rest);
        const result = await api.importExpensesBulk(payload);
        if (result && result.success) {
          await db.transaction('rw', db.expenses, async () => {
            for (const exp of unsyncedExpenses) {
              await db.expenses.update(exp.local_id, { synced: 1 });
            }
          });
          console.log(`[Sync] Successfully synchronized ${unsyncedExpenses.length} expense(s) ✓`);
        }
      }

      console.log('[Sync] Database check complete ✓');
    } catch (err) {
      console.error('[Sync] Sync process failed:', err.message);
    } finally {
      this.isSyncing = false;
      this.updateUIStatus();
    }
  },

  // Update connection status indicators in the user interface
  updateUIStatus() {
    const statusEl = document.getElementById('sync-status-indicator');
    const statusTextEl = document.getElementById('sync-status-text');
    if (!statusEl) return;

    if (!this.onlineStatus) {
      statusEl.className = 'status-badge offline';
      statusTextEl.innerText = 'Offline (Saves locally)';
    } else if (this.isSyncing) {
      statusEl.className = 'status-badge syncing';
      statusTextEl.innerText = 'Syncing...';
    } else {
      // Check if there are any remaining unsynced sales or expenses
      Promise.all([
        db.sales.where('synced').equals(0).count(),
        db.expenses.where('synced').equals(0).count()
      ]).then(([salesCount, expensesCount]) => {
        const totalPending = salesCount + expensesCount;
        if (totalPending > 0) {
          statusEl.className = 'status-badge pending';
          statusTextEl.innerText = `${totalPending} pending sync`;
        } else {
          statusEl.className = 'status-badge synced';
          statusTextEl.innerText = 'Synced';
        }
      }).catch(() => {
        statusEl.className = 'status-badge synced';
        statusTextEl.innerText = 'Connected';
      });
    }
  }
};
