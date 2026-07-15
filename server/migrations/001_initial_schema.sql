-- =============================================================
-- POS VelyKaPet — Initial Schema Migration
-- Run this once in your Railway PostgreSQL instance.
-- =============================================================

-- ---------------------------------------------------------------
-- 1. Dimension Table: Master Catalog (from 'CODIGO DE BARRA')
--    Static lookup index: barcode → product name + category.
--    Imported once; updated only when the catalog changes.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_catalog (
    barcode       VARCHAR(100) PRIMARY KEY,
    product_name  VARCHAR(255) NOT NULL,
    category      VARCHAR(100) NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_catalog_barcode ON master_catalog (barcode);

-- ---------------------------------------------------------------
-- 2. Live Inventory State (from 'Inventario DEFINITIVO')
--    Volatile: cost, retail price, Rappi price, stock count.
--    References master_catalog so a barcode must exist first.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id            SERIAL PRIMARY KEY,
    barcode       VARCHAR(100) REFERENCES master_catalog (barcode) ON DELETE CASCADE,
    supplier      VARCHAR(150),
    cost_price    NUMERIC(12, 2) DEFAULT 0.00,
    sale_price    NUMERIC(12, 2) DEFAULT 0.00,
    rappi_price   NUMERIC(12, 2) DEFAULT 0.00,
    stock         INT DEFAULT 0,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_products_barcode ON products (barcode);

-- ---------------------------------------------------------------
-- 3. Sales Header Table (from 'VENTAS')
--    One row per completed transaction.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
    id                  SERIAL PRIMARY KEY,
    local_id            INT,                    -- Mirrors the browser IndexedDB auto-id for sync
    timestamp           TIMESTAMP NOT NULL,
    origin              VARCHAR(50) NOT NULL,   -- tienda | Rappi | WhatsApp
    payment_method      VARCHAR(50) NOT NULL,   -- Efectivo | Nequi | Bancolombia | TC
    transaction_code    VARCHAR(100),
    total_amount        NUMERIC(12, 2) NOT NULL,
    delivery_tower      VARCHAR(50),
    delivery_apartment  VARCHAR(50),
    delivery_complex    VARCHAR(150),
    notes               TEXT,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_timestamp   ON sales (timestamp);
CREATE INDEX IF NOT EXISTS idx_sales_origin      ON sales (origin);
CREATE INDEX IF NOT EXISTS idx_sales_local_id    ON sales (local_id);

-- ---------------------------------------------------------------
-- 4. Detailed Sale Items
--    One row per product line within a sale.
--    Computed columns (total_cost, total_price, profit) are
--    stored for direct Fabric BI consumption without re-joining.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_items (
    id            SERIAL PRIMARY KEY,
    sale_id       INT REFERENCES sales (id) ON DELETE CASCADE,
    barcode       VARCHAR(100) NOT NULL,
    product_name  VARCHAR(255) NOT NULL,
    quantity      INT NOT NULL,
    unit_cost     NUMERIC(12, 2) NOT NULL,
    unit_price    NUMERIC(12, 2) NOT NULL,
    total_cost    NUMERIC(12, 2) GENERATED ALWAYS AS (quantity * unit_cost)  STORED,
    total_price   NUMERIC(12, 2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
    profit        NUMERIC(12, 2) GENERATED ALWAYS AS ((quantity * unit_price) - (quantity * unit_cost)) STORED
);

CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_barcode  ON sale_items (barcode);
