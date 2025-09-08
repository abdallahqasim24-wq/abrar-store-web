// ===[ 1) قراءة .env ]===
import dotenv from 'dotenv';
dotenv.config();

// ===[ 2) الاستيرادات ]===
import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { query, initDb } from './db.js';              // ← Postgres
import PDFDocument from 'pdfkit';
import puppeteer from 'puppeteer';
import dayjs from 'dayjs';
import { fileURLToPath } from 'url';
import expressLayouts from 'express-ejs-layouts';
import basicAuth from 'express-basic-auth';

// ===[ 3) تهيئة المسارات العامة للتطبيق ]===
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ===[ 4) تهيئة قاعدة البيانات (Postgres) ]===
await initDb(); // ينشئ الجداول الناقصة ويتأكد من الاتصال

// ===[ 5) إعداد Cloudinary للصور ]===
// Render يمرر CLOUDINARY_URL عبر المتغير البيئي (اللي أضفته أنت)
cloudinary.config(process.env.CLOUDINARY_URL);

// تخزين Multer على Cloudinary (بدل القرص المحلي)
const storage = new CloudinaryStorage({
  cloudinary,
  params: async () => ({
    folder: 'abrar-shop',                   // غيّر الاسم لو حاب
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

// ===== Health check (غير محمي) =====
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// ===== حماية Basic Auth =====
const authUsers = { 'abrar': '1143' }; // عدّلهم متى شئت
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

// متغير مفيد في القوالب
app.use((req, res, next) => { res.locals.currentPath = req.path; next(); });

// ===== Helpers =====
// الربح = (سعر البيع - الشحن) × الكمية
const profitOf = (s) =>
  (Number(s.sale_price) - Number(s.shipping_cost || 0)) * Number(s.quantity);

async function stats() {
  const t   = await query(`
    SELECT
      COUNT(*)::int                                      AS products_count,
      COALESCE(SUM(stock),0)::int                        AS total_units,
      COALESCE(SUM(stock*cost_price),0)::float8          AS total_cost_value,
      COALESCE(SUM(stock*sale_price),0)::float8          AS total_sale_value
    FROM products
  `);
  const today = dayjs().format('YYYY-MM-DD');
  const month = dayjs().format('YYYY-MM');

  const todayRows = (await query(`SELECT * FROM sales WHERE DATE(sold_at) = DATE($1)`, [today])).rows;
  const monthRows = (await query(`SELECT * FROM sales WHERE TO_CHAR(sold_at,'YYYY-MM') = $1`, [month])).rows;

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

// ===== Routes =====
app.get('/', async (req, res) => {
  const s = await stats();
  const byCat   = (await query(`
    SELECT p.category AS label,
           COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS value
    FROM products p
    LEFT JOIN sales s ON s.product_id = p.id
    GROUP BY p.category
    ORDER BY value DESC
  `)).rows;

  const lowStock = (await query(`
    SELECT * FROM products WHERE stock <= $1 ORDER BY stock ASC LIMIT 8
  `, [5])).rows;

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
  // Cloudinary يرجّع رابط الصورة في req.file.path
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

app.post('/products/:id/stock', async (req, res) => {
  const id = Number(req.params.id), delta = Number(req.body.delta || 0);
  await query(`UPDATE products SET stock = GREATEST(0, stock + $1) WHERE id=$2`, [delta, id]);
  res.redirect('/products');
});

app.post('/products/:id/delete', async (req, res) => {
  await query(`DELETE FROM products WHERE id=$1`, [Number(req.params.id)]);
  res.redirect('/products');
});

// ---------- Sales ----------
app.get('/sales', async (_req, res) => {
  const sales = (await query(`
    SELECT s.*, p.name AS product_name
    FROM sales s JOIN products p ON p.id = s.product_id
    ORDER BY s.sold_at DESC
  `)).rows;

  const products = (await query(`
    SELECT id,name,stock,cost_price,sale_price FROM products ORDER BY name
  `)).rows;

  res.render('sales', { sales, products, dayjs });
});

// ملاحظة: ما منستعمل (كوبون/هدية/نقاط) الآن — نسجلها بصفر فقط للحقل الموجود في الجدول
app.post('/sales', async (req, res) => {
  const { product_id, quantity, sale_price, cost_price, shipping_cost, note } = req.body;
  const prod = (await query(`SELECT * FROM products WHERE id=$1`, [Number(product_id)])).rows[0];
  if (!prod) return res.redirect('/sales');

  const qty = Math.max(1, Number(quantity || 1));
  await query(`UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id=$2`, [qty, prod.id]);

  await query(`
    INSERT INTO sales (product_id,quantity,sale_price,cost_price,coupon_value,gift_value,points_value,shipping_cost,note)
    VALUES ($1,$2,$3,$4, 0, 0, 0, $5, $6)
  `, [
    prod.id, qty,
    Number(sale_price || prod.sale_price), Number(cost_price || prod.cost_price),
    Number(shipping_cost || 0),
    note || ''
  ]);

  res.redirect('/sales');
});

app.post('/sales/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  const s  = (await query(`SELECT * FROM sales WHERE id=$1`, [id])).rows[0];
  if (s) {
    await query(`UPDATE products SET stock = stock + $1 WHERE id=$2`, [s.quantity, s.product_id]);
    await query(`DELETE FROM sales WHERE id=$1`, [id]);
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
      SELECT * FROM sales WHERE TO_CHAR(sold_at,'YYYY-MM') = $1 ORDER BY sold_at DESC
    `, [ym])).rows;
  } else {
    const d = date || dayjs().format('YYYY-MM-DD');
    title = `تقرير يومي ${d}`;
    rows  = (await query(`
      SELECT * FROM sales WHERE DATE(sold_at) = DATE($1) ORDER BY sold_at DESC
    `, [d])).rows;
  }

  const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const totalProfit  = rows.reduce((a, s) => a + profitOf(s), 0);
  res.render('reports', { rows, title, totalRevenue, totalProfit, range, date, dayjs });
});

// ---------- Reports (PDF via Puppeteer) ----------
// ---------- Reports (PDF via Puppeteer + PDFKit fallback) ----------
app.get('/reports/pdf', async (req, res) => {
  const { range = 'daily', date } = req.query;

  // 1) جهّز البيانات
  let rows = [], title = '';
  try {
    if (range === 'monthly') {
      const ym = date || dayjs().format('YYYY-MM');
      title = `تقرير مبيعات شهري ${ym}`;
      rows  = (await query(`
        SELECT s.*, p.name AS product_name
        FROM sales s JOIN products p ON p.id = s.product_id
        WHERE TO_CHAR(s.sold_at,'YYYY-MM') = $1
        ORDER BY s.sold_at DESC
      `, [ym])).rows;
    } else {
      const d = date || dayjs().format('YYYY-MM-DD');
      title = `تقرير مبيعات يومي ${d}`;
      rows  = (await query(`
        SELECT s.*, p.name AS product_name
        FROM sales s JOIN products p ON p.id = s.product_id
        WHERE DATE(s.sold_at) = DATE($1)
        ORDER BY s.sold_at DESC
      `, [d])).rows;
    }
  } catch (e) {
    console.error('DB error for PDF:', e);
    return res.status(500).send('DB error');
  }

  const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const profitOf = (s) => (Number(s.sale_price) - Number(s.shipping_cost || 0)) * Number(s.quantity);
  const totalProfit  = rows.reduce((a, s) => a + profitOf(s), 0);

  // 2) جرّب Puppeteer أولًا
  try {
    // نبني الـ HTML من EJS
    const html = await new Promise((resolve, reject) => {
      res.render(
        'report-pdf',
        { rows, title, totalRevenue, totalProfit, dayjs },
        (err, str) => (err ? reject(err) : resolve(str))
      );
    });

    // إعدادات مناسبة لـ Render/Heroku
    const browser = await puppeteer.launch({
      headless: true,
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
    // IMPORTANT: لا نحمل أي موارد خارجية بالـ HTML (يفضّل CSS inline داخل القالب)
    await page.setContent(html, { waitUntil: 'load', timeout: 60000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', right: '12mm', bottom: '16mm', left: '12mm' }
    });

    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="report.pdf"');
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.send(pdfBuffer); // (send) أفضل من end هنا
  } catch (err) {
    console.error('Puppeteer failed, falling back to PDFKit:', err);
  }

  // 3) Fallback: PDFKit بسيط لو فشل Puppeteer
  try {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="report.pdf"');

    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, left: 40, right: 40, bottom: 40 } });
    doc.pipe(res);

    doc.fontSize(18).text(title, { align: 'right' });
    doc.moveDown(0.5);
    doc.fontSize(12).text(`إجمالي الإيراد: $${totalRevenue.toFixed(2)}`, { align: 'right' });
    doc.text(`إجمالي الربح: $${totalProfit.toFixed(2)}`, { align: 'right' });
    doc.moveDown();

    // ترويسة جدول بسيطة
    doc.fontSize(12).text('التاريخ', 40, doc.y, { continued: true })
      .text('المنتج', 140, undefined, { continued: true })
      .text('الكمية', 300, undefined, { continued: true })
      .text('سعر البيع', 360, undefined, { continued: true })
      .text('الشحن', 440, undefined, { continued: true })
      .text('الربح', 510);

    doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).stroke();
    doc.moveDown(0.5);

    rows.forEach((s) => {
      const sale = Number(s.sale_price);
      const ship = Number(s.shipping_cost || 0);
      const qty  = Number(s.quantity || 0);
      const pf   = (sale - ship) * qty;

      doc.text(dayjs(s.sold_at).format('YYYY-MM-DD'), 40, doc.y, { continued: true })
        .text(String(s.product_name || ''), 140, undefined, { continued: true })
        .text(String(qty), 300, undefined, { continued: true })
        .text(`$${sale.toFixed(2)}`, 360, undefined, { continued: true })
        .text(`$${ship.toFixed(2)}`, 440, undefined, { continued: true })
        .text(`$${pf.toFixed(2)}`, 510);

      doc.moveDown(0.25);
    });

    doc.end();
  } catch (e) {
    console.error('PDFKit fallback failed:', e);
    res.status(500).send('PDF generation failed');
  }
});

// ---------- Seed (اختياري) ----------
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
