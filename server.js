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
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { fileURLToPath } from 'url';
import expressLayouts from 'express-ejs-layouts';
import session from 'express-session';
import pg from 'pg';
import connectPgSimple from 'connect-pg-simple';

dayjs.extend(utc);
dayjs.extend(tz);

// ===[ 3) مسارات أساسية ]===
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const TZ_NAME = 'Asia/Hebron';

// بيانات الدخول (من البيئة)
const AUTH_USER = process.env.AUTH_USER || 'abrar';
const AUTH_PASS = process.env.AUTH_PASS || '1143';

// ===[ 4) قاعدة البيانات ]===
await initDb();

// إنشاء جدول الطلبات الراجعة إن لم يوجد
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

// ترقية جدول المبيعات لإضافة معلومات الزبون والتوصيل (إن لم تكن موجودة)
await query(`
  ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS customer_name   TEXT,
    ADD COLUMN IF NOT EXISTS customer_phone  TEXT,
    ADD COLUMN IF NOT EXISTS customer_city   TEXT,
    ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS delivered_at    TIMESTAMPTZ;
`);

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

// تمرير متغيّرات عامة للقوالب
app.use((req, res, next) => {
  res.locals.faLink = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css";
  res.locals.tzName = TZ_NAME;
  next();
});

// ===== Parsers & Static =====
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { res.locals.currentPath = req.path; next(); });

// ===== الجلسات (تسجيل الدخول) =====
const PgStore = connectPgSimple(session);
const pgPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : undefined
});

// مهم على Render (خلف بروكسي) حتى لا تُرفض الكوكيز الآمنة
app.set('trust proxy', 1);

app.use(session({
  store: new PgStore({
    pool: pgPool,
    tableName: 'session',
    // ينشئ جدول session تلقائيًا إذا غير موجود (يحل error: relation "session" does not exist)
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'abrar_shop_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production', // على Render = true (HTTPS)
    maxAge: 1000 * 60 * 60 * 8 // 8 ساعات
  }
}));
app.use((req, res, next) => { res.locals.currentUser = req.session.user || null; next(); });

// ===== Health check (مفتوح) =====
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// ===== حارس الحماية =====
const openPaths = new Set(['/login', '/healthz']);
function requireAuth(req, res, next) {
  if (openPaths.has(req.path)) return next();                // يسمح GET/POST /login
  if (req.path.startsWith('/public')) return next();          // الملفات الثابتة
  if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(req.path)) return next();
  if (req.session && req.session.user) return next();
  const back = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${back}`);
}
app.use(requireAuth);

// ===== مسارات تسجيل الدخول/الخروج =====
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(req.query.next || '/');
  res.render('login', { error: null, next: req.query.next || '/', usernamePrefill: '' });
});

app.post('/login', (req, res) => {
  const { username = '', password = '', next = '/' } = req.body || {};

  if (username !== AUTH_USER) {
    return res.status(401).render('login', {
      error: '❌ اسم المستخدم غير صحيح',
      next,
      usernamePrefill: username
    });
  }
  if (password !== AUTH_PASS) {
    return res.status(401).render('login', {
      error: '❌ كلمة المرور غير صحيحة',
      next,
      usernamePrefill: username
    });
  }

  req.session.user = { username };
  res.redirect(next || '/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ===== Helpers =====
const profitOf = (s) =>
  (Number(s.sale_price) * Number(s.quantity))
  - (Number(s.cost_price) * Number(s.quantity))
  - Number(s.shipping_cost || 0);

// ====================== Routes ======================

// ---------- Home ----------
app.get('/', async (_req, res) => {
  const t = await query(`
    SELECT
      COUNT(*)::int                               AS products_count,
      COALESCE(SUM(stock),0)::int                 AS total_units,
      COALESCE(SUM(stock*cost_price),0)::float8   AS total_cost_value,
      COALESCE(SUM(stock*sale_price),0)::float8   AS total_sale_value
    FROM products
  `);

  const today = dayjs().tz(TZ_NAME).format('YYYY-MM-DD');
  const month = dayjs().tz(TZ_NAME).format('YYYY-MM');

  const todayRows = (await query(`SELECT * FROM sales WHERE DATE(sold_at)=DATE($1)`, [today])).rows;
  const monthRows = (await query(`SELECT * FROM sales WHERE TO_CHAR(sold_at,'YYYY-MM')=$1`, [month])).rows;

  const rev  = (rows) => rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const prof = (rows) => rows.reduce((a, s) => a + profitOf(s), 0);

  const stats = {
    ...t.rows[0],
    today_revenue: rev(todayRows),
    today_profit : prof(todayRows),
    month_revenue: rev(monthRows),
    month_profit : prof(monthRows)
  };

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

  res.render('index', { stats, byCat, lowStock, lastSales, dayjs });
});

// ---------- Products ----------
app.get('/products', async (_req, res) => {
  const products = (await query(`SELECT * FROM products ORDER BY created_at DESC`)).rows;

  const returnsList = (await query(`
    SELECT r.*, p.name AS product_name, p.image_path AS product_image
    FROM returns_queue r
    JOIN products p ON p.id = r.product_id
    ORDER BY r.created_at DESC
  `)).rows;

  res.render('products', { products, returnsList, dayjs });
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
    customer_name, customer_phone, customer_city
  } = req.body;

  const prod = (await query(`SELECT * FROM products WHERE id=$1`, [Number(product_id)])).rows[0];
  if (!prod) return res.redirect('/sales');

  const qty = Math.max(1, Number(quantity || 1));
  await query(`UPDATE products SET stock = GREATEST(0, stock - $1) WHERE id=$2`, [qty, prod.id]);

  await query(`
    INSERT INTO sales (
      product_id,quantity,sale_price,cost_price,shipping_cost,note,
      customer_name, customer_phone, customer_city, delivery_status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
  `, [
    prod.id, qty,
    Number(sale_price || prod.sale_price), Number(cost_price || prod.cost_price),
    Number(shipping_cost || 0),
    note || '',
    (customer_name || '').trim(),
    (customer_phone || '').trim(),
    (customer_city || '').trim()
  ]);

  res.redirect('/sales');
});

// تغيير حالة التوصيل من قائمة
app.post('/sales/:id/delivery', async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body; // pending | shipping | delivered | failed
  const normalized = (status || 'pending').toLowerCase();
  await query(`
    UPDATE sales
    SET delivery_status = $1,
        delivered_at = CASE WHEN $1='delivered' THEN NOW() ELSE NULL END
    WHERE id = $2
  `, [normalized, id]);
  res.redirect('/sales');
});

// دعم مسار قديم للتبديل السريع
app.post('/sales/:id/toggle-delivered', async (req, res) => {
  const id = Number(req.params.id);
  const row = (await query(`SELECT delivery_status FROM sales WHERE id=$1`, [id])).rows[0];
  if (!row) return res.redirect('/sales');
  const next = row.delivery_status === 'delivered' ? 'pending' : 'delivered';
  await query(`
    UPDATE sales
    SET delivery_status = $1,
        delivered_at = CASE WHEN $1='delivered' THEN NOW() ELSE NULL END
    WHERE id = $2
  `, [next, id]);
  res.redirect('/sales');
});

// حذف مفرد للمبيعات —> إلى returns_queue
app.post('/sales/:id/delete', async (req, res) => {
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
  const { range = 'daily', year, month, day } = req.query;

  let rows = [], title = '';

  if (range === 'monthly') {
    const y = Number(year) || Number(dayjs().tz(TZ_NAME).format('YYYY'));
    const m = Number(month) || Number(dayjs().tz(TZ_NAME).format('MM'));
    const ym = `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}`;
    title = `تقرير شهري ${ym}`;
    rows  = (await query(`
      SELECT s.*, p.name AS product_name
      FROM sales s JOIN products p ON p.id = s.product_id
      WHERE TO_CHAR(s.sold_at,'YYYY-MM') = $1
      ORDER BY s.sold_at DESC
    `, [ym])).rows;
  } else {
    const y = Number(year) || Number(dayjs().tz(TZ_NAME).format('YYYY'));
    const m = Number(month) || Number(dayjs().tz(TZ_NAME).format('MM'));
    const d = Number(day) || Number(dayjs().tz(TZ_NAME).format('DD'));
    const dateStr = `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    title = `تقرير يومي ${dateStr}`;
    rows  = (await query(`
      SELECT s.*, p.name AS product_name
      FROM sales s JOIN products p ON p.id = s.product_id
      WHERE DATE(s.sold_at) = DATE($1)
      ORDER BY s.sold_at DESC
    `, [dateStr])).rows;
  }

  const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const totalCost    = rows.reduce((a, s) => a + (Number(s.cost_price) * Number(s.quantity)) + Number(s.shipping_cost || 0), 0);
  const totalProfit  = totalRevenue - totalCost;

  res.render('reports', {
    rows, title, range,
    totalRevenue, totalCost, totalProfit,
    selected: {
      year: Number(year) || null,
      month: Number(month) || null,
      day: Number(day) || null
    },
    dayjs
  });
});

// ---------- Reports (PDF) ----------
app.get('/reports/pdf', async (req, res) => {
  try {
    const { range = 'daily', year, month, day } = req.query;

    let rows = [], title = '';

    if (range === 'monthly') {
      const y = Number(year) || Number(dayjs().tz(TZ_NAME).format('YYYY'));
      const m = Number(month) || Number(dayjs().tz(TZ_NAME).format('MM'));
      const ym = `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}`;
      title = `تقرير مبيعات شهري ${ym}`;
      rows  = (await query(`
        SELECT s.*, p.name AS product_name
        FROM sales s JOIN products p ON p.id=s.product_id
        WHERE TO_CHAR(s.sold_at,'YYYY-MM')=$1
        ORDER BY s.sold_at DESC
      `, [ym])).rows;
    } else {
      const y = Number(year) || Number(dayjs().tz(TZ_NAME).format('YYYY'));
      const m = Number(month) || Number(dayjs().tz(TZ_NAME).format('MM'));
      const d = Number(day) || Number(dayjs().tz(TZ_NAME).format('DD'));
      const dateStr = `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      title = `تقرير مبيعات يومي ${dateStr}`;
      rows  = (await query(`
        SELECT s.*, p.name AS product_name
        FROM sales s JOIN products p ON p.id=s.product_id
        WHERE DATE(s.sold_at)=DATE($1)
        ORDER BY s.sold_at DESC
      `, [dateStr])).rows;
    }

    const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
    const totalProfit  = rows.reduce((a, s) => a + profitOf(s), 0);

    const html = await new Promise((resolve, reject) => {
      req.app.render('report-pdf', { rows, title, totalRevenue, totalProfit, dayjs }, (err, str) => {
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

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
