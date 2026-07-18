-- Migration 004: Add expiration_date to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS expiration_date DATE DEFAULT NULL;
