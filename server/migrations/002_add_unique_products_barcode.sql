-- Alter products table to enforce uniqueness on barcode.
-- This allows ON CONFLICT (barcode) upserts to work correctly.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.table_constraints 
        WHERE constraint_name = 'unique_products_barcode'
    ) THEN
        ALTER TABLE products ADD CONSTRAINT unique_products_barcode UNIQUE (barcode);
    END IF;
END;
$$;
