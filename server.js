// ===[ 1) قراءة .env ]===
import dotenv from 'dotenv';
dotenv.config();

// ===[ 2) الاستيرادات ]===
import express from 'express';
import path from 'path';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { query, initDb } from './db.js';
import puppeteer from 'puppeteer';
import dayjs from 'dayjs';
import { fileURLToPath } from 'url';
import expressLayouts from 'express-ejs-layouts';
import basicAuth from 'express-basic-auth';

// ===[ 3) مسارات أساسية ]===
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ===[ 4) قاعدة البيانات ]===
await initDb();

// ===[ 5) Cloudinary + Multer ]===
cloudinary.config(process.env.CLOUDINARY_URL);

const storage = new CloudinaryStorage({
  cloudinary,
  params: async () => ({
    folder: 'abrar-shop',
    resource_type: 'image',
    public_id: `${Date.now()}-${Math.round(Math.random()*1e9)}`
  })
});
const upload = multer({ storage });

// ===== Views / Layout =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Font Awesome للواجهات
app.use((req, res, next) => {
  res.locals.faLink = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css";
  next();
});

// ===== Health check =====
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// ===== Basic Auth =====
const authUsers = { 'abrar': '1143' };
const authMw = basicAuth({
  users: authUsers,
  challenge: true,
  unauthorizedResponse: () => 'Unauthorized'
});
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  return authMw(req, res, next);
});

// ===== Parsers & Static =====
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { res.locals.currentPath = req.path; next(); });

// ===== Helpers =====
// الربح = (سعر البيع × الكمية) − (السعر الأصلي × الكمية) − الشحن (الشحن مرة لكل الطلب)
const profitOf = (s) =>
  (Number(s.sale_price) * Number(s.quantity))
  - (Number(s.cost_price) * Number(s.quantity))
  - Number(s.shipping_cost || 0);

async function stats() {
  const t = await query(`
    SELECT
      COUNT(*)::int                               AS products_count,
      COALESCE(SUM(stock),0)::int                 AS total_units,
      COALESCE(SUM(stock*cost_price),0)::float8   AS total_cost_value,
      COALESCE(SUM(stock*sale_price),0)::float8   AS total_sale_value
    FROM products
  `);

  const today = dayjs().format('YYYY-MM-DD');
  const month = dayjs().format('YYYY-MM');

  const todayRows = (await query(`SELECT * FROM sales WHERE DATE(sold_at)=DATE($1)`, [today])).rows;
  const monthRows = (await query(`SELECT * FROM sales WHERE TO_CHAR(sold_at,'YYYY-MM')=$1`, [month])).rows;

  const rev  = (rows) => rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const prof = (rows) => rows.reduce((a, s) => a + profitOf(s), 0);

  return {
    ...t.rows[0],
    today_revenue: rev(todayRows),
    today_profit : prof(todayRows),
    month_revenue: rev(monthRows),
    month_profit : prof(monthRows)
  };
}

// ====================== Routes ======================

// ---------- Home ----------
app.get('/', async (_req, res) => {
  const s = await stats();
  const byCat   = (await query(`
    SELECT p.category AS label,
           COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS value
    FROM products p
    LEFT JOIN sales s ON s.product_id = p.id
    GROUP BY p.category
    ORDER BY value DESC
  `)).rows;

  const lowStock = (await query(`SELECT * FROM products WHERE stock<=$1 ORDER BY stock ASC LIMIT 8`, [5])).rows;

  const lastSales = (await query(`
    SELECT s.*, p.name AS product_name
    FROM sales s JOIN products p ON p.id = s.product_id
    ORDER BY s.sold_at DESC LIMIT 8
  `)).rows;

  res.render('index', { stats: s, byCat, lowStock, lastSales, dayjs });
});

// ---------- Products ----------
app.get('/products', async (_req, res) => {
  const products = (await query(`SELECT * FROM products ORDER BY created_at DESC`)).rows;
  res.render('products', { products });
});

app.post('/products', upload.single('image'), async (req, res) => {
  const { name, brand, category, cost_price, sale_price, stock } = req.body;
  const image_path = req.file ? req.file.path : null;
  await query(`
    INSERT INTO products (name,brand,category,cost_price,sale_price,stock,image_path)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [name, brand || '', category || '', Number(cost_price), Number(sale_price), Number(stock || 0), image_path]);
  res.redirect('/products');
});

app.post('/products/:id/update', upload.single('image'), async (req, res) => {
  const id  = Number(req.params.id);
  const old = (await query(`SELECT * FROM products WHERE id=$1`, [id])).rows[0];
  if (!old) return res.redirect('/products');

  const { name, brand, category, cost_price, sale_price, stock } = req.body;
  const image_path = req.file ? req.file.path : old.image_path;

  await query(`
    UPDATE products
    SET name=$1, brand=$2, category=$3, cost_price=$4, sale_price=$5, stock=$6, image_path=$7
    WHERE id=$8
  `, [
    name || old.name, brand ?? old.brand, category ?? old.category,
    Number(cost_price ?? old.cost_price), Number(sale_price ?? old.sale_price),
    Number(stock ?? old.stock), image_path, id
  ]);

  res.redirect('/products');
});

// تعديل المخزون (+/-)
app.post('/products/:id/stock', async (req, res) => {
  const id = Number(req.params.id), delta = Number(req.body.delta || 0);
  await query(`UPDATE products SET stock = GREATEST(0, stock + $1) WHERE id=$2`, [delta, id]);
  res.redirect('/products');
});

// حذف مفرد
app.post('/products/:id/delete', async (req, res) => {
  await query(`DELETE FROM products WHERE id=$1`, [Number(req.params.id)]);
  res.redirect('/products');
});

// الحذف الجماعي للمنتجات
app.post('/products/bulk-delete', async (req, res) => {
  const ids = req.body.ids;
  const arr = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (arr.length) {
    await query(`DELETE FROM products WHERE id = ANY($1::int[])`, [arr]);
  }
  res.redirect('/products');
});

// ---------- Sales ----------
app.get('/sales', async (_req, res) => {
  const sales = (await query(`
    SELECT s.*,
           p.name AS product_name,
           p.image_path AS product_image   -- 👈 جِبْنا الصورة
    FROM sales s
    JOIN products p ON p.id = s.product_id
    ORDER BY s.sold_at DESC
  `)).rows;

  const products = (await query(`
    SELECT id, name, stock, cost_price, sale_price FROM products ORDER BY name
  `)).rows;

  res.render('sales', { sales, products, dayjs });
});
app.post('/sales', async (req, res) => {
  const { product_id, quantity, sale_price, cost_price, shipping_cost, note } = req.body;
  const prod = (await query(`SELECT * FROM products WHERE id=$1`, [Number(product_id)])).rows[0];
  if (!prod) return res.redirect('/sales');

  const qty = Math.max(1, Number(quantity || 1));
  await query(`UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id=$2`, [qty, prod.id]);

  await query(`
    INSERT INTO sales (product_id,quantity,sale_price,cost_price,shipping_cost,note)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [
    prod.id, qty,
    Number(sale_price || prod.sale_price), Number(cost_price || prod.cost_price),
    Number(shipping_cost || 0),
    note || ''
  ]);

  res.redirect('/sales');
});

// حذف مفرد للمبيعات (مع إعادة المخزون)
app.post('/sales/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  const s  = (await query(`SELECT * FROM sales WHERE id=$1`, [id])).rows[0];
  if (s) {
    await query(`UPDATE products SET stock = stock + $1 WHERE id=$2`, [s.quantity, s.product_id]);
    await query(`DELETE FROM sales WHERE id=$1`, [id]);
  }
  res.redirect('/sales');
});

// الحذف الجماعي للمبيعات (مع إعادة المخزون)
app.post('/sales/bulk-delete', async (req, res) => {
  const ids = req.body.ids || [];
  const arr = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (arr.length) {
    // استرجاع المخزون لكل عملية
    const rows = (await query(`SELECT id, product_id, quantity FROM sales WHERE id = ANY($1::int[])`, [arr])).rows;
    for (const r of rows) {
      await query(`UPDATE products SET stock = stock + $1 WHERE id=$2`, [r.quantity, r.product_id]);
    }
    await query(`DELETE FROM sales WHERE id = ANY($1::int[])`, [arr]);
  }
  res.redirect('/sales');
});

// ---------- Reports (HTML) ----------
app.get('/reports', async (req, res) => {
  const { range = 'daily', date } = req.query;
  let rows = [], title = '';

  if (range === 'monthly') {
    const ym = date || dayjs().format('YYYY-MM');
    title = `تقرير شهري ${ym}`;
    rows  = (await query(`
      SELECT s.*, p.name AS product_name
      FROM sales s JOIN products p ON p.id = s.product_id
      WHERE TO_CHAR(s.sold_at,'YYYY-MM') = $1
      ORDER BY s.sold_at DESC
    `, [ym])).rows;
  } else {
    const d = date || dayjs().format('YYYY-MM-DD');
    title = `تقرير يومي ${d}`;
    rows  = (await query(`
      SELECT s.*, p.name AS product_name
      FROM sales s JOIN products p ON p.id = s.product_id
      WHERE DATE(s.sold_at) = DATE($1)
      ORDER BY s.sold_at DESC
    `, [d])).rows;
  }

  const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const totalProfit  = rows.reduce((a, s) => a + profitOf(s), 0);
  res.render('reports', { rows, title, totalRevenue, totalProfit, range, date, dayjs });
});

// ---------- Reports (PDF) ----------
// ---------- Reports (PDF) ----------
app.get('/reports/pdf', async (req, res) => {
  try {
    const { range = 'daily', date } = req.query;
    let rows = [], title = '';

    if (range === 'monthly') {
      const ym = date || dayjs().format('YYYY-MM');
      title = `تقرير مبيعات شهري ${ym}`;
      rows = (await query(`
        SELECT s.*, p.name AS product_name
        FROM sales s JOIN products p ON p.id=s.product_id
        WHERE TO_CHAR(s.sold_at,'YYYY-MM')=$1
        ORDER BY s.sold_at DESC
      `, [ym])).rows;
    } else {
      const d = date || dayjs().format('YYYY-MM-DD');
      title = `تقرير مبيعات يومي ${d}`;
      rows = (await query(`
        SELECT s.*, p.name AS product_name
        FROM sales s JOIN products p ON p.id=s.product_id
        WHERE DATE(s.sold_at)=DATE($1)
        ORDER BY s.sold_at DESC
      `, [d])).rows;
    }

    const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
    const totalProfit  = rows.reduce((a, s) => a + profitOf(s), 0);

    const html = await new Promise((resolve, reject) => {
      req.app.render('report-pdf', { rows, title, totalRevenue, totalProfit, dayjs }, (err, str) => {
        if (err) reject(err); else resolve(str);
      });
    });

    // 🔹 هنا التعديل
    if (!process.env.PUPPETEER_CACHE_DIR) {
      process.env.PUPPETEER_CACHE_DIR = '/opt/render/.cache/puppeteer';
    }

    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="report.pdf"');
    res.end(pdf);

  } catch (err) {
    console.error('PDF error:', err);
    res.status(500).send('PDF generation failed');
  }
});


// ---------- Seed ----------
app.get('/dev/seed', async (_req, res) => {
  const items = [
    ['Lipstick Ruby', 'BrandX', 'Makeup', 10, 20, 25, null],
    ['Face Cream', 'CareCo', 'Skincare', 15, 35, 15, null],
    ['Mascara Pro', 'BrandY', 'Makeup', 8, 18, 30, null]
  ];
  await Promise.all(items.map(it =>
    query(`INSERT INTO products (name,brand,category,cost_price,sale_price,stock,image_path) VALUES ($1,$2,$3,$4,$5,$6,$7)`, it)
  ));
  res.json({ inserted: items.length });
});

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
