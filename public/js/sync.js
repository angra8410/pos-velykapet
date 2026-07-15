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

  // Perform bulk sync of unsynced transactions
  async runSync() {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.updateUIStatus();

    try {
      // Find all sales marked as unsynced
      const unsyncedSales = await db.sales.where('synced').equals(0).toArray();
      
      if (unsyncedSales.length === 0) {
        console.log('[Sync] Database is fully synchronized ✓');
        this.isSyncing = false;
        this.updateUIStatus();
        return;
      }

      console.log(`[Sync] Pushing ${unsyncedSales.length} transaction(s) to server...`);
      
      // Call sync endpoint
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
      // Check if there are any remaining unsynced items
      db.sales.where('synced').equals(0).count().then(count => {
        if (count > 0) {
          statusEl.className = 'status-badge pending';
          statusTextEl.innerText = `${count} pending sync`;
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
