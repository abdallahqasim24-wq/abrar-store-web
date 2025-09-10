// server.js — نسخة كاملة جاهزة
// ===========================================
// 1) .env
import dotenv from 'dotenv';
dotenv.config();

// 2) Imports
import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import puppeteer from 'puppeteer';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import tz from 'dayjs/plugin/timezone.js';
import { fileURLToPath } from 'url';
import expressLayouts from 'express-ejs-layouts';
import session from 'express-session';
import pg from 'pg';
import connectPgSimple from 'connect-pg-simple';
import { query, initDb } from './db.js';

dayjs.extend(utc);
dayjs.extend(tz);

// 3) Base
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const TZ_NAME = process.env.TZ_NAME || 'Asia/Hebron';

// Auth flags
const AUTH_USER = process.env.AUTH_USER || 'abrar';
const AUTH_PASS = process.env.AUTH_PASS || '1143';
const AUTH_ENABLED = (process.env.AUTH_ENABLED ?? '1') !== '0';

// 4) DB & migrations
await initDb();

// returns_queue (إن لم يوجد)
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

// أعمدة إضافية لـ sales إن لم توجد
await query(`
  ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS customer_name   TEXT,
    ADD COLUMN IF NOT EXISTS customer_phone  TEXT,
    ADD COLUMN IF NOT EXISTS customer_city   TEXT,
    ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS delivered_at    TIMESTAMPTZ;
`);

// جدول صور المنتجات الفرعية (جديد)
await query(`
  CREATE TABLE IF NOT EXISTS product_images (
    id SERIAL PRIMARY KEY,
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`);

// 5) Uploads (Cloudinary/Local)
const hasCloud =
  !!process.env.CLOUDINARY_URL ||
  (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

if (process.env.CLOUDINARY_URL) {
  cloudinary.config(process.env.CLOUDINARY_URL);
} else if (hasCloud) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
} else {
  console.warn('⚠️ CLOUDINARY غير مضبوط. الرفع سيكون محليًا إلى public/uploads');
}

const localUploadsDir = path.join(__dirname, 'public', 'uploads');
if (!hasCloud) {
  if (!fs.existsSync(localUploadsDir)) fs.mkdirSync(localUploadsDir, { recursive: true });
}

const fileFilter = (req, file, cb) => {
  if (!file?.mimetype?.startsWith('image/')) return cb(new Error('يُسمح برفع الصور فقط'), false);
  cb(null, true);
};

let storage;
if (hasCloud) {
  storage = new CloudinaryStorage({
    cloudinary,
    params: async () => ({
      folder: 'abrar-shop',
      resource_type: 'image',
      allowed_formats: ['jpg','jpeg','png','webp','gif','svg'],
      public_id: `${Date.now()}-${Math.round(Math.random()*1e9)}`
    })
  });
} else {
  storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, localUploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `${Date.now()}-${Math.round(Math.random()*1e9)}${ext}`);
    }
  });
}

const upload = multer({ storage, fileFilter, limits: { fileSize: 5*1024*1024 }});

// 6) Views
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use((req, res, next) => {
  res.locals.faLink = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css";
  res.locals.tzName = TZ_NAME;
  next();
});

// 7) Parsers & static
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { res.locals.currentPath = req.path; next(); });

// 8) Sessions / Login
const PgStore = connectPgSimple(session);
const pgPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : undefined
});
app.set('trust proxy', 1);

const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 30);
const IDLE_MS = IDLE_MINUTES * 60 * 1000;

app.use(session({
  store: new PgStore({ pool: pgPool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'abrar_shop_secret',
  resave: false,
  saveUninitialized: false,
  rolling: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.use((req, res, next) => { res.locals.currentUser = req.session.user || null; next(); });

app.use((req, res, next) => {
  if (!req.session.user) return next();
  const now = Date.now();
  const last = req.session.lastSeen || now;
  if (now - last > IDLE_MS) return req.session.destroy(() => res.redirect('/login'));
  req.session.lastSeen = now;
  next();
});

// 9) Health
app.get('/healthz', (_req,res)=>res.status(200).send('OK'));

// 10) Auth guard (اختياري)
const openPaths = new Set(['/login','/logout','/healthz']);
function requireAuth(req, res, next){
  if (openPaths.has(req.path)) return next();
  if (req.path.startsWith('/public')) return next();
  if (/\.(css|js|png|jpg|jpeg|gif|webp|svg|ico|woff2?)$/i.test(req.path)) return next();
  if (req.session?.user) return next();
  const back = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${back}`);
}
if (AUTH_ENABLED) app.use(requireAuth);

// 11) Login routes
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(req.query.next || '/');
  res.render('login', { error: null, next: req.query.next || '/', usernamePrefill: '' });
});
app.post('/login', (req, res) => {
  const { username = '', password = '', next = '/' } = req.body || {};
  if (username !== AUTH_USER)
    return res.status(401).render('login', { error:'❌ اسم المستخدم غير صحيح', next, usernamePrefill: username });
  if (password !== AUTH_PASS)
    return res.status(401).render('login', { error:'❌ كلمة المرور غير صحيحة', next, usernamePrefill: username });
  req.session.user = { username };
  res.redirect(next || '/');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// Helpers
const profitOf = (s) =>
  (Number(s.sale_price) * Number(s.quantity))
  - (Number(s.cost_price) * Number(s.quantity))
  - Number(s.shipping_cost || 0);

// ================= Routes =================

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

  const byCat = (await query(`
    SELECT p.category AS label,
           COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS value
    FROM products p
    LEFT JOIN sales s ON s.product_id = p.id
    GROUP BY p.category
    ORDER BY value DESC
  `)).rows;

  const lowStock = (await query(`SELECT * FROM products WHERE stock <= $1 ORDER BY stock ASC LIMIT 8`, [5])).rows;

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

// إضافة منتج: صورة رئيسية + صور فرعية متعددة
app.post('/products', (req, res, next) => {
  const uploader = upload.fields([
    { name: 'image',  maxCount: 1 },   // صورة الغلاف
    { name: 'images', maxCount: 15 }   // صور فرعية
  ]);

  uploader(req, res, async (err) => {
    try {
      if (err) throw err;
      const { name, brand, category, cost_price, sale_price, stock } = req.body;

      // مسار صورة الغلاف
      const main = (req.files?.image || [])[0] || null;
      let image_path = null;
      if (main) {
        image_path = hasCloud
          ? (main.path || main.secure_url || null)
          : `/public/uploads/${main.filename}`;
      }

      // إدراج المنتج وإرجاع id
      const ins = await query(`
        INSERT INTO products (name, brand, category, cost_price, sale_price, stock, image_path)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id
      `, [
        name,
        brand || '',
        category || '',
        Number(cost_price),
        Number(sale_price),
        Number(stock || 0),
        image_path
      ]);
      const productId = ins.rows[0].id;

      // إدراج الصور الفرعية (إن وُجدت)
      const extras = req.files?.images || [];
      if (extras.length) {
        for (const f of extras) {
          const url = hasCloud ? (f.path || f.secure_url || null)
                               : `/public/uploads/${f.filename}`;
          if (url) {
            await query(`INSERT INTO product_images (product_id, url) VALUES ($1,$2)`, [productId, url]);
          }
        }
      }

      res.redirect('/products');
    } catch (e) {
      console.error('Products create error:', e?.message, e);
      next(e);
    }
  });
});

// تعديل منتج: يمكن استبدال الصورة الرئيسية + إضافة صور فرعية جديدة
app.post('/products/:id/update', (req, res, next) => {
  const uploader = upload.fields([
    { name: 'image',  maxCount: 1 },
    { name: 'images', maxCount: 15 }
  ]);

  uploader(req, res, async (err) => {
    try {
      if (err) throw err;
      const id  = Number(req.params.id);
      const old = (await query(`SELECT * FROM products WHERE id=$1`, [id])).rows[0];
      if (!old) return res.redirect('/products');

      const { name, brand, category, cost_price, sale_price, stock } = req.body;

      let image_path = old.image_path;
      const main = (req.files?.image || [])[0] || null;
      if (main) {
        image_path = hasCloud
          ? (main.path || main.secure_url || image_path)
          : `/public/uploads/${main.filename}`;
      }

      await query(`
        UPDATE products
        SET name=$1, brand=$2, category=$3, cost_price=$4, sale_price=$5, stock=$6, image_path=$7
        WHERE id=$8
      `, [
        name || old.name,
        brand ?? old.brand,
        category ?? old.category,
        Number(cost_price ?? old.cost_price),
        Number(sale_price ?? old.sale_price),
        Number(stock ?? old.stock),
        image_path,
        id
      ]);

      // صور فرعية جديدة (اختياري)
      const extras = req.files?.images || [];
      if (extras.length) {
        for (const f of extras) {
          const url = hasCloud ? (f.path || f.secure_url || null)
                               : `/public/uploads/${f.filename}`;
          if (url) {
            await query(`INSERT INTO product_images (product_id, url) VALUES ($1,$2)`, [id, url]);
          }
        }
      }

      res.redirect('/products');
    } catch (e) {
      console.error('Products update error:', e?.message, e);
      next(e);
    }
  });
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

app.post('/products/bulk-delete', async (req, res) => {
  const ids = req.body.ids;
  const arr = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (arr.length) await query(`DELETE FROM products WHERE id = ANY($1::int[])`, [arr]);
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
    SELECT id, name, stock, cost_price, sale_price, image_path
    FROM products
    ORDER BY name
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
      product_id, quantity, sale_price, cost_price, shipping_cost, note,
      customer_name, customer_phone, customer_city, delivery_status
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
  `, [
    prod.id, qty,
    Number(sale_price || prod.sale_price),
    Number(cost_price || prod.cost_price),
    Number(shipping_cost || 0),
    note || '',
    (customer_name || '').trim(),
    (customer_phone || '').trim(),
    (customer_city || '').trim()
  ]);

  res.redirect('/sales');
});

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

// حذف نهائي فردي
app.post('/sales/:id/delete', async (req, res) => {
  await query(`DELETE FROM sales WHERE id=$1`, [Number(req.params.id)]);
  res.redirect('/sales');
});

// نقل للراجعات (فردي — بدون حذف من sales)
app.post('/sales/:id/return', async (req, res) => {
  const id = Number(req.params.id);
  const s  = (await query(`SELECT * FROM sales WHERE id=$1`, [id])).rows[0];
  if (s) {
    await query(`
      INSERT INTO returns_queue (sale_id, product_id, quantity, sale_price, cost_price, shipping_cost, note, sold_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [s.id, s.product_id, s.quantity, s.sale_price, s.cost_price, s.shipping_cost || 0, s.note || '', s.sold_at]);
  }
  res.redirect('/sales');
});

// حذف جماعي (نهائي)
app.post('/sales/bulk-delete', async (req, res) => {
  const raw = req.body.ids || '';
  const arr = (Array.isArray(raw) ? raw : String(raw).split(','))
              .map(Number).filter(Boolean);
  if (arr.length) await query(`DELETE FROM sales WHERE id = ANY($1::int[])`, [arr]);
  res.redirect('/sales');
});

// نقل جماعي إلى الراجعات (بدون حذف من sales)
app.post('/sales/bulk-return', async (req, res) => {
  const raw = req.body.ids || '';
  const arr = (Array.isArray(raw) ? raw : String(raw).split(','))
              .map(x=>Number(x)).filter(Boolean);

  for (const id of arr) {
    const s = (await query(`SELECT * FROM sales WHERE id=$1`, [id])).rows[0];
    if (s) {
      await query(`
        INSERT INTO returns_queue (sale_id, product_id, quantity, sale_price, cost_price, shipping_cost, note, sold_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [s.id, s.product_id, s.quantity, s.sale_price, s.cost_price, s.shipping_cost || 0, s.note || '', s.sold_at]);
    }
  }
  res.redirect('/sales');
});

// ---------- Returns actions ----------
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
      SELECT s.*, p.name AS product_name, p.image_path AS product_image
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
      SELECT s.*, p.name AS product_name, p.image_path AS product_image
      FROM sales s JOIN products p ON p.id = s.product_id
      WHERE DATE(s.sold_at) = DATE($1)
      ORDER BY s.sold_at DESC
    `, [dateStr])).rows;
  }

  const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const totalCost    = rows.reduce((a, s) => a + (Number(s.cost_price) * Number(s.quantity)) + Number(s.shipping_cost || 0), 0);

  res.render('reports', {
    title,
    rows,
    totalRevenue,
    totalCost,
    range,
    selected: {
      year:  Number(year)  || Number(dayjs().tz(TZ_NAME).format('YYYY')),
      month: Number(month) || Number(dayjs().tz(TZ_NAME).format('MM')),
      day:   Number(day)   || Number(dayjs().tz(TZ_NAME).format('DD')),
    },
    dayjs
  });
});

// ---------- Reports PDF ----------
app.get('/reports/pdf', async (req, res, next) => {
  try {
    const { range = 'daily', year, month, day } = req.query;

    let rows = [], title = '';

    if (range === 'monthly') {
      const y = Number(year) || Number(dayjs().tz(TZ_NAME).format('YYYY'));
      const m = Number(month) || Number(dayjs().tz(TZ_NAME).format('MM'));
      const ym = `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}`;
      title = `تقرير شهري ${ym}`;
      rows  = (await query(`
        SELECT s.*, p.name AS product_name, p.image_path AS product_image
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
        SELECT s.*, p.name AS product_name, p.image_path AS product_image
        FROM sales s JOIN products p ON p.id = s.product_id
        WHERE DATE(s.sold_at) = DATE($1)
        ORDER BY s.sold_at DESC
      `, [dateStr])).rows;
    }

    const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
    const totalProfit  = rows.reduce((a, s) => a + (
      (Number(s.sale_price) * Number(s.quantity)) -
      (Number(s.cost_price) * Number(s.quantity)) -
      Number(s.shipping_cost || 0)
    ), 0);

    // Render EJS -> HTML
    const html = await new Promise((resolve, reject) => {
      app.render('report-pdf', { title, rows, totalRevenue, totalProfit, dayjs }, (err, str) => {
        if (err) return reject(err);
        resolve(str);
      });
    });

    const browser = await puppeteer.launch({
      args: ['--no-sandbox','--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top:'10mm', right:'10mm', bottom:'10mm', left:'10mm' } });
    await browser.close();

    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="report.pdf"');
    res.send(pdf);
  } catch (e) {
    console.error('PDF error:', e?.message, e);
    next(e);
  }
});

// ========= Start =========
app.listen(PORT, HOST, () => {
  console.log(`✅ Abrar Store running on http://${HOST}:${PORT}`);
});
