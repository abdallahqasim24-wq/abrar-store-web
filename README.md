
# Abrar Store — Pink 24/7
- Profit = (sale_price - cost_price - shipping_cost - coupon_value - gift_value) × quantity
- Pink theme, Arabic RTL, SQLite DB (store.db)

## Run locally
```bash
npm install
npm run start
# http://localhost:3000
```

## PM2 (keep alive on Linux/VPS)
```bash
npm i -g pm2
npm run pm2
pm2 startup
pm2 save
```

## Docker
```bash
docker build -t abrar-store .
docker run -d -p 3000:3000 -v ${PWD}/data:/app -e PORT=3000 --name abrar abrar-store
```

## Railway
- Create new project -> Deploy from repo/zip
- Set Start Command: `node server.js`
- Expose port 3000. Enable Persistence/Volume and mount `/app` to keep `store.db`.

