// server.js — CommonJS, جاهز للعمل على نفس المشروع السابق
require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const expressLayouts = require("express-ejs-layouts");
const { Pool } = require("pg");

const dayjsBase = require("dayjs");
const utc = require("dayjs/plugin/utc");
const tz = require("dayjs/plugin/timezone");

// ============== Dayjs ==============
const dayjs = dayjsBase;
dayjs.extend(utc);
dayjs.extend(tz);
const TZ_NAME = process.env.TZ_NAME || "Asia/Hebron";
if (dayjs.tz?.setDefault) dayjs.tz.setDefault(TZ_NAME);

// ============== App/DB ==============
const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/postgres",
  ssl:
    (process.env.DATABASE_URL || "").includes("render.com") ||
    process.env.PGSSL === "1"
      ? { rejectUnauthorized: false }
      : undefined,
});
async function query(sql, params = []) {
  const c = await pool.connect();
  try {
    return await c.query(sql, params);
  } finally {
    c.release();
  }
}

// ============== Auth config ==============
const AUTH_ENABLED = (process.env.AUTH_ENABLED ?? "1") !== "0";
const AUTH_USER = process.env.AUTH_USER || "abrar";
const AUTH_PASS = process.env.AUTH_PASS || "1143";

// ============== Migrations (idempotent) ==============
async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS products(
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT, category TEXT,
      cost_price NUMERIC(12,2) DEFAULT 0,
      sale_price NUMERIC(12,2) DEFAULT 0,
      stock INT DEFAULT 0,
      image_path TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );`);
  await query(`
    CREATE TABLE IF NOT EXISTS orders(
      id SERIAL PRIMARY KEY,
      customer_name TEXT, customer_phone TEXT, customer_city TEXT,
      note TEXT, status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await query(`
    CREATE TABLE IF NOT EXISTS sales(
      id SERIAL PRIMARY KEY,
      order_id INT REFERENCES orders(id) ON DELETE SET NULL,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INT NOT NULL,
      sale_price NUMERIC(12,2) NOT NULL,
      cost_price NUMERIC(12,2) NOT NULL,
      shipping_cost NUMERIC(12,2) DEFAULT 0,
      note TEXT,
      sold_at TIMESTAMPTZ DEFAULT NOW(),
      customer_name TEXT, customer_phone TEXT, customer_city TEXT,
      delivery_status TEXT DEFAULT 'pending',
      delivered_at TIMESTAMPTZ
    );`);
  await query(`
    CREATE TABLE IF NOT EXISTS returns_queue(
      id SERIAL PRIMARY KEY,
      sale_id INT,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INT NOT NULL,
      sale_price NUMERIC(12,2) NOT NULL,
      cost_price NUMERIC(12,2) NOT NULL,
      shipping_cost NUMERIC(12,2) DEFAULT 0,
      note TEXT, sold_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  await query(`
    CREATE TABLE IF NOT EXISTS product_images(
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );`);
  console.log("✅ DB ready");
}
migrate().catch(console.error);

// ============== Uploads ==============
const uploadsDir = path.join(__dirname, "public", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_r, _f, cb) => cb(null, uploadsDir),
  filename: (_r, f, cb) => {
    const ext = (f.originalname || "").split(".").pop() || "jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`);
  },
});
const fileFilter = (_r, f, cb) =>
  f?.mimetype?.startsWith("image/")
    ? cb(null, true)
    : cb(new Error("images only"), false);
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ============== Views/Middleware ==============
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

// ثوابت مشتركة لكل القوالب
app.use((req, res, next) => {
  res.locals.faLink =
    "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css";
  res.locals.dayjs = dayjs;
  res.locals.currentPath = req.path;
  res.locals.fixImg = (u) => {
    try {
      if (!u) return "https://placehold.co/80x80?text=No+Img";
      if (/^https?:\/\//i.test(u)) return u;
      if (u.startsWith("/public/")) return u;
      return `/public/uploads/${u.replace(/^\/+/, "")}`;
    } catch {
      return "https://placehold.co/80x80?text=No+Img";
    }
  };
  next();
});

// ============== Sessions/Auth ==============
const PgStore = connectPgSimple(session);
app.set("trust proxy", 1);
app.use(
  session({
    store: new PgStore({
      pool,
      tableName: "session",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "abrar_store_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);

const openPaths = new Set(["/login", "/logout", "/healthz"]);
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (openPaths.has(req.path) || req.path.startsWith("/public")) return next();
  if (/\.(css|js|png|jpg|jpeg|gif|webp|svg|ico|woff2?)$/i.test(req.path)) return next();
  if (req.session?.user) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl || "/")}`);
}
app.use(requireAuth);

app.get("/login", (req, res) => {
  if (req.session.user) return res.redirect(req.query.next || "/");
  res.render("login", { error: null, next: req.query.next || "/", usernamePrefill: "" });
});
app.post("/login", (req, res) => {
  const { username = "", password = "", next = "/" } = req.body || {};
  if (username !== AUTH_USER)
    return res
      .status(401)
      .render("login", { error: "❌ اسم المستخدم غير صحيح", next, usernamePrefill: username });
  if (password !== AUTH_PASS)
    return res
      .status(401)
      .render("login", { error: "❌ كلمة المرور غير صحيحة", next, usernamePrefill: username });
  req.session.user = { username };
  res.redirect(next || "/");
});
app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
app.get("/healthz", (_req, res) => res.send("OK"));

// ============== Helpers ==============
const profitOf = (s) =>
  Number(s.sale_price) * Number(s.quantity) -
  Number(s.cost_price) * Number(s.quantity); // بدون الشحن

// ============== Routes ==============

// ---- Dashboard ----
app.get("/", async (_req, res) => {
  const statsQ = await query(`
    SELECT COUNT(*)::int AS products_count,
           COALESCE(SUM(stock),0)::int AS total_units,
           COALESCE(SUM(stock*cost_price),0)::float8 AS total_cost_value,
           COALESCE(SUM(stock*sale_price),0)::float8 AS total_sale_value
    FROM products`);
  const today = dayjs().tz(TZ_NAME).format("YYYY-MM-DD");
  const ym = dayjs().tz(TZ_NAME).format("YYYY-MM");
  const todayRows = (await query(`SELECT * FROM sales WHERE DATE(s.sold_at)=DATE($1)`, [today])).rows;
  const monthRows = (await query(`SELECT * FROM sales WHERE TO_CHAR(sold_at,'YYYY-MM')=$1`, [ym])).rows;
  const rev = (rows) => rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const prof = (rows) => rows.reduce((a, s) => a + profitOf(s), 0);

  const stats = {
    ...statsQ.rows[0],
    today_revenue: rev(todayRows),
    today_profit: prof(todayRows),
    month_revenue: rev(monthRows),
    month_profit: prof(monthRows),
  };

  const lastSales = (
    await query(`
      SELECT s.*, p.name AS product_name, p.image_path AS product_image
      FROM sales s JOIN products p ON p.id=s.product_id
      ORDER BY s.sold_at DESC LIMIT 10`)
  ).rows;

  const lowStock = (
    await query(`
      SELECT * FROM products
      WHERE stock <= 5
      ORDER BY stock ASC, updated_at DESC NULLS LAST, created_at DESC
      LIMIT 12`)
  ).rows;

  const byCat = (
    await query(`
      SELECT p.category AS label, COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS value
      FROM products p LEFT JOIN sales s ON s.product_id=p.id
      GROUP BY p.category
      ORDER BY value DESC`)
  ).rows;

  res.render("index", { stats, byCat, lowStock, lastSales, dayjs });
});

// ---- Products ----
app.get("/products", async (_req, res) => {
  const products = (await query(`SELECT * FROM products ORDER BY created_at DESC`)).rows;
  const returnsList = (
    await query(`
      SELECT r.*, p.name AS product_name, p.image_path AS product_image
      FROM returns_queue r JOIN products p ON p.id=r.product_id
      ORDER BY r.created_at DESC`)
  ).rows;
  res.render("products", { products, returnsList, dayjs });
});

app.post("/products", (req, res, next) => {
  const uploader = upload.fields([
    { name: "image", maxCount: 1 },
    { name: "images", maxCount: 15 },
  ]);
  uploader(req, res, async (err) => {
    try {
      if (err) throw err;
      const { name, brand, category, cost_price, sale_price, stock } = req.body;
      let image_path = null;
      const main = (req.files?.image || [])[0];
      if (main) image_path = `/public/uploads/${main.filename}`;

      const ins = await query(
        `INSERT INTO products (name,brand,category,cost_price,sale_price,stock,image_path,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
        [name, brand||"", category||"", Number(cost_price||0), Number(sale_price||0), Number(stock||0), image_path]
      );
      const pid = ins.rows[0].id;

      for (const f of (req.files?.images || [])) {
        await query(`INSERT INTO product_images (product_id,url) VALUES ($1,$2)`, [
          pid,
          `/public/uploads/${f.filename}`,
        ]);
      }
      res.redirect("/products");
    } catch (e) { next(e); }
  });
});

app.post("/products/:id/update", (req, res, next) => {
  const uploader = upload.fields([
    { name: "image", maxCount: 1 },
    { name: "images", maxCount: 15 },
  ]);
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
      if (main) image_path = `/public/uploads/${main.filename}`;

      await query(
        `UPDATE products SET
           name=$1, brand=$2, category=$3,
           cost_price=$4, sale_price=$5, stock=$6, image_path=$7, updated_at=NOW()
         WHERE id=$8`,
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

      for (const f of (req.files?.images || [])) {
        await query(`INSERT INTO product_images (product_id,url) VALUES ($1,$2)`, [
          id,
          `/public/uploads/${f.filename}`,
        ]);
      }
      res.redirect("/products");
    } catch (e) { next(e); }
  });
});
app.post("/products/:id/stock", async (req, res) => {
  await query(
    `UPDATE products SET stock=GREATEST(0,stock+$1), updated_at=NOW() WHERE id=$2`,
    [Number(req.body.delta || 0), Number(req.params.id)]
  );
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

// ---- Sales page (إضافة طلب + الطلبات المفتوحة + المبيعات) ----
app.get("/sales", async (_req, res) => {
  const products = (
    await query(`SELECT id,name,stock,cost_price,sale_price,image_path FROM products ORDER BY name`)
  ).rows;

  const openOrders = (
    await query(`
      SELECT o.*,
             COUNT(s.id)::int AS items_count,
             COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS revenue,
             COALESCE(SUM((s.sale_price - s.cost_price)*s.quantity),0)::float8 AS profit
      FROM orders o LEFT JOIN sales s ON s.order_id=o.id
      WHERE o.status IN ('pending','shipping')
      GROUP BY o.id ORDER BY o.created_at DESC`)
  ).rows;

  const deliveredSales = (
    await query(`
      SELECT s.*, p.name AS product_name, p.image_path AS product_image
      FROM sales s JOIN products p ON p.id=s.product_id
      WHERE s.delivery_status='delivered'
      ORDER BY s.delivered_at DESC NULLS LAST, s.sold_at DESC`)
  ).rows;

  res.render("sales", { products, openOrders, deliveredSales, dayjs });
});

// إضافة بيع مفرد
app.post("/sales", async (req, res) => {
  const {
    product_id, quantity, sale_price, cost_price, shipping_cost, note,
    customer_name, customer_phone, customer_city,
  } = req.body;

  const prod = (await query(`SELECT * FROM products WHERE id=$1`, [Number(product_id)])).rows[0];
  if (!prod) return res.redirect("/sales");

  const qty = Math.max(1, Number(quantity || 1));

  await query(
    `INSERT INTO sales(product_id,quantity,sale_price,cost_price,shipping_cost,note,customer_name,customer_phone,customer_city,delivery_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
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

  await query(`UPDATE products SET stock=GREATEST(0, stock-$1), updated_at=NOW() WHERE id=$2`, [
    qty,
    prod.id,
  ]);

  res.redirect("/sales");
});

// إضافة عدة بنود دفعة واحدة
app.post("/sales/multi", async (req, res) => {
  try {
    const {
      product_id = [], quantity = [], sale_price = [],
      cost_price = [], shipping_cost = [], item_note = [],
      customer_name = "", customer_phone = "", customer_city = "",
    } = req.body;

    const n = Math.max(
      [].concat(product_id).length,
      [].concat(quantity).length,
      [].concat(sale_price).length
    );

    for (let i = 0; i < n; i++) {
      const pid = Number([].concat(product_id)[i]);
      if (!pid) continue;

      const prod = (await query(`SELECT * FROM products WHERE id=$1`, [pid])).rows[0];
      if (!prod) continue;

      const qty  = Math.max(1, Number([].concat(quantity)[i] || 1));
      const sp   = Number([].concat(sale_price)[i] || prod.sale_price || 0);
      const cp   = Number([].concat(cost_price)[i] || prod.cost_price || 0);
      const ship = Number([].concat(shipping_cost)[i] || 0);
      const note = String([].concat(item_note)[i] || "");

      await query(
        `INSERT INTO sales(product_id,quantity,sale_price,cost_price,shipping_cost,note,customer_name,customer_phone,customer_city,delivery_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`,
        [pid, qty, sp, cp, ship, note, (customer_name||"").trim(), (customer_phone||"").trim(), (customer_city||"").trim()]
      );

      await query(`UPDATE products SET stock=GREATEST(0,stock-$1), updated_at=NOW() WHERE id=$2`, [
        qty,
        pid,
      ]);
    }

    res.redirect("/sales");
  } catch (e) {
    console.error("multi error:", e);
    res.redirect("/sales");
  }
});

// تعديل بند
app.get("/sales/:id/edit", async (req, res) => {
  const id = Number(req.params.id);
  const sale = (
    await query(
      `SELECT s.*, p.name AS product_name, p.image_path AS product_image
       FROM sales s JOIN products p ON p.id=s.product_id WHERE s.id=$1`,
      [id]
    )
  ).rows[0];
  if (!sale) return res.redirect("/sales");
  const products = (
    await query(`SELECT id,name,stock,cost_price,sale_price,image_path FROM products ORDER BY name`)
  ).rows;
  const stockQ = await query(`SELECT stock FROM products WHERE id=$1`, [sale.product_id]);
  const productStock = stockQ.rowCount ? stockQ.rows[0].stock : 0;
  res.render("sales-edit", { sale, products, productStock, dayjs });
});
app.post("/sales/:id/update", async (req, res) => {
  const id = Number(req.params.id);
  const {
    product_id, quantity, sale_price, cost_price, shipping_cost, note,
    customer_name, customer_phone, customer_city,
  } = req.body;

  const old = (await query(`SELECT * FROM sales WHERE id=$1`, [id])).rows[0];
  if (!old) return res.redirect("/sales");

  await query(
    `UPDATE sales SET product_id=$1, quantity=$2, sale_price=$3, cost_price=$4, shipping_cost=$5, note=$6,
                      customer_name=$7, customer_phone=$8, customer_city=$9
     WHERE id=$10`,
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
app.post("/sales/:id/delivery", async (req, res) => {
  const id = Number(req.params.id);
  const status = (req.body.status || "pending").toLowerCase();
  await query(
    `UPDATE sales
     SET delivery_status=$1,
         delivered_at = CASE WHEN $1='delivered' THEN NOW() ELSE NULL END
     WHERE id=$2`,
    [status, id]
  );
  res.redirect("back");
});
app.post("/sales/:id/delete", async (req, res) => {
  await query(`DELETE FROM sales WHERE id=$1`, [Number(req.params.id)]);
  res.redirect("back");
});
app.post("/sales/:id/return", async (req, res) => {
  const id = Number(req.params.id);
  const s = (await query(`SELECT * FROM sales WHERE id=$1`, [id])).rows[0];
  if (s) {
    await query(
      `INSERT INTO returns_queue(sale_id,product_id,quantity,sale_price,cost_price,shipping_cost,note,sold_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [s.id, s.product_id, s.quantity, s.sale_price, s.cost_price, s.shipping_cost||0, s.note||"", s.sold_at]
    );
  }
  res.redirect("back");
});

// ---- Orders ----
app.get("/orders", async (_req, res) => {
  const orders = (
    await query(`
      SELECT o.*,
             COUNT(s.id)::int AS items_count,
             COALESCE(SUM(s.quantity*s.sale_price),0)::float8 AS revenue,
             COALESCE(SUM((s.sale_price - s.cost_price)*s.quantity),0)::float8 AS profit
      FROM orders o LEFT JOIN sales s ON s.order_id=o.id
      GROUP BY o.id ORDER BY o.created_at DESC`)
  ).rows;
  res.render("orders", { orders, dayjs });
});

app.get("/orders/new", async (_req, res) => {
  const products = (
    await query(`SELECT id,name,stock,cost_price,sale_price,image_path FROM products ORDER BY name`)
  ).rows;
  res.render("orders-new", { products, dayjs });
});

app.post("/orders", async (req, res) => {
  const {
    customer_name, customer_phone, customer_city, note,
    product_id = [], quantity = [], sale_price = [],
    cost_price = [], shipping_cost = [], item_note = [],
  } = req.body;

  const ins = await query(
    `INSERT INTO orders(customer_name,customer_phone,customer_city,note,status)
     VALUES($1,$2,$3,$4,'pending') RETURNING id`,
    [(customer_name||"").trim(), (customer_phone||"").trim(), (customer_city||"").trim(), (note||"").trim()]
  );
  const orderId = ins.rows[0].id;

  const n = Math.max([].concat(product_id).length, [].concat(quantity).length);
  for (let i = 0; i < n; i++) {
    const pid = Number([].concat(product_id)[i]); if (!pid) continue;
    const p = (await query(`SELECT * FROM products WHERE id=$1`, [pid])).rows[0]; if (!p) continue;

    const qty = Math.max(1, Number([].concat(quantity)[i] || 1));
    const sp  = Number([].concat(sale_price)[i] || p.sale_price || 0);
    const cp  = Number([].concat(cost_price)[i] || p.cost_price || 0);
    const sh  = Number([].concat(shipping_cost)[i] || 0);
    const nt  = String([].concat(item_note)[i] || "");

    await query(
      `INSERT INTO sales(order_id,product_id,quantity,sale_price,cost_price,shipping_cost,note,customer_name,customer_phone,customer_city,delivery_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')`,
      [orderId, pid, qty, sp, cp, sh, nt, (customer_name||"").trim(), (customer_phone||"").trim(), (customer_city||"").trim()]
    );

    await query(`UPDATE products SET stock=GREATEST(0,stock-$1), updated_at=NOW() WHERE id=$2`, [qty, pid]);
  }

  res.redirect(`/orders/${orderId}`);
});

app.get("/orders/:id", async (req, res) => {
  const id = Number(req.params.id);
  const order = (await query(`SELECT * FROM orders WHERE id=$1`, [id])).rows[0];
  if (!order) return res.redirect("/orders");

  const items = (
    await query(
      `SELECT s.*, p.name AS product_name, p.image_path AS product_image
       FROM sales s JOIN products p ON p.id=s.product_id
       WHERE s.order_id=$1 ORDER BY s.id ASC`,
      [id]
    )
  ).rows;

  const products = (
    await query(`SELECT id,name,stock,cost_price,sale_price,image_path FROM products ORDER BY name`)
  ).rows;

  const revenue = items.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
  const profit  = items.reduce((a, s) => a + (Number(s.sale_price)-Number(s.cost_price)) * Number(s.quantity), 0);

  res.render("orders-view", { order, items, products, revenue, profit, dayjs });
});

app.post("/orders/:id/items/bulk-update", async (req, res) => {
  const id = Number(req.params.id);
  const {
    item_id = [], product_id = [], quantity = [],
    sale_price = [], cost_price = [], shipping_cost = [],
    item_note = [], delete_flag = []
  } = req.body;

  const n = Math.max(
    [].concat(item_id).length,
    [].concat(product_id).length,
    [].concat(quantity).length
  );

  for (let i = 0; i < n; i++) {
    const sid = Number([].concat(item_id)[i] || 0);
    const pid = Number([].concat(product_id)[i] || 0);
    const del = String([].concat(delete_flag)[i] || "").toLowerCase() === "on";

    if (sid && del) {
      await query(`DELETE FROM sales WHERE id=$1 AND order_id=$2`, [sid, id]);
      continue;
    }

    if (sid && pid) {
      await query(
        `UPDATE sales SET
           product_id=$1, quantity=$2, sale_price=$3, cost_price=$4, shipping_cost=$5, note=$6
         WHERE id=$7 AND order_id=$8`,
        [
          pid,
          Math.max(1, Number([].concat(quantity)[i] || 1)),
          Number([].concat(sale_price)[i] || 0),
          Number([].concat(cost_price)[i] || 0),
          Number([].concat(shipping_cost)[i] || 0),
          String([].concat(item_note)[i] || ""),
          sid, id,
        ]
      );
      continue;
    }

    if (!sid && pid) {
      await query(
        `INSERT INTO sales(order_id,product_id,quantity,sale_price,cost_price,shipping_cost,note,delivery_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,'pending')`,
        [
          id,
          pid,
          Math.max(1, Number([].concat(quantity)[i] || 1)),
          Number([].concat(sale_price)[i] || 0),
          Number([].concat(cost_price)[i] || 0),
          Number([].concat(shipping_cost)[i] || 0),
          String([].concat(item_note)[i] || ""),
        ]
      );
    }
  }

  res.redirect(`/orders/${id}`);
});

app.post("/orders/:id/items/:itemId/delete", async (req, res) => {
  await query(`DELETE FROM sales WHERE id=$1 AND order_id=$2`, [
    Number(req.params.itemId),
    Number(req.params.id),
  ]);
  res.redirect(`/orders/${req.params.id}`);
});

app.post("/orders/:id/status", async (req, res) => {
  const id = Number(req.params.id);
  const { status = "pending", apply_to_items = "off" } = req.body;
  await query(`UPDATE orders SET status=$1 WHERE id=$2`, [status, id]);
  if (apply_to_items === "on") {
    await query(
      `UPDATE sales
       SET delivery_status=$1,
           delivered_at=CASE WHEN $1='delivered' THEN NOW() ELSE NULL END
       WHERE order_id=$2`,
      [status, id]
    );
  }
  res.redirect(`/orders/${id}`);
});

// ---- Returns ----
app.post("/returns/:id/restock", async (req, res) => {
  const id = Number(req.params.id);
  const r = (await query(`SELECT * FROM returns_queue WHERE id=$1`, [id])).rows[0];
  if (r) {
    await query(`UPDATE products SET stock=stock+$1, updated_at=NOW() WHERE id=$2`, [r.quantity, r.product_id]);
    await query(`DELETE FROM returns_queue WHERE id=$1`, [id]);
  }
  res.redirect("/products");
});
app.post("/returns/:id/reorder", async (req, res) => {
  const id = Number(req.params.id);
  const r = (await query(`SELECT * FROM returns_queue WHERE id=$1`, [id])).rows[0];
  if (r) {
    await query(`UPDATE products SET stock=GREATEST(0,stock-$1), updated_at=NOW() WHERE id=$2`, [r.quantity, r.product_id]);
    await query(
      `INSERT INTO sales(product_id,quantity,sale_price,cost_price,shipping_cost,note)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [r.product_id, r.quantity, r.sale_price, r.cost_price, r.shipping_cost||0, (r.note||"")+" (من راجع)"]
    );
    await query(`DELETE FROM returns_queue WHERE id=$1`, [id]);
  }
  res.redirect("/products");
});
app.post("/returns/:id/delete", async (req, res) => {
  await query(`DELETE FROM returns_queue WHERE id=$1`, [Number(req.params.id)]);
  res.redirect("/products");
});

// ---- Reports (HTML) ----
app.get("/reports", async (req, res) => {
  const { range = "daily", year, month, day } = req.query;

  let rows = [], title = "";
  if (range === "monthly") {
    const y = Number(year) || Number(dayjs().tz(TZ_NAME).format("YYYY"));
    const m = Number(month) || Number(dayjs().tz(TZ_NAME).format("MM"));
    const ym = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    title = `تقرير شهري ${ym}`;
    rows = (
      await query(
        `SELECT s.*,p.name AS product_name,p.image_path AS product_image
         FROM sales s JOIN products p ON p.id=s.product_id
         WHERE TO_CHAR(s.sold_at,'YYYY-MM')=$1 ORDER BY s.sold_at DESC`,
        [ym]
      )
    ).rows;
  } else {
    const y = Number(year) || Number(dayjs().tz(TZ_NAME).format("YYYY"));
    const m = Number(month) || Number(dayjs().tz(TZ_NAME).format("MM"));
    const d = Number(day) || Number(dayjs().tz(TZ_NAME).format("DD"));
    const ds = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    title = `تقرير يومي ${ds}`;
    rows = (
      await query(
        `SELECT s.*,p.name AS product_name,p.image_path AS product_image
         FROM sales s JOIN products p ON p.id=s.product_id
         WHERE DATE(s.sold_at)=DATE($1) ORDER BY s.sold_at DESC`,
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
    years: [2024, 2025, 2026, 2027, 2028, 2029, 2030],
    dayjs,
  });
});

// ---- Reports PDF (puppeteer اختياري) ----
app.get("/reports/pdf", async (req, res, next) => {
  try {
    let puppeteer;
    try {
      puppeteer = require("puppeteer");
    } catch {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(
        `<p style="font-family:Arial">ميزة PDF تتطلب تثبيت <b>puppeteer</b>.<br>نفّذ: <code>npm i puppeteer</code></p>`
      );
    }

    // جلب البيانات مثل /reports
    const { range = "daily", year, month, day } = req.query;
    let rows = [], title = "";
    if (range === "monthly") {
      const y = Number(year) || Number(dayjs().tz(TZ_NAME).format("YYYY"));
      const m = Number(month) || Number(dayjs().tz(TZ_NAME).format("MM"));
      const ym = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
      title = `تقرير شهري ${ym}`;
      rows = (
        await query(
          `SELECT s.*,p.name AS product_name,p.image_path AS product_image
           FROM sales s JOIN products p ON p.id=s.product_id
           WHERE TO_CHAR(s.sold_at,'YYYY-MM')=$1 ORDER BY s.sold_at DESC`,
          [ym]
        )
      ).rows;
    } else {
      const y = Number(year) || Number(dayjs().tz(TZ_NAME).format("YYYY"));
      const m = Number(month) || Number(dayjs().tz(TZ_NAME).format("MM"));
      const d = Number(day) || Number(dayjs().tz(TZ_NAME).format("DD"));
      const ds = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      title = `تقرير يومي ${ds}`;
      rows = (
        await query(
          `SELECT s.*,p.name AS product_name,p.image_path AS product_image
           FROM sales s JOIN products p ON p.id=s.product_id
           WHERE DATE(s.sold_at)=DATE($1) ORDER BY s.sold_at DESC`,
          [ds]
        )
      ).rows;
    }

    const totalRevenue = rows.reduce((a, s) => a + Number(s.sale_price) * Number(s.quantity), 0);
    const totalProfit = rows.reduce(
      (a, s) => a + (Number(s.sale_price) * Number(s.quantity) - Number(s.cost_price) * Number(s.quantity)),
      0
    );

    const html = await new Promise((resolve, reject) => {
      app.render("report-pdf", { title, rows, totalRevenue, totalProfit, dayjs }, (err, str) => {
        if (err) return reject(err);
        resolve(str);
      });
    });

    const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
    });
    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="report.pdf"');
    res.send(pdf);
  } catch (e) {
    next(e);
  }
});

// ============== Start ==============
app.listen(PORT, HOST, () => {
  console.log(`✅ Abrar Store running on http://${HOST}:${PORT}`);
});
