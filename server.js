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

// ===== Timezone helpers (Asia/Jerusalem + 12h formatting) =====
const TZ = 'Asia/Jerusalem';
app.locals.fmtTS = (ts) =>
  new Date(ts).toLocaleString('en-US', {
    timeZone: TZ, hour12: true,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });

// ===[ 4) قاعدة البيانات ]===
await initDb();

// ترقية جداول مطلوبة (إن لم تكن موجودة)
await query(`
  CREATE TABLE IF NOT EXISTS returns_queue (
    id SERIAL PRIMARY KEY,
    sale_id       INT,
    product_id    INT NOT NULL,
    quantity      INT NOT NULL,
    sale_price    NUMERIC(12,2) NOT NULL,
    cost_price    NUMERIC(12,2) NOT NULL,
    shipping_cost NUMERIC(12,2) DEFAULT 0,
    note          TEXT,
    sold_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT fk_returns_product FOREIGN KEY (product_id)
      REFERENCES products(id) ON DELETE CASCADE
  );
`);
await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_name  TEXT;`);
await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_phone TEXT;`);
await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_city  TEXT;`);
await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS delivered      BOOLEAN DEFAULT false;`);
await query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS delivered_at   TIMESTAMPTZ;`);

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

// ===== Dashboard Stats بحدود Asia/Jerusalem =====
async function stats() {
  const t = await query(`
    SELECT
      COUNT(*)::int                               AS products_count,
      COALESCE(SUM(stock),0)::int                 AS total_units,
      COALESCE(SUM(stock*cost_price),0)::float8   AS total_cost_value,
      COALESCE(SUM(stock*sale_price),0)::float8   AS total_sale_value
    FROM products
  `);

  // اليوم الحالي بتوقيت فلسطين
  const todayRows = (await query(`
    WITH loc AS (
      SELECT
        EXTRACT(YEAR  FROM (NOW() AT TIME ZONE 'Asia/Jerusalem'))::int AS y,
        EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'Asia/Jerusalem'))::int AS m,
        EXTRACT(DAY   FROM (NOW() AT TIME ZONE 'Asia/Jerusalem'))::int AS d
    )
    SELECT * FROM sales
    WHERE sold_at >= make_timestamptz((SELECT y FROM loc),(SELECT m FROM loc),(SELECT d FROM loc),0,0,0,'Asia/Jerusalem')
      AND sold_at <  make_timestamptz((SELECT y FROM loc),(SELECT m FROM loc),(SELECT d FROM loc),0,0,0,'Asia/Jerusalem') + INTERVAL '1 day'
    ORDER BY sold_at DESC
  `)).rows;

  // الشهر الحالي بتوقيت فلسطين
  const monthRows = (await query(`
    WITH loc AS (
      SELECT
        EXTRACT(YEAR  FROM (NOW() AT TIME ZONE 'Asia/Jerusalem'))::int AS y,
        EXTRACT(MONTH FROM (NOW() AT TIME ZONE 'Asia/Jerusalem'))::int AS m
    )
    SELECT * FROM sales
    WHERE sold_at >= make_timestamptz((SELECT y FROM loc),(SELECT m FROM loc),1,0,0,0,'Asia/Jerusalem')
      AND sold_at <  (make_timestamptz((SELECT y FROM loc),(SELECT m FROM loc),1,0,0,0,'Asia/Jerusalem') + INTERVAL '1 month')
    ORDER BY sold_at DESC
  `)).rows;

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

  const lowStock = (await query(`SELECT * FROM products WHERE stock<= $1 ORDER BY stock ASC LIMIT 8`, [5])).rows;

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

  // قائمة الطلبات الراجعة
  const returnsList = (await query(`
    SELECT r.*, p.name AS product_name, p.image_path AS product_image
    FROM returns_queue r
    JOIN products p ON p.id = r.product_id
    ORDER BY r.created_at DESC
  `)).rows;

  res.render('products', { products, returnsList });
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
           p.name       AS product_name,
           p.image_path AS product_image
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
  const {
    product_id, quantity, sale_price, cost_price, shipping_cost, note,
    customer_name, customer_phone, customer_city, delivered
  } = req.body;

  const prod = (await query(`SELECT * FROM products WHERE id=$1`, [Number(product_id)])).rows[0];
  if (!prod) return res.redirect('/sales');

  const qty = Math.max(1, Number(quantity || 1));
  await query(`UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id=$2`, [qty, prod.id]);

  const deliveredBool = delivered === 'on' || delivered === true;

  await query(`
    INSERT INTO sales (product_id,quantity,sale_price,cost_price,shipping_cost,note,
                       customer_name, customer_phone, customer_city, delivered, delivered_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $10 THEN NOW() ELSE NULL END)
  `, [
    prod.id, qty,
    Number(sale_price || prod.sale_price), Number(cost_price || prod.cost_price),
    Number(shipping_cost || 0), note || '',
    customer_name || '', customer_phone || '', customer_city || '',
    deliveredBool
  ]);

  res.redirect('/sales');
});

app.post('/sales/:id/delete', async (req, res) => {
  // نقل العملية إلى returns_queue دون تعديل المخزون الآن
  const id = Number(req.params.id);
  const s  = (await query(`SELECT * FROM sales WHERE id=$1`, [id])).rows[0];
  if (s) {
    await query(`
      INSERT INTO returns_queue (sale_id, product_id, quantity, sale_price, cost_price, shipping_cost, note, sold_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [s.id, s.product_id, s.quantity, s.sale_price, s.cost_price, s.shipping_cost || 0, s.note || '', s.sold_at]);
    await query(`DELETE FROM sales WHERE id=$1`, [id]);
  }
  res.redirect('/sales');
});

// تحديث حالة التسليم (تم/لم يتم)
app.post('/sales/:id/delivered', async (req, res) => {
  const id = Number(req.params.id);
  const val = (req.body.delivered === 'on' || req.body.delivered === true);
  await query(
    `UPDATE sales SET delivered=$1, delivered_at=CASE WHEN $1 THEN NOW() ELSE NULL END WHERE id=$2`,
    [val, id]
  );
  res.redirect('/sales');
});

// الحذف الجماعي للمبيعات —> نقل جماعي للـ returns_queue ثم حذف
app.post('/sales/bulk-delete', async (req, res) => {
  const ids = req.body.ids || [];
  const arr = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (arr.length) {
    const rows = (await query(`SELECT * FROM sales WHERE id = ANY($1::int[])`, [arr])).rows;
    for (const s of rows) {
      await query(`
        INSERT INTO returns_queue (sale_id, product_id, quantity, sale_price, cost_price, shipping_cost, note, sold_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [s.id, s.product_id, s.quantity, s.sale_price, s.cost_price, s.shipping_cost || 0, s.note || '', s.sold_at]);
    }
    await query(`DELETE FROM sales WHERE id = ANY($1::int[])`, [arr]);
  }
  res.redirect('/sales');
});

// ---------- Actions على الطلبات الراجعة ----------
app.post('/returns/:id/restock', async (req, res) => {
  const id = Number(req.params.id);
  const r  = (await query(`SELECT * FROM returns_queue WHERE id=$1`, [id])).rows[0];
  if (r) {
    await query(`UPDATE products SET stock = stock + $1 WHERE id=$2`, [r.quantity, r.product_id]);
    await query(`DELETE FROM returns_queue WHERE id=$1`, [id]);
  }
  res.redirect('/products');
});

app.post('/returns/:id/reorder', async (req, res) => {
  const id = Number(req.params.id);
  const r  = (await query(`SELECT * FROM returns_queue WHERE id=$1`, [id])).rows[0];
  if (r) {
    await query(`UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id=$2`, [r.quantity, r.product_id]);
    await query(`
      INSERT INTO sales (product_id, quantity, sale_price, cost_price, shipping_cost, note)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [r.product_id, r.quantity, r.sale_price, r.cost_price, r.shipping_cost || 0, (r.note || '') + ' (من طلب راجع)']);
    await query(`DELETE FROM returns_queue WHERE id=$1`, [id]);
  }
  res.redirect('/products');
});

app.post('/returns/:id/delete', async (req, res) => {
  const id = Number(req.params.id);
  await query(`DELETE FROM returns_queue WHERE id=$1`, [id]);
  res.redirect('/products');
});

// ---------- Reports (HTML) ----------
app.get('/reports', async (req, res) => {
  const mode = (req.query.mode === 'monthly') ? 'monthly' : 'daily';

  // قيم افتراضية من توقيت فلسطين
  const now = new Date();
  const defYear  = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(now);
  const defMonth = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: '2-digit' }).format(now);
  const defDay   = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, day: '2-digit' }).format(now);

  const year  = Number(req.query.year  || defYear);
  const month = Number(req.query.month || defMonth);
  const day   = Number(req.query.day   || defDay);

  const ym  = `${String(year)}-${String(month).padStart(2,'0')}`;
  const ymd = `${ym}-${String(day).padStart(2,'0')}`;

  let rows = [], title = '';

  if (mode === 'monthly') {
    title = `تقرير شهري ${ym}`;
    rows  = (await query(`
      SELECT s.*, p.name AS product_name, p.category
      FROM sales s JOIN products p ON p.id = s.product_id
      WHERE sold_at >= make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem')
        AND sold_at <  (make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem') + INTERVAL '1 month')
      ORDER BY s.sold_at DESC
    `, [year, month])).rows;
  } else {
    title = `تقرير يومي ${ymd}`;
    rows  = (await query(`
      SELECT s.*, p.name AS product_name, p.category
      FROM sales s JOIN products p ON p.id = s.product_id
      WHERE sold_at >= make_timestamptz($1,$2,$3,0,0,0,'Asia/Jerusalem')
        AND sold_at <  (make_timestamptz($1,$2,$3,0,0,0,'Asia/Jerusalem') + INTERVAL '1 day')
      ORDER BY s.sold_at DESC
    `, [year, month, day])).rows;
  }

  const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const totalProfit  = rows.reduce((a, s) => a + profitOf(s), 0);

  // ملخص شهري إضافي
  let byDay = [], byCat = [];
  if (mode === 'monthly') {
    const daysRes = await query(`
      WITH d AS (
        SELECT
          generate_series(
            make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem'),
            (make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem') + INTERVAL '1 month' - INTERVAL '1 day'),
            INTERVAL '1 day'
          ) AS d0
      ),
      agg AS (
        SELECT
          (s.sold_at AT TIME ZONE 'Asia/Jerusalem')::date AS d,
          SUM(s.sale_price * s.quantity)::float8  AS rev,
          SUM((s.sale_price * s.quantity) - (s.cost_price * s.quantity) - COALESCE(s.shipping_cost,0))::float8 AS prof
        FROM sales s
        WHERE s.sold_at >= make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem')
          AND s.sold_at <  (make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem') + INTERVAL '1 month')
        GROUP BY 1
      )
      SELECT
        EXTRACT(DAY FROM d.d0)::int AS day,
        COALESCE(agg.rev,0)  AS revenue,
        COALESCE(agg.prof,0) AS profit
      FROM d
      LEFT JOIN agg ON agg.d = d.d0::date
      ORDER BY 1
    `, [year, month]);
    byDay = daysRes.rows;

    const byCatRes = await query(`
      SELECT COALESCE(p.category,'غير مصنّف') AS label,
             COALESCE(SUM(s.quantity * s.sale_price),0)::float8 AS value
      FROM products p
      LEFT JOIN sales s ON s.product_id = p.id
           AND s.sold_at >= make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem')
           AND s.sold_at <  (make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem') + INTERVAL '1 month')
      GROUP BY 1
      ORDER BY 2 DESC
    `, [year, month]);
    byCat = byCatRes.rows;
  }

  // إعداد قوائم السنوات/الشهور/الأيام
  const currentYear = Number(defYear);
  const years  = Array.from({length: (currentYear - 2023 + 1)}, (_,i)=>2023+i);
  const months = [
    {n:1 , name:'يناير'},{n:2 , name:'فبراير'},{n:3 , name:'مارس'},{n:4 , name:'أبريل'},
    {n:5 , name:'مايو'  },{n:6 , name:'يونيو'},{n:7 , name:'يوليو'},{n:8 , name:'أغسطس'},
    {n:9 , name:'سبتمبر'},{n:10, name:'أكتوبر'},{n:11, name:'نوفمبر'},{n:12, name:'ديسمبر'},
  ];
  const daysInSelectedMonthRes = await query(`
    SELECT EXTRACT(DAY FROM (date_trunc('month',
      make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem') + INTERVAL '1 month'
    ) - INTERVAL '1 day'))::int AS d
  `, [year, month]);
  const dim = daysInSelectedMonthRes.rows?.[0]?.d || 31;
  const daysArr = Array.from({length: dim}, (_,i)=> i+1);

  res.render('reports', {
    mode, year, month, day,
    years, months, daysArr,
    rows, title, totalRevenue, totalProfit, byDay, byCat, dayjs
  });
});

// ---------- Reports (PDF) ----------
app.get('/reports/pdf', async (req, res) => {
  try {
    const mode = (req.query.mode === 'monthly') ? 'monthly' : 'daily';

    const now = new Date();
    const defYear  = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(now);
    const defMonth = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: '2-digit' }).format(now);
    const defDay   = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, day: '2-digit' }).format(now);

    const year  = Number(req.query.year  || defYear);
    const month = Number(req.query.month || defMonth);
    const day   = Number(req.query.day   || defDay);

    let rows = [], title = '';
    if (mode === 'monthly') {
      title = `تقرير مبيعات شهري ${year}-${String(month).padStart(2,'0')}`;
      rows = (await query(`
        SELECT s.*, p.name AS product_name
        FROM sales s JOIN products p ON p.id=s.product_id
        WHERE sold_at >= make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem')
          AND sold_at <  (make_timestamptz($1,$2,1,0,0,0,'Asia/Jerusalem') + INTERVAL '1 month')
        ORDER BY s.sold_at DESC
      `, [year, month])).rows;
    } else {
      title = `تقرير مبيعات يومي ${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      rows = (await query(`
        SELECT s.*, p.name AS product_name
        FROM sales s JOIN products p ON p.id=s.product_id
        WHERE sold_at >= make_timestamptz($1,$2,$3,0,0,0,'Asia/Jerusalem')
          AND sold_at <  (make_timestamptz($1,$2,$3,0,0,0,'Asia/Jerusalem') + INTERVAL '1 day')
        ORDER BY s.sold_at DESC
      `, [year, month, day])).rows;
    }

    const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
    const totalProfit  = rows.reduce((a, s) => a + profitOf(s), 0);

    // Render HTML (قالب report-pdf.ejs يستخدم ₪ وتحويلات 12h عبر fmtTS إن احتجت)
    const html = await new Promise((resolve, reject) => {
      req.app.render('report-pdf', { rows, title, totalRevenue, totalProfit, dayjs, fmtTS: app.locals.fmtTS }, (err, str) => {
        if (err) reject(err); else resolve(str);
      });
    });

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
    await page.setContent(
      `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8">${html}</html>`,
      { waitUntil: 'networkidle0', timeout: 60000 }
    );
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', right: '12mm', bottom: '16mm', left: '12mm' } });
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
