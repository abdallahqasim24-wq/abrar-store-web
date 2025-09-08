// db.js  — اتصال Postgres ومهام المايغريشن
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export const query = (text, params) => pool.query(text, params);

export async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      category TEXT,
      cost_price DOUBLE PRECISION NOT NULL,
      sale_price DOUBLE PRECISION NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      image_path TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL,
      sale_price DOUBLE PRECISION NOT NULL,
      cost_price DOUBLE PRECISION NOT NULL,
      coupon_value DOUBLE PRECISION DEFAULT 0,
      gift_value DOUBLE PRECISION DEFAULT 0,
      points_value DOUBLE PRECISION DEFAULT 0,
      shipping_cost DOUBLE PRECISION DEFAULT 0,
      note TEXT,
      sold_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='sales' AND column_name='points_value'
      ) THEN
        EXECUTE 'ALTER TABLE sales ADD COLUMN points_value DOUBLE PRECISION DEFAULT 0';
      END IF;
    END$$;
  `);
}

export async function initDb() {
  await pool.connect();
  await migrate();
  console.log('Postgres connected & migrated');
}
