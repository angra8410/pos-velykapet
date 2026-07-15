-- Alter products table to enforce uniqueness on barcode.
-- This allows ON CONFLICT (barcode) upserts to work correctly.
ALTER TABLE products ADD CONSTRAINT unique_products_barcode UNIQUE (barcode);
