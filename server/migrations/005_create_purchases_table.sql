-- =============================================================
-- POS VelyKaPet — Create Purchases Table
-- =============================================================

CREATE TABLE IF NOT EXISTS purchases (
    id                  SERIAL PRIMARY KEY,
    local_id            INT,                    -- IndexedDB local ID for sync
    timestamp           TIMESTAMP NOT NULL,
    barcode             VARCHAR(100) NOT NULL REFERENCES master_catalog (barcode) ON DELETE CASCADE,
    supplier            VARCHAR(150),
    quantity            INT NOT NULL,
    cost_price          NUMERIC(12, 2) NOT NULL,
    total_price         NUMERIC(12, 2) NOT NULL,
    status              VARCHAR(100) DEFAULT 'Disponible',
    lot_reference       VARCHAR(150),
    notes               TEXT,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_purchases_timestamp ON purchases (timestamp);
CREATE INDEX IF NOT EXISTS idx_purchases_barcode   ON purchases (barcode);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier  ON purchases (supplier);
CREATE INDEX IF NOT EXISTS idx_purchases_local_id  ON purchases (local_id);
