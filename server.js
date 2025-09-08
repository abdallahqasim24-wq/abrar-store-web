
import express from 'express';
import path from 'path';
import multer from 'multer';
import Database from 'better-sqlite3';
import PDFDocument from 'pdfkit';
import puppeteer from 'puppeteer';
import dayjs from 'dayjs';
import { fileURLToPath } from 'url';
import expressLayouts from 'express-ejs-layouts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// ===== DB =====
const db = new Database(path.join(__dirname, 'store.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  cost_price REAL NOT NULL,        -- السعر الأصلي/التكلفة
  sale_price REAL NOT NULL,        -- السعر الافتراضي للبيع
  stock INTEGER NOT NULL DEFAULT 0,
  image_path TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  sale_price REAL NOT NULL,        -- السعر الفعلي الذي بيع به
  cost_price REAL NOT NULL,        -- السعر الأصلي
  coupon_value REAL DEFAULT 0,     -- خصم كوبون
  gift_value REAL DEFAULT 0,       -- قيمة هدية
  points_value REAL DEFAULT 0,    -- قيمة النقاط
  shipping_cost REAL DEFAULT 0,    -- الشحن
  note TEXT,
  sold_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(product_id) REFERENCES products(id)
);
`);

// MIGRATION: add points_value if missing
try {
  const cols = db.prepare("PRAGMA table_info(sales)").all();
  if(!cols.find(c=> c.name==='points_value')){
    db.exec("ALTER TABLE sales ADD COLUMN points_value REAL DEFAULT 0");
  }
} catch(e) { /* ignore */ }

// ===== App =====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use((req,res,next)=>{ res.locals.currentPath = req.path; next(); });

// Uploads
const storage = multer.diskStorage({
  destination: (req,file,cb)=> cb(null, path.join(__dirname,'public','uploads')),
  filename: (req,file,cb)=>{
    const ext = path.extname(file.originalname||'').toLowerCase();
    cb(null, Date.now()+'-'+Math.round(Math.random()*1e9)+ext);
  }
});
const upload = multer({ storage });

// ===== Helpers =====
// الربح = (سعر البيع - السعر الأصلي - الشحن - الكوبون - الهدية) × الكمية
const profitOf = (s)=> (((s.shipping_cost||0) + s.cost_price) - ((s.coupon_value||0) + (s.gift_value||0) + (s.points_value||0)) - s.sale_price) * s.quantity;

function stats(){
  const t = db.prepare(`
    SELECT COUNT(*) products_count,
           IFNULL(SUM(stock),0) total_units,
           IFNULL(SUM(stock*cost_price),0) total_cost_value,
           IFNULL(SUM(stock*sale_price),0) total_sale_value
    FROM products
  `).get();
  const today = dayjs().format('YYYY-MM-DD');
  const month = dayjs().format('YYYY-MM');
  const todayRows = db.prepare(`SELECT * FROM sales WHERE date(sold_at)=date(?)`).all(today);
  const monthRows = db.prepare(`SELECT * FROM sales WHERE strftime('%Y-%m', sold_at)=?`).all(month);
  const rev = (rows)=> rows.reduce((a,s)=> a + s.sale_price*s.quantity, 0);
  const prof = (rows)=> rows.reduce((a,s)=> a + profitOf(s), 0);
  return { ...t, today_revenue: rev(todayRows), today_profit: prof(todayRows), month_revenue: rev(monthRows), month_profit: prof(monthRows) };
}

// ===== Routes =====
app.get('/', (req,res)=>{
  const s = stats();
  const byCat = db.prepare(`
    SELECT p.category as label, IFNULL(SUM(s.quantity*s.sale_price),0) value
    FROM products p LEFT JOIN sales s ON s.product_id=p.id GROUP BY p.category ORDER BY value DESC`).all();
  const lowStock = db.prepare(`SELECT * FROM products WHERE stock<=? ORDER BY stock ASC LIMIT 8`).all(5);
  const lastSales = db.prepare(`SELECT s.*, p.name product_name FROM sales s JOIN products p ON p.id=s.product_id ORDER BY s.sold_at DESC LIMIT 8`).all();
  res.render('index', { stats: s, byCat, lowStock, lastSales, dayjs });
});

// Products
app.get('/products',(req,res)=>{
  const products = db.prepare(`SELECT * FROM products ORDER BY created_at DESC`).all();
  res.render('products',{ products });
});
app.post('/products', upload.single('image'), (req,res)=>{
  const { name, brand, category, cost_price, sale_price, stock } = req.body;
  const image_path = req.file ? '/public/uploads/'+req.file.filename : null;
  db.prepare(`INSERT INTO products (name,brand,category,cost_price,sale_price,stock,image_path) VALUES (?,?,?,?,?,?,?)`)
    .run(name, brand||'', category||'', Number(cost_price), Number(sale_price), Number(stock||0), image_path);
  res.redirect('/products');
});
// Update
app.post('/products/:id/update', upload.single('image'), (req,res)=>{
  const id = Number(req.params.id);
  const old = db.prepare(`SELECT * FROM products WHERE id=?`).get(id);
  if(!old) return res.redirect('/products');
  const { name, brand, category, cost_price, sale_price, stock } = req.body;
  const image_path = req.file ? '/public/uploads/'+req.file.filename : old.image_path;
  db.prepare(`UPDATE products SET name=?,brand=?,category=?,cost_price=?,sale_price=?,stock=?,image_path=? WHERE id=?`)
    .run(name||old.name, brand??old.brand, category??old.category,
         Number(cost_price??old.cost_price), Number(sale_price??old.sale_price),
         Number(stock??old.stock), image_path, id);
  res.redirect('/products');
});
app.post('/products/:id/stock', (req,res)=>{
  const id = Number(req.params.id), delta = Number(req.body.delta||0);
  db.prepare(`UPDATE products SET stock = MAX(0, stock + ?) WHERE id=?`).run(delta, id);
  res.redirect('/products');
});
app.post('/products/:id/delete', (req,res)=>{
  db.prepare(`DELETE FROM products WHERE id=?`).run(Number(req.params.id));
  res.redirect('/products');
});

// Sales
app.get('/sales',(req,res)=>{
  const sales = db.prepare(`SELECT s.*, p.name product_name FROM sales s JOIN products p ON p.id=s.product_id ORDER BY s.sold_at DESC`).all();
  const products = db.prepare(`SELECT id,name,stock,cost_price,sale_price FROM products ORDER BY name`).all();
  res.render('sales',{ sales, products, dayjs });
});
app.post('/sales', (req,res)=>{
  const { product_id, quantity, sale_price, cost_price, coupon_value, gift_value, points_value, shipping_cost, note } = req.body;
  const prod = db.prepare(`SELECT * FROM products WHERE id=?`).get(Number(product_id));
  if(!prod) return res.redirect('/sales');
  const qty = Math.max(1, Number(quantity||1));
  db.prepare(`UPDATE products SET stock = MAX(0, stock - ?) WHERE id=?`).run(qty, prod.id);
  db.prepare(`INSERT INTO sales (product_id,quantity,sale_price,cost_price,coupon_value,gift_value,points_value,shipping_cost,note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(prod.id, qty, Number(sale_price||prod.sale_price), Number(cost_price||prod.cost_price), Number(coupon_value||0), Number(gift_value||0), Number(points_value||0), Number(shipping_cost||0), note||'');
  res.redirect('/sales');
});
app.post('/sales/:id/delete',(req,res)=>{
  const id = Number(req.params.id);
  const s = db.prepare(`SELECT * FROM sales WHERE id=?`).get(id);
  if(s){
    db.prepare(`UPDATE products SET stock = stock + ? WHERE id=?`).run(s.quantity, s.product_id);
    db.prepare(`DELETE FROM sales WHERE id=?`).run(id);
  }
  res.redirect('/sales');
});

// Reports + PDF
app.get('/reports',(req,res)=>{
  const { range='daily', date } = req.query;
  let rows=[], title='';
  if(range==='monthly'){
    const ym = date || dayjs().format('YYYY-MM');
    title = `تقرير شهري ${ym}`;
    rows = db.prepare(`SELECT * FROM sales WHERE strftime('%Y-%m', sold_at)=? ORDER BY sold_at DESC`).all(ym);
  } else {
    const d = date || dayjs().format('YYYY-MM-DD');
    title = `تقرير يومي ${d}`;
    rows = db.prepare(`SELECT * FROM sales WHERE date(sold_at)=date(?) ORDER BY sold_at DESC`).all(d);
  }
  const totalRevenue = rows.reduce((a,s)=> a + s.sale_price*s.quantity, 0);
  const totalProfit  = rows.reduce((a,s)=> a + profitOf(s), 0);
  res.render('reports', { rows, title, totalRevenue, totalProfit, range, date, dayjs });
});


app.get('/reports/pdf', async (req,res)=>{
  const { range='daily', date } = req.query;
  let rows=[], title='';
  if(range==='monthly'){
    const ym = date || dayjs().format('YYYY-MM');
    title = `تقرير مبيعات شهري ${ym}`;
    rows = db.prepare(`SELECT s.*, p.name product_name FROM sales s JOIN products p ON p.id=s.product_id WHERE strftime('%Y-%m', s.sold_at)=? ORDER BY s.sold_at DESC`).all(ym);
  } else {
    const d = date || dayjs().format('YYYY-MM-DD');
    title = `تقرير مبيعات يومي ${d}`;
    rows = db.prepare(`SELECT s.*, p.name product_name FROM sales s JOIN products p ON p.id=s.product_id WHERE date(s.sold_at)=date(?) ORDER BY s.sold_at DESC`).all(d);
  }
  const totalRevenue = rows.reduce((a,s)=> a + s.sale_price*s.quantity, 0);
  const totalProfit  = rows.reduce((a,s)=> a + (((s.shipping_cost||0) + s.cost_price) - ((s.coupon_value||0) + (s.gift_value||0) + (s.points_value||0)) - s.sale_price) * s.quantity, 0);

  // render HTML via EJS then convert to PDF with Puppeteer
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition','inline; filename="report.pdf"');

  const html = await new Promise((resolve, reject)=>{
    // reuse an EJS view for PDF
    res.render('report-pdf', { rows, title, totalRevenue, totalProfit, dayjs }, (err, str)=>{
      if(err) reject(err); else resolve(str);
    });
  });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil:'networkidle0' });
  const pdf = await page.pdf({ format:'A4', printBackground:true, margin:{top:'20mm', right:'12mm', bottom:'16mm', left:'12mm'} });
  await browser.close();
  res.end(pdf);
});

// Seed
app.get('/dev/seed',(req,res)=>{
  const p = db.prepare(`INSERT INTO products (name,brand,category,cost_price,sale_price,stock) VALUES (?,?,?,?,?,?)`);
  const items=[ ['Lipstick Ruby','BrandX','Makeup',10,20,25], ['Face Cream','CareCo','Skincare',15,35,15], ['Mascara Pro','BrandY','Makeup',8,18,30] ];
  db.transaction(()=>{ for(const it of items) p.run(...it); })();
  res.json({ inserted: items.length });
});

app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});