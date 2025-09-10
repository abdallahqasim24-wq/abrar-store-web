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

// ترقية جدول المبيعات
await query(`
  ALTER TABLE sales
    ADD COLUMN IF NOT EXISTS customer_name   TEXT,
    ADD COLUMN IF NOT EXISTS customer_phone  TEXT,
    ADD COLUMN IF NOT EXISTS customer_city   TEXT,
    ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS delivered_at    TIMESTAMPTZ;
`);

// ===[ 5) إعداد رفع الصور (Cloudinary أو محلي) ]===
const hasCloud =
  !!process.env.CLOUDINARY_URL ||
  (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

if (process.env.CLOUDINARY_URL) {
  cloudinary.config(process.env.CLOUDINARY_URL);
} else if (hasCloud) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
} else {
  console.warn('⚠️  CLOUDINARY غير مضبوط. سيتم الرفع محليًا إلى public/uploads');
}

// لو محلي: تأكد من وجود مجلد الرفع
const localUploadsDir = path.join(__dirname, 'public', 'uploads');
if (!hasCloud) {
  if (!fs.existsSync(localUploadsDir)) fs.mkdirSync(localUploadsDir, { recursive: true });
}

// فلترة الملفات للسماح بالصور فقط
const fileFilter = (req, file, cb) => {
  if (!file || !file.mimetype || !file.mimetype.startsWith('image/')) {
    return cb(new Error('يُسمح برفع الصور فقط'), false);
  }
  cb(null, true);
};

// اختيار التخزين حسب التوفر
let storage;
if (hasCloud) {
  storage = new CloudinaryStorage({
    cloudinary,
    params: async () => ({
      folder: 'abrar-shop',
      resource_type: 'image',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'],
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

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

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

app.set('trust proxy', 1);

// مهلة الخمول (بالدقائق)
const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 30);
const IDLE_MS = IDLE_MINUTES * 60 * 1000;

app.use(session({
  store: new PgStore({
    pool: pgPool,
    tableName: 'session',
    createTableIfMissing: true
  }),
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

// تمرير المستخدم للقوالب
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

// إنهاء الجلسة عند الخمول
app.use((req, res, next) => {
  if (!req.session.user) return next();
  const now = Date.now();
  const last = req.session.lastSeen || now;
  if (now - last > IDLE_MS) {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }
  req.session.lastSeen = now;
  next();
});

// ===== Health check (مفتوح) =====
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// ===== حارس الحماية =====
const openPaths = new Set(['/login', '/healthz']);
function requireAuth(req, res, next) {
  if (openPaths.has(req.path)) return next();
  if (req.path.startsWith('/public')) return next();
  if (/\.(css|js|png|jpg|jpeg|webp|gif|svg|ico|woff2?)$/i.test(req.path)) return next();
  if (req.session && req.session.user) return next();
  const back = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${back}`);
}
app.use(requireAuth);

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

  const todayRows = (await query(
    `SELECT * FROM sales WHERE DATE(sold_at)=DATE($1)`,
    [today]
  )).rows;

  const monthRows = (await query(
    `SELECT * FROM sales WHERE TO_CHAR(sold_at,'YYYY-MM')=$1`,
    [month]
  )).rows;

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

  const lowStock = (await query(`SELECT * FROM products WHERE stock<=$1 ORDER BY stock ASC LIMIT 8`, [5])).rows;

  const lastSales = (await query(`
    SELECT s.*, p.name AS product_name
    FROM sales s JOIN products p ON p.id = s.product_id
    ORDER BY s.sold_at DESC LIMIT 8
  `)).rows;

  res.render('index', { stats, byCat, lowStock, lastSales, dayjs });
});

// (باقي كود المنتجات + المبيعات + التقارير مثل ما ركبناه فوق)


// ===[ Global Error Handler ]===
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err?.message, err?.stack);
  if (req.accepts('html')) return res.status(500).send('حدث خطأ أثناء معالجة الطلب.');
  res.status(500).json({ error: err?.message || 'Server error' });
});

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
