// server.js — Abrar Manager (FINAL, Cloudinary-ready)
// ===================================================
import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import { fileURLToPath } from "url";
import expressLayouts from "express-ejs-layouts";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import dayjsBase from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";
import dotenv from "dotenv";

// <<< Cloudinary >>>
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";

dotenv.config();

// Dayjs + Timezone
const dayjs = dayjsBase;
dayjs.extend(utc);
dayjs.extend(tz);
const TZ_NAME = process.env.TZ_NAME || "Asia/Hebron";
if (dayjs.tz?.setDefault) dayjs.tz.setDefault(TZ_NAME);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================== إعدادات أساسية ==================
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// مصادقة بسيطة
const AUTH_ENABLED = (process.env.AUTH_ENABLED ?? "1") !== "0";
const AUTH_USER = process.env.AUTH_USER || "abrar";
const AUTH_PASS = process.env.AUTH_PASS || "1143";

// ================== قاعدة البيانات ==================
const { Pool } = pg;
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/postgres",
  ssl:
    process.env.DATABASE_URL?.includes("render.com") || process.env.PGSSL === "1"
      ? { rejectUnauthorized: false }
      : undefined,
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

// إنشاء/ترقية الجداول
async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      category TEXT,
      cost_price NUMERIC(12,2) DEFAULT 0,
      sale_price NUMERIC(12,2) DEFAULT 0,
      stock INT DEFAULT 0,
      image_path TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INT NOT NULL,
      sale_price NUMERIC(12,2) NOT NULL,
      cost_price NUMERIC(12,2) NOT NULL,
      shipping_cost NUMERIC(12,2) DEFAULT 0,
      note TEXT,
      sold_at TIMESTAMPTZ DEFAULT NOW(),
      customer_name  TEXT,
      customer_phone TEXT,
      customer_city  TEXT,
      delivery_status TEXT DEFAULT 'pending',
      delivered_at   TIMESTAMPTZ,
      order_id INT
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_name  TEXT,
      customer_phone TEXT,
      customer_city  TEXT,
      note TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS returns_queue (
      id SERIAL PRIMARY KEY,
      sale_id INT,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INT NOT NULL,
      sale_price NUMERIC(12,2) NOT NULL,
      cost_price NUMERIC(12,2) NOT NULL,
      shipping_cost NUMERIC(12,2) DEFAULT 0,
      note TEXT,
      sold_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS product_images (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("Postgres connected & migrated");
}
await initDb();

// ================== رفع صور: Cloudinary أولاً ثم ملفّات محليّة كـ fallback ==================
const useCloudinary =
  !!process.env.CLOUDINARY_CLOUD_NAME &&
  !!process.env.CLOUDINARY_API_KEY &&
  !!process.env.CLOUDINARY_API_SECRET;

let storage;
if (useCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });

  storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: process.env.CLOUDINARY_FOLDER || "abrar-store/uploads",
      allowed_formats: ["jpg", "jpeg", "png", "webp"],
      transformation: [{ width: 600, height: 600, crop: "fill", gravity: "auto" }],
    },
  });
} else {
  const uploadsDir = path.join(__dirname, "public", "uploads");
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const ext = (file.originalname || "").split(".").pop() || "jpg";
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`);
    },
  });
}
const fileFilter = (_req, file, cb) =>
  file?.mimetype?.startsWith("image/")
    ? cb(null, true)
    : cb(new Error("يُسمح برفع الصور فقط"), false);

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// ================== EJS & Middlewares ==================
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// نخدم الملفات الثابتة من الجذر و /public (الاثنان شغّالين)
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.use("/public", express.static(publicDir));

app.use((req, res, next) => {
  res.locals.faLink = "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css";
  res.locals.currentPath = req.path;
  res.locals.dayjs = dayjs;
  res.locals.TZ_NAME = TZ_NAME;
  next();
});

// ================== الجلسات والمصادقة ==================
const PgStore = connectPgSimple(session);
app.set("trust proxy", 1);
app.use(
  session({
    store: new PgStore({ pool, tableName: "session", createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || "abrar_store_secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" },
  })
);
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

const openPaths = new Set(["/login", "/logout", "/healthz"]);
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (openPaths.has(req.path)) return next();
  if (req.path.startsWith("/public")) return next();
  if (/\.(css|js|png|jpg|jpeg|gif|webp|svg|ico|woff2?)$/i.test(req.path)) return next();
  if (req.session?.user) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || "/")}`);
}
app.use(requireAuth);

// ---------- Auth ----------
app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect(req.query.next || "/");
  res.render("login", { error: null, next: req.query.next || "/", usernamePrefill: "" });
});
app.post("/login", (req, res) => {
  const { username = "", password = "", next = "/" } = req.body || {};
  if (username !== AUTH_USER)
    return res.status(401).render("login", { error: "❌ اسم المستخدم غير صحيح", next, usernamePrefill: username });
  if (password !== AUTH_PASS)
    return res.status(401).render("login", { error: "❌ كلمة المرور غير صحيحة", next, usernamePrefill: username });
  req.session.user = { username };
  res.redirect(next || "/");
});
app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
app.get("/healthz", (_req, res) => res.send("OK"));

// ================== Helpers ==================
const profitOf = (s) =>
  Number(s.sale_price) * Number(s.quantity) - Number(s.cost_price) * Number(s.quantity);

async function ensureOpenOrderForCustomer({ name, phone, city, note }) {
  const today = dayjs().tz(TZ_NAME).format("YYYY-MM-DD");
  const q = await query(
    `SELECT * FROM orders
     WHERE status IN ('pending','shipping','processing')
       AND customer_phone=$1
       AND DATE(created_at)=DATE($2)
     ORDER BY id DESC LIMIT 1`,
    [String(phone || "").trim(), today]
  );
  if (q.rowCount) return q.rows[0].id;

  const ins = await query(
    `INSERT INTO orders (customer_name, customer_phone, customer_city, note, status)
     VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
    [(name || "").trim(), (phone || "").trim(), (city || "").trim(), (note || "").trim()]
  );
  return ins.rows[0].id;
}

// يدعم إنشاء/استخدام رقم طلب مُحدد يدويًا
async function ensureOrderWithRequestedId({ requestedId, name, phone, city, note }) {
  if (requestedId && requestedId > 0) {
    const ex = await query(`SELECT id FROM orders WHERE id=$1`, [requestedId]);
    if (ex.rowCount) return ex.rows[0].id;

    const ins = await query(
      `INSERT INTO orders (id, customer_name, customer_phone, customer_city, note, status)
       VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
      [requestedId, (name||"").trim(), (phone||"").trim(), (city||"").trim(), (note||"").trim()]
    );

    await query(`
      SELECT setval(pg_get_serial_sequence('orders','id'),
                    GREATEST($1,(SELECT COALESCE(MAX(id),0) FROM orders)))
    `,[requestedId]);

    return ins.rows[0].id;
  }
  return await ensureOpenOrderForCustomer({ name, phone, city, note });
}

// ================== Routes ==================

// -------- Dashboard --------
app.get("/", async (_req, res, next) => {
  try {
    const today = dayjs().tz(TZ_NAME).format("YYYY-MM-DD");
    const ym    = dayjs().tz(TZ_NAME).format("YYYY-MM");
    const last30= dayjs().tz(TZ_NAME).subtract(30, "day").format("YYYY-MM-DD");

    const inv = (await query(`
      SELECT
        COUNT(*)::int AS products_count,
        COALESCE(SUM(stock),0)::int AS total_units,
        COALESCE(SUM(stock*cost_price),0)::float8 AS total_cost_value,
        COALESCE(SUM(stock*sale_price),0)::float8 AS total_sale_value
      FROM products
    `)).rows[0];

    const todayRows = (await query(`SELECT * FROM sales WHERE DATE(sold_at)=DATE($1)`, [today])).rows;
    const monthRows = (await query(`SELECT * FROM sales WHERE TO_CHAR(sold_at,'YYYY-MM')=$1`, [ym])).rows;

    const rev  = (rows) => rows.reduce((a,s)=>a + Number(s.sale_price)*Number(s.quantity), 0);
    const prof = (rows) => rows.reduce((a,s)=>a + (Number(s.sale_price)-Number(s.cost_price))*Number(s.quantity), 0);

    const stats = {
      ...inv,
      today_revenue: rev(todayRows),
      today_profit:  prof(todayRows),
      month_revenue: rev(monthRows),
      month_profit:  prof(monthRows),

      // ↓↓↓ جديد: أرقام المخزون
      inv_potential_revenue: Number(inv.total_sale_value || 0),
      inv_potential_profit:  Number(inv.total_sale_value || 0) - Number(inv.total_cost_value || 0),
    };

    const totals = (await query(
      `SELECT
          COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS revenue,
          COALESCE(SUM((s.sale_price - s.cost_price)*s.quantity),0)::float8 AS profit
       FROM sales s
       WHERE s.delivery_status='delivered'`
    )).rows[0];

    const ordersByStatus = (await query(
      `SELECT status, COUNT(*)::int AS cnt FROM orders GROUP BY status`
    )).rows;

    const pendingItems = (await query(
      `SELECT COUNT(*)::int AS cnt
         FROM sales
        WHERE delivery_status IN ('pending','processing','shipping')`
    )).rows[0].cnt;

    const returnsCount = (await query(`SELECT COUNT(*)::int AS cnt FROM returns_queue`)).rows[0].cnt;

    const lowStock = (await query(`
      SELECT * FROM products
      WHERE stock <= 5
      ORDER BY stock ASC, updated_at DESC NULLS LAST, created_at DESC
      LIMIT 12
    `)).rows;

    const topProducts = (await query(
      `SELECT p.id, p.name,
              COALESCE(SUM(s.quantity),0)::int AS qty,
              COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS revenue
         FROM sales s
         JOIN products p ON p.id=s.product_id
        WHERE DATE(s.sold_at) >= DATE($1)
        GROUP BY p.id, p.name
        ORDER BY revenue DESC
        LIMIT 5`,
      [last30]
    )).rows;

    const byCat = (await query(
      `SELECT p.category AS label, COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS value
         FROM products p LEFT JOIN sales s ON s.product_id=p.id
        GROUP BY p.category ORDER BY value DESC`
    )).rows;

    res.render("index", {
      stats, totals, lowStock, byCat,
      ordersByStatus, pendingItems, returnsCount, topProducts, dayjs
    });
  } catch (e) { next(e); }
});


// -------- Products --------
app.get("/products", async (_req, res) => {
  const products = (await query(`SELECT * FROM products ORDER BY created_at DESC`)).rows;

  const returnsList = (
    await query(`
      SELECT r.*, p.name AS product_name, p.image_path AS product_image
      FROM returns_queue r JOIN products p ON p.id=r.product_id
      ORDER BY r.created_at DESC
    `)
  ).rows;

  res.render("products", { products, returnsList, dayjs });
});

// Add product (main + gallery)
app.post("/products", (req, res, next) => {
  const uploader = upload.fields([{ name: "image", maxCount: 1 }, { name: "images", maxCount: 15 }]);
  uploader(req, res, async (err) => {
    try {
      if (err) throw err;
      const { name, brand, category, cost_price, sale_price, stock } = req.body;

      let image_path = null;
      const main = (req.files?.image || [])[0];
      if (main) image_path = main.path || `/public/uploads/${main.filename}`;

      const ins = await query(
        `
        INSERT INTO products (name, brand, category, cost_price, sale_price, stock, image_path, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id
      `,
        [name, brand || "", category || "", Number(cost_price || 0), Number(sale_price || 0), Number(stock || 0), image_path]
      );
      const productId = ins.rows[0].id;

      const extras = req.files?.images || [];
      for (const f of extras) {
        const url = f.path || `/public/uploads/${f.filename}`;
        await query(`INSERT INTO product_images (product_id, url) VALUES ($1,$2)`, [productId, url]);
      }

      res.redirect("/products");
    } catch (e) {
      console.error(e);
      next(e);
    }
  });
});

// Update product
app.post("/products/:id/update", (req, res, next) => {
  const uploader = upload.fields([{ name: "image", maxCount: 1 }, { name: "images", maxCount: 15 }]);
  uploader(req, res, async (err) => {
    try {
      if (err) throw err;
      const id = Number(req.params.id);
      const oldQ = await query(`SELECT * FROM products WHERE id=$1`, [id]);
      if (!oldQ.rowCount) return res.redirect("/products");
      const old = oldQ.rows[0];

      const { name, brand, category, cost_price, sale_price, stock } = req.body;

      let image_path = old.image_path;
      const main = (req.files?.image || [])[0];
      if (main) image_path = main.path || `/public/uploads/${main.filename}`;

      await query(
        `
        UPDATE products
        SET name=$1, brand=$2, category=$3, cost_price=$4, sale_price=$5, stock=$6, image_path=$7, updated_at=NOW()
        WHERE id=$8
      `,
        [
          name || old.name,
          brand ?? old.brand,
          category ?? old.category,
          Number(cost_price ?? old.cost_price),
          Number(sale_price ?? old.sale_price),
          Number(stock ?? old.stock),
          image_path,
          id,
        ]
      );

      const extras = req.files?.images || [];
      for (const f of extras) {
        const url = f.path || `/public/uploads/${f.filename}`;
        await query(`INSERT INTO product_images (product_id, url) VALUES ($1,$2)`, [id, url]);
      }

      res.redirect("/products");
    } catch (e) {
      console.error(e);
      next(e);
    }
  });
});

app.post("/products/:id/stock", async (req, res) => {
  await query(`UPDATE products SET stock = GREATEST(0, stock + $1), updated_at=NOW() WHERE id=$2`, [
    Number(req.body.delta || 0),
    Number(req.params.id),
  ]);
  res.redirect("/products");
});
app.post("/products/:id/delete", async (req, res) => {
  await query(`DELETE FROM products WHERE id=$1`, [Number(req.params.id)]);
  res.redirect("/products");
});
app.post("/products/bulk-delete", async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : String(req.body.ids || "").split(","))
    .map((n) => Number(n))
    .filter(Boolean);
  if (ids.length) await query(`DELETE FROM products WHERE id = ANY($1::int[])`, [ids]);
  res.redirect("/products");
});

// -------- Sales (واجهة المعاملات) --------
app.get("/sales", async (req, res, next) => {
  try {
    const products = (
      await query(
        `SELECT id, name, stock, cost_price, sale_price, image_path, brand, category FROM products ORDER BY name`
      )
    ).rows;

    const orders = (
      await query(`
        SELECT
          o.*,
          COUNT(s.id)::int AS items_count,
          COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS revenue,
          COALESCE(SUM((s.sale_price - s.cost_price)*s.quantity),0)::float8 AS profit
        FROM orders o
        LEFT JOIN sales s ON s.order_id = o.id
        WHERE o.status IN ('pending','processing','shipping')
        GROUP BY o.id
        ORDER BY o.created_at DESC
        LIMIT 30
      `)
    ).rows;

    let openOrders = [];
    if (orders.length) {
      const ids = orders.map((o) => o.id);
      const items = (
        await query(
          `
          SELECT s.*, p.name AS product_name, p.image_path AS product_image
          FROM sales s
          JOIN products p ON p.id = s.product_id
          WHERE s.order_id = ANY($1::int[])
          ORDER BY s.id ASC
        `,
          [ids]
        )
      ).rows.map((r) => ({ ...r, _profit: profitOf(r) }));

      const by = {};
      for (const it of items) (by[it.order_id] = by[it.order_id] || []).push(it);
      openOrders = orders.map((o) => ({ ...o, items: by[o.id] || [] }));
    }

    const flash = req.session.sales_flash || null;
    req.session.sales_flash = null;

    res.render("sales", { products, openOrders, delivered: [], dayjs, flash });
  } catch (e) {
    console.error(e);
    next(e);
  }
});

// إضافة بيع مفرد
app.post("/sales", async (req, res) => {
  const {
    product_id,
    quantity,
    sale_price,
    cost_price,
    shipping_cost,
    note,
    customer_name,
    customer_phone,
    customer_city,
  } = req.body;

  const prodQ = await query(`SELECT * FROM products WHERE id=$1`, [Number(product_id)]);
  if (!prodQ.rowCount) return res.redirect("/sales");
  const prod = prodQ.rows[0];

  const qty = Math.max(1, Number(quantity || 1));

  await query(
    `
    INSERT INTO sales (product_id, quantity, sale_price, cost_price, shipping_cost, note, customer_name, customer_phone, customer_city, delivery_status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
  `,
    [
      prod.id,
      qty,
      Number(sale_price || prod.sale_price),
      Number(cost_price || prod.cost_price),
      Number(shipping_cost || 0),
      note || "",
      (customer_name || "").trim(),
      (customer_phone || "").trim(),
      (customer_city || "").trim(),
    ]
  );

  await query(`UPDATE products SET stock = GREATEST(0, stock - $1), updated_at=NOW() WHERE id=$2`, [
    qty,
    prod.id,
  ]);

  res.redirect("/sales");
});

// === إضافة عدة بنود بيع دفعة واحدة (يدعم رقم الطلب اليدوي) ===
app.post("/sales/multi", async (req, res) => {
  try {
    const {
      product_id = [],
      quantity = [],
      sale_price = [],
      cost_price = [],
      shipping_cost = [],
      item_note = [],
      customer_name = "",
      customer_phone = "",
      customer_city = "",
      order_note = "",
      order_id = ""
    } = req.body;

    const A = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    const PIDS = A(product_id);
    const QTY = A(quantity);
    const SP = A(sale_price);
    const CP = A(cost_price);
    const SH = A(shipping_cost);
    const NT = A(item_note);

    const valid = [];
    const skipped = [];

    for (let i = 0; i < Math.max(PIDS.length, QTY.length, SP.length); i++) {
      const pid = Number(PIDS[i] || 0);
      if (!pid) continue;

      const prodQ = await query(`SELECT * FROM products WHERE id=$1`, [pid]);
      if (!prodQ.rowCount) {
        skipped.push(`ID ${pid} (غير موجود)`);
        continue;
      }
      const prod = prodQ.rows[0];
      const qty = Math.max(1, Number(QTY[i] || 1));

      if (Number(prod.stock || 0) <= 0) {
        skipped.push(`${prod.name} — نفد المخزون`);
        continue;
      }
      if (qty > Number(prod.stock || 0)) {
        skipped.push(`${prod.name} — الكمية المطلوبة (${qty}) أكبر من المتاح (${prod.stock})`);
        continue;
      }

      const sp = Number(SP[i] ?? prod.sale_price ?? 0);
      const cp = Number(CP[i] ?? prod.cost_price ?? 0);
      const sh = Number(SH[i] ?? 0);
      const note = String(NT[i] || "");

      valid.push({ pid, qty, sp, cp, sh, note, prod });
    }

    if (!valid.length) {
      req.session.sales_flash = { type: "danger", msg: "لم يتم إنشاء الطلب: كل البنود نفدت/غير متاحة.", skipped };
      return res.redirect("/sales");
    }

    const requestedId = Number(order_id || 0);
    const orderId = await ensureOrderWithRequestedId({
      requestedId,
      name: customer_name,
      phone: customer_phone,
      city: customer_city,
      note: order_note,
    });

    for (const it of valid) {
      await query(
        `
        INSERT INTO sales (order_id, product_id, quantity, sale_price, cost_price, shipping_cost, note,
                           customer_name, customer_phone, customer_city, delivery_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
      `,
        [
          orderId,
          it.pid,
          it.qty,
          it.sp,
          it.cp,
          it.sh,
          it.note,
          (customer_name || "").trim(),
          (customer_phone || "").trim(),
          (customer_city || "").trim(),
        ]
      );

      await query(`UPDATE products SET stock = GREATEST(0, stock - $1), updated_at=NOW() WHERE id=$2`, [
        it.qty,
        it.pid,
      ]);
    }

    req.session.sales_flash = { type: "success", msg: `تم إنشاء/تحديث الطلب بنجاح (#${orderId}).`, orderId, skipped };
    return res.redirect("/sales");
  } catch (e) {
    console.error("multi-sale error:", e);
    req.session.sales_flash = { type: "danger", msg: "حدث خطأ أثناء إنشاء الطلب." };
    return res.redirect("/sales");
  }
});

// Edit sale
app.get("/sales/:id/edit", async (req, res) => {
  const id = Number(req.params.id);
  const saleQ = await query(
    `
    SELECT s.*, p.name AS product_name, p.image_path AS product_image
    FROM sales s JOIN products p ON p.id=s.product_id
    WHERE s.id=$1
    `,
    [id]
  );
  if (!saleQ.rowCount) return res.redirect("/sales");
  const sale = saleQ.rows[0];
  const products = (
    await query(`SELECT id, name, stock, cost_price, sale_price, image_path FROM products ORDER BY name`)
  ).rows;
  const stockQ = await query(`SELECT stock FROM products WHERE id=$1`, [sale.product_id]);
  const productStock = stockQ.rowCount ? stockQ.rows[0].stock : 0;

  res.render("sales-edit", { sale, products, productStock, dayjs });
});

app.post("/sales/:id/update", async (req, res) => {
  const id = Number(req.params.id);
  const {
    product_id,
    quantity,
    sale_price,
    cost_price,
    shipping_cost,
    note,
    customer_name,
    customer_phone,
    customer_city,
  } = req.body;

  const oldQ = await query(`SELECT * FROM sales WHERE id=$1`, [id]);
  if (!oldQ.rowCount) return res.redirect("/sales");
  const old = oldQ.rows[0];

  await query(
    `
    UPDATE sales
    SET product_id=$1, quantity=$2, sale_price=$3, cost_price=$4, shipping_cost=$5, note=$6,
        customer_name=$7, customer_phone=$8, customer_city=$9
    WHERE id=$10
  `,
    [
      Number(product_id || old.product_id),
      Number(quantity || old.quantity),
      Number(sale_price || old.sale_price),
      Number(cost_price || old.cost_price),
      Number(shipping_cost || old.shipping_cost || 0),
      note ?? old.note,
      (customer_name ?? old.customer_name) || "",
      (customer_phone ?? old.customer_phone) || "",
      (customer_city ?? old.customer_city) || "",
      id,
    ]
  );

  res.redirect("/sales");
});

// Delivery status (مفرد)
app.post("/sales/:id/delivery", async (req, res) => {
  const id = Number(req.params.id);
  const status = (req.body.status || "pending").toLowerCase();
  await query(
    `
    UPDATE sales
    SET delivery_status=$1, delivered_at = CASE WHEN $1='delivered' THEN NOW() ELSE NULL END
    WHERE id=$2
  `,
    [status, id]
  );
  res.redirect("/sales");
});

// عمليات جماعية (بنود)
app.post("/sales/bulk-deliver", async (req, res) => {
  const raw = req.body.ids || "";
  const ids = (Array.isArray(raw) ? raw : String(raw).split(",")).map(Number).filter(Boolean);
  if (ids.length) {
    await query(
      `UPDATE sales
         SET delivery_status='delivered',
             delivered_at = NOW()
       WHERE id = ANY($1::int[])`,
      [ids]
    );
  }
  res.redirect("/sales");
});

// Delete / Return (sales)
app.post("/sales/:id/delete", async (req, res) => {
  await query(`DELETE FROM sales WHERE id=$1`, [Number(req.params.id)]);
  res.redirect("/sales");
});
app.post("/sales/:id/return", async (req, res) => {
  const id = Number(req.params.id);
  const sQ = await query(`SELECT * FROM sales WHERE id=$1`, [id]);
  if (sQ.rowCount) {
    const s = sQ.rows[0];
    await query(
      `
      INSERT INTO returns_queue (sale_id, product_id, quantity, sale_price, cost_price, shipping_cost, note, sold_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `,
      [s.id, s.product_id, s.quantity, s.sale_price, s.cost_price, s.shipping_cost || 0, s.note || "", s.sold_at]
    );
  }
  res.redirect("/sales");
});
app.post("/sales/bulk-delete", async (req, res) => {
  const raw = req.body.ids || "";
  const ids = (Array.isArray(raw) ? raw : String(raw).split(",")).map((n) => Number(n)).filter(Boolean);
  if (ids.length) await query(`DELETE FROM sales WHERE id = ANY($1::int[])`, [ids]);
  res.redirect("/sales");
});
app.post("/sales/bulk-return", async (req, res) => {
  const raw = req.body.ids || "";
  const ids = (Array.isArray(raw) ? raw : String(raw).split(",")).map((n) => Number(n)).filter(Boolean);
  for (const id of ids) {
    const sQ = await query(`SELECT * FROM sales WHERE id=$1`, [id]);
    if (!sQ.rowCount) continue;
    const s = sQ.rows[0];
    await query(
      `
      INSERT INTO returns_queue (sale_id, product_id, quantity, sale_price, cost_price, shipping_cost, note, sold_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `,
      [s.id, s.product_id, s.quantity, s.sale_price, s.cost_price, s.shipping_cost || 0, s.note || "", s.sold_at]
    );
  }
  res.redirect("/sales");
});

// -------- Orders (الطلبات متعددة البنود) --------
app.get("/orders", async (req, res) => {
  const filters = {
    status: String(req.query.status || "all").toLowerCase(),
  };

  const ALLOWED = ["pending", "processing", "shipping", "delivered", "failed"];
  const where = ALLOWED.includes(filters.status) ? "WHERE o.status = $1" : "";
  const params = ALLOWED.includes(filters.status) ? [filters.status] : [];

  const orders = (
    await query(
      `
      SELECT
        o.*,
        COUNT(s.id)::int AS items_count,
        COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS revenue,
        COALESCE(SUM((s.sale_price - s.cost_price)*s.quantity),0)::float8 AS profit
      FROM orders o
      LEFT JOIN sales s ON s.order_id = o.id
      ${where}
      GROUP BY o.id
      ORDER BY o.created_at DESC
      `,
      params
    )
  ).rows;

  let itemsByOrder = {};
  if (orders.length) {
    const ids = orders.map((o) => o.id);
    const items = (
      await query(
        `
        SELECT s.order_id, s.quantity, s.sale_price, s.cost_price, s.shipping_cost, s.delivery_status,
               p.name AS product_name, p.image_path AS product_image
        FROM sales s
        JOIN products p ON p.id = s.product_id
        WHERE s.order_id = ANY($1::int[])
        ORDER BY s.id
        `,
        [ids]
      )
    ).rows;
    for (const it of items) (itemsByOrder[it.order_id] ||= []).push(it);
  }

  res.render("orders", { orders, itemsByOrder, dayjs, filters });
});

// أكشنات جماعية على الطلبات
app.post("/orders/bulk-status", async (req, res) => {
  const raw = req.body.ids || [];
  const ids = (Array.isArray(raw) ? raw : String(raw).split(",")).map(Number).filter(Boolean);
  if (!ids.length) return res.redirect("/orders");

  const wanted = String(req.body.status || "pending").toLowerCase();
  const normalize = { pending: "pending", processing: "processing", shipping: "shipping", delivered: "delivered", failed: "failed", not_delivered: "failed" };
  const status = normalize[wanted] || "pending";
  const applyToItems = String(req.body.apply_to_items || "on") === "on";

  await query(`UPDATE orders SET status=$1 WHERE id = ANY($2::int[])`, [status, ids]);

  if (applyToItems) {
    const itemStatus = status === "processing" ? "pending" : status;
    await query(
      `UPDATE sales
         SET delivery_status=$1,
             delivered_at = CASE WHEN $1='delivered' THEN NOW() ELSE NULL END
       WHERE order_id = ANY($2::int[])`,
      [itemStatus, ids]
    );
  }

  res.redirect("/orders");
});

app.post("/orders/bulk-return", async (req, res) => {
  const raw = req.body.ids || [];
  const ids = (Array.isArray(raw) ? raw : String(raw).split(",")).map(Number).filter(Boolean);
  if (!ids.length) return res.redirect("/orders");

  for (const oid of ids) {
    const items = (await query(`SELECT * FROM sales WHERE order_id=$1`, [oid])).rows;
    for (const s of items) {
      await query(
        `INSERT INTO returns_queue (sale_id, product_id, quantity, sale_price, cost_price, shipping_cost, note, sold_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [s.id, s.product_id, s.quantity, s.sale_price, s.cost_price, s.shipping_cost || 0, s.note || "", s.sold_at]
      );
    }
  }

  res.redirect("/orders");
});

// حذف طلبات (جماعي)
app.post("/orders/bulk-delete", async (req, res) => {
  const raw = req.body.ids || [];
  const ids = (Array.isArray(raw) ? raw : String(raw).split(",")).map(Number).filter(Boolean);
  if (!ids.length) return res.redirect("/orders");

  await query(`DELETE FROM sales  WHERE order_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM orders WHERE id       = ANY($1::int[])`, [ids]);
  res.redirect("/orders");
});

// نموذج طلب جديد
app.get("/orders/new", async (_req, res) => {
  const products = (await query(`SELECT id, name, stock, cost_price, sale_price, image_path FROM products ORDER BY name`)).rows;
  res.render("orders-new", { products, dayjs });
});

// إنشاء طلب جديد (+ بنود) مع دعم رقم الطلب اليدوي
app.post("/orders", async (req, res) => {
  const {
    order_id,
    customer_name,
    customer_phone,
    customer_city,
    note,
    product_id = [],
    quantity = [],
    sale_price = [],
    cost_price = [],
    shipping_cost = [],
    item_note = [],
  } = req.body;

  const manualId = Number(order_id || 0) > 0 ? Number(order_id) : null;
  let orderId;

  if (manualId) {
    const exists = await query(`SELECT id FROM orders WHERE id=$1`, [manualId]);
    if (!exists.rowCount) {
      await query(
        `INSERT INTO orders (id, customer_name, customer_phone, customer_city, note, status)
         VALUES ($1,$2,$3,$4,$5,'pending')`,
        [manualId, (customer_name || "").trim(), (customer_phone || "").trim(), (customer_city || "").trim(), (note || "").trim()]
      );
      await query(
        `SELECT setval(pg_get_serial_sequence('orders','id'), (SELECT GREATEST(COALESCE(MAX(id),0), $1) FROM orders))`,
        [manualId]
      );
    } else {
      await query(
        `UPDATE orders SET customer_name=$1, customer_phone=$2, customer_city=$3, note=$4 WHERE id=$5`,
        [(customer_name || "").trim(), (customer_phone || "").trim(), (customer_city || "").trim(), (note || "").trim(), manualId]
      );
    }
    orderId = manualId;
  } else {
    const ins = await query(
      `INSERT INTO orders (customer_name, customer_phone, customer_city, note, status)
       VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
      [(customer_name || "").trim(), (customer_phone || "").trim(), (customer_city || "").trim(), (note || "").trim()]
    );
    orderId = ins.rows[0].id;
  }

  const count = Math.max([].concat(product_id).length, [].concat(quantity).length);
  for (let i = 0; i < count; i++) {
    const pid = Number([].concat(product_id)[i]);
    if (!pid) continue;

    const prodQ = await query(`SELECT * FROM products WHERE id=$1`, [pid]);
    if (!prodQ.rowCount) continue;
    const prod = prodQ.rows[0];

    const qty = Math.max(1, Number([].concat(quantity)[i] || 1));
    const sp = Number([].concat(sale_price)[i] || prod.sale_price || 0);
    const cp = Number([].concat(cost_price)[i] || prod.cost_price || 0);
    const ship = Number([].concat(shipping_cost)[i] || 0);
    const inote = String([].concat(item_note)[i] || "");

    await query(
      `INSERT INTO sales (order_id, product_id, quantity, sale_price, cost_price, shipping_cost, note,
                          customer_name, customer_phone, customer_city, delivery_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
      [orderId, pid, qty, sp, cp, ship, inote, (customer_name || "").trim(), (customer_phone || "").trim(), (customer_city || "").trim()]
    );

    await query(`UPDATE products SET stock = GREATEST(0, stock - $1), updated_at=NOW() WHERE id=$2`, [qty, pid]);
  }

  res.redirect(`/orders/${orderId}`);
});

// عرض تفاصيل طلب
app.get("/orders/:id", async (req, res) => {
  const id = Number(req.params.id);
  const orderQ = await query(`SELECT * FROM orders WHERE id=$1`, [id]);
  if (!orderQ.rowCount) return res.redirect("/orders");
  const order = orderQ.rows[0];

  const items = (
    await query(
      `SELECT s.*, p.name AS product_name, p.image_path AS product_image
       FROM sales s JOIN products p ON p.id=s.product_id
       WHERE s.order_id=$1 ORDER BY s.id ASC`,
      [id]
    )
  ).rows;

  const products = (await query(`SELECT id, name, stock, cost_price, sale_price, image_path FROM products ORDER BY name`)).rows;

  const revenue = items.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const profit  = items.reduce((a, s) => a + (Number(s.sale_price) * Number(s.quantity) - Number(s.cost_price) * Number(s.quantity)), 0);

  res.render("orders-view", { order, items, products, revenue, profit, dayjs });
});

// إضافة بند جديد لطلب
app.post("/orders/:id/items", async (req, res) => {
  const id = Number(req.params.id);
  const orderQ = await query(`SELECT * FROM orders WHERE id=$1`, [id]);
  if (!orderQ.rowCount) return res.redirect("/orders");

  const { product_id, quantity, sale_price, cost_price, shipping_cost, note } = req.body;
  const pid = Number(product_id);
  const prodQ = await query(`SELECT * FROM products WHERE id=$1`, [pid]);
  if (!prodQ.rowCount) return res.redirect(`/orders/${id}`);
  const prod = prodQ.rows[0];

  const qty = Math.max(1, Number(quantity || 1));
  const sp = Number(sale_price || prod.sale_price || 0);
  const cp = Number(cost_price || prod.cost_price || 0);
  const ship = Number(shipping_cost || 0);

  await query(
    `INSERT INTO sales (order_id, product_id, quantity, sale_price, cost_price, shipping_cost, note,
                        customer_name, customer_phone, customer_city, delivery_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
    [id, pid, qty, sp, cp, ship, note || "", orderQ.rows[0].customer_name || "", orderQ.rows[0].customer_phone || "", orderQ.rows[0].customer_city || ""]
  );
  await query(`UPDATE products SET stock = GREATEST(0, stock - $1), updated_at=NOW() WHERE id=$2`, [qty, pid]);

  res.redirect(`/orders/${id}`);
});

// تحديث/حذف عدة بنود دفعة واحدة (delete_ids[] آمن)
app.post("/orders/:id/items/bulk-update", async (req, res) => {
  const id = Number(req.params.id);
  const {
    item_id = [],
    product_id = [],
    quantity = [],
    sale_price = [],
    cost_price = [],
    shipping_cost = [],
    item_note = [],
    delete_ids = []
  } = req.body;

  const A = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

  const IDS  = A(item_id).map(Number).filter(Boolean);
  const PID  = A(product_id);
  const QTY  = A(quantity);
  const SP   = A(sale_price);
  const CP   = A(cost_price);
  const SH   = A(shipping_cost);
  const NOTE = A(item_note);
  const DEL  = new Set(A(delete_ids).map(Number).filter(Boolean));

  // حذف أوّلاً
  if (DEL.size) {
    await query(
      `DELETE FROM sales WHERE order_id=$1 AND id = ANY($2::int[])`,
      [id, [...DEL]]
    );
  }

  // تحديث الباقي
  for (let i = 0; i < IDS.length; i++) {
    const sid = Number(IDS[i]);
    if (!sid || DEL.has(sid)) continue;

    await query(
      `UPDATE sales
         SET product_id=$1,
             quantity=$2,
             sale_price=$3,
             cost_price=$4,
             shipping_cost=$5,
             note=$6
       WHERE id=$7 AND order_id=$8`,
      [
        Number(PID[i] || 0),
        Math.max(1, Number(QTY[i] || 1)),
        Number(SP[i] || 0),
        Number(CP[i] || 0),
        Number(SH[i] || 0),
        String(NOTE[i] || ""),
        sid,
        id,
      ]
    );
  }

  return res.redirect(`/orders/${id}`);
});

// تغيير حالة الطلب ككل
app.post("/orders/:id/status", async (req, res) => {
  const id = Number(req.params.id);
  const { status = "pending", apply_to_items = "off" } = req.body;
  await query(`UPDATE orders SET status=$1 WHERE id=$2`, [status, id]);
  if (apply_to_items === "on") {
    const itemStatus = status === "processing" ? "pending" : status;
    await query(
      `UPDATE sales
         SET delivery_status=$1, delivered_at = CASE WHEN $1='delivered' THEN NOW() ELSE NULL END
       WHERE order_id=$2`,
      [itemStatus, id]
    );
  }
  res.redirect(`/orders/${id}`);
});

// ===== تعديل بيانات الطلب + تغيير رقم الطلب اختياري =====
app.post("/orders/:id/update", async (req, res) => {
  const currentId = Number(req.params.id);
  const {
    order_id: newIdRaw,
    customer_name = "",
    customer_phone = "",
    customer_city = "",
    note = ""
  } = req.body;

  const wantedId = Number(newIdRaw || currentId) || currentId;

  try {
    await query("BEGIN");

    let finalId = currentId;

    // إن أراد المستخدم رقماً جديداً وغير مستخدم
    if (wantedId !== currentId) {
      const exists = await query(`SELECT 1 FROM orders WHERE id=$1`, [wantedId]);
      if (exists.rowCount) {
        await query("ROLLBACK");
        return res.redirect(`/orders/${currentId}?err=exists`);
      }

      await query(`UPDATE sales SET order_id=$1 WHERE order_id=$2`, [wantedId, currentId]);
      await query(`UPDATE orders SET id=$1 WHERE id=$2`, [wantedId, currentId]);

      await query(
        `SELECT setval(
           pg_get_serial_sequence('orders','id'),
           (SELECT GREATEST(COALESCE(MAX(id),0), $1) FROM orders)
         )`,
        [wantedId]
      );

      finalId = wantedId;
    }

    await query(
      `UPDATE orders
         SET customer_name=$1, customer_phone=$2, customer_city=$3, note=$4
       WHERE id=$5`,
      [customer_name.trim(), customer_phone.trim(), customer_city.trim(), note.trim(), finalId]
    );

    await query("COMMIT");
    return res.redirect(`/orders/${finalId}`);
  } catch (e) {
    console.error("order update error:", e);
    await query("ROLLBACK");
    return res.redirect(`/orders/${currentId}`);
  }
});

// حذف طلب مفرد
app.post("/orders/:id/delete", async (req, res) => {
  const id = Number(req.params.id);
  await query(`DELETE FROM sales  WHERE order_id=$1`, [id]);
  await query(`DELETE FROM orders WHERE id=$1`,       [id]);
  res.redirect("/orders");
});

// حذف بند من الطلب
app.post("/orders/:id/items/:itemId/delete", async (req, res) => {
  const id = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  await query(`DELETE FROM sales WHERE id=$1 AND order_id=$2`, [itemId, id]);
  res.redirect(`/orders/${id}`);
});

// -------- Returns actions --------
app.post("/returns/:id/restock", async (req, res) => {
  const id = Number(req.params.id);
  const rQ = await query(`SELECT * FROM returns_queue WHERE id=$1`, [id]);
  if (rQ.rowCount) {
    const r = rQ.rows[0];
    await query(`UPDATE products SET stock = stock + $1, updated_at=NOW() WHERE id=$2`, [r.quantity, r.product_id]);
    await query(`DELETE FROM returns_queue WHERE id=$1`, [id]);
  }
  res.redirect("/products");
});
app.post("/returns/:id/reorder", async (req, res) => {
  const id = Number(req.params.id);
  const rQ = await query(`SELECT * FROM returns_queue WHERE id=$1`, [id]);
  if (rQ.rowCount) {
    const r = rQ.rows[0];
    await query(`UPDATE products SET stock = GREATEST(0, stock - $1), updated_at=NOW() WHERE id=$2`, [
      r.quantity,
      r.product_id,
    ]);
    await query(
      `INSERT INTO sales (product_id, quantity, sale_price, cost_price, shipping_cost, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.product_id, r.quantity, r.sale_price, r.cost_price, r.shipping_cost || 0, (r.note || "") + " (من طلب راجع)"]
    );
    await query(`DELETE FROM returns_queue WHERE id=$1`, [id]);
  }
  res.redirect("/products");
});
app.post("/returns/:id/delete", async (req, res) => {
  await query(`DELETE FROM returns_queue WHERE id=$1`, [Number(req.params.id)]);
  res.redirect("/products");
});

// -------- Reports (HTML) — فقط تم التسليم --------
app.get("/reports", async (req, res) => {
  const { range = "daily", year, month, day } = req.query;

  let rows = [], title = "";
  if (range === "monthly") {
    const y = Number(year) || Number(dayjs().tz(TZ_NAME).format("YYYY"));
    const m = Number(month) || Number(dayjs().tz(TZ_NAME).format("MM"));
    const ym = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    title = `تقرير شهري (تم التسليم) ${ym}`;

    rows = (
      await query(
        `SELECT s.*, p.name AS product_name, p.image_path AS product_image
         FROM sales s JOIN products p ON p.id = s.product_id
         WHERE s.delivery_status = 'delivered'
           AND TO_CHAR(COALESCE(s.delivered_at, s.sold_at), 'YYYY-MM') = $1
         ORDER BY COALESCE(s.delivered_at, s.sold_at) DESC`,
        [ym]
      )
    ).rows;
  } else {
    const y = Number(year) || Number(dayjs().tz(TZ_NAME).format("YYYY"));
    const m = Number(month) || Number(dayjs().tz(TZ_NAME).format("MM"));
    const d = Number(day) || Number(dayjs().tz(TZ_NAME).format("DD"));
    const ds = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    title = `تقرير يومي (تم التسليم) ${ds}`;

    rows = (
      await query(
        `SELECT s.*, p.name AS product_name, p.image_path AS product_image
         FROM sales s JOIN products p ON p.id = s.product_id
         WHERE s.delivery_status = 'delivered'
           AND DATE(COALESCE(s.delivered_at, s.sold_at)) = DATE($1)
         ORDER BY COALESCE(s.delivered_at, s.sold_at) DESC`,
        [ds]
      )
    ).rows;
  }

  res.render("reports", {
    title,
    rows,
    range,
    selected: {
      year: Number(year) || Number(dayjs().tz(TZ_NAME).format("YYYY")),
      month: Number(month) || Number(dayjs().tz(TZ_NAME).format("MM")),
      day: Number(day) || Number(dayjs().tz(TZ_NAME).format("DD")),
    },
  });
});

// ========= معالج أخطاء عام =========
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(`<pre>Server error:\n${err?.message || err}\n\n${err?.stack || ""}</pre>`);
});

// ================== بدء التشغيل ==================
app.listen(PORT, HOST, () => {
  console.log(`✅ Abrar Store running on http://${HOST}:${PORT}`);
});
