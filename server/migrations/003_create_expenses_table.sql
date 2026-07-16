-- =============================================================
-- POS VelyKaPet — Create Expenses Table
-- =============================================================

CREATE TABLE IF NOT EXISTS expenses (
    id                  SERIAL PRIMARY KEY,
    timestamp           TIMESTAMP NOT NULL,
    description         TEXT NOT NULL,
    category            VARCHAR(100) NOT NULL,
    payment_method      VARCHAR(50) NOT NULL,
    amount              NUMERIC(12, 2) NOT NULL,
    notes               TEXT,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_expenses_timestamp ON expenses (timestamp);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses (category);
