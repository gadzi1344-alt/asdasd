/**
 * PearWallet v2 — масштабируемый демо-кошелёк
 * Готов к деплою на Render (Web Service, free plan)
 * Порт берётся из process.env.PORT
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

// ---------- .env (без зависимостей) ----------
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    });
  }
} catch (e) { console.error('.env:', e.message); }

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TG_API = (process.env.BOT_API_URL || 'https://api.telegram.org').replace(/\/+$/, '');
const DEMO = process.env.DEMO === '1'; // демо: фейковые бонусы + faucet, вход без Telegram
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ||
  crypto.createHash('sha256').update('wh:' + BOT_TOKEN).digest('hex').slice(0, 32);
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const PUBLIC = path.join(__dirname, 'public');

const RATE = 100;
const FEE = 0.01;
const DOMAIN_PRICE = 10000; // ★ за новый домен

// ---------- DB ----------
function loadDB() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
      return {
        users: raw.users || {},
        lots: raw.lots || [],
        deals: raw.deals || [],
        domains: raw.domains || {},
        domainListings: raw.domainListings || [], // {id, domain, seller, price, ts}
        payments: raw.payments || {},   // chargeId -> {user, amount, ts, refunded}
        usernames: raw.usernames || {}, // @username(lower) -> address
        stats: raw.stats || { sends: 0, swaps: 0, domainsBought: 0 }
      };
    }
  } catch (e) {
    console.error('Load DB:', e.message);
  }
  return { users: {}, lots: [], deals: [], domains: {}, domainListings: [], payments: {}, usernames: {}, stats: { sends: 0, swaps: 0, domainsBought: 0 } };
}

function saveDB() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Save DB:', e.message);
  }
}

let db = loadDB();
setInterval(saveDB, 7000);
process.on('SIGINT', () => { saveDB(); process.exit(0); });
process.on('SIGTERM', () => { saveDB(); process.exit(0); });

// Seed demo lots once
if (!db.lots || db.lots.length === 0) {
  db.lots = [
    { id: 'l1', t: 'u', n: '@pear_official', s: '@admin', p: 150, ts: Date.now() - 864e5 },
    { id: 'l2', t: 'u', n: '@wallet_pro', s: '@merchant', p: 95, ts: Date.now() - 360e5 },
    { id: 'l3', t: 'u', n: '@news_gram', s: '@seller', p: 220, ts: Date.now() - 720e5 },
    { id: 'l4', t: 'n', n: '+888 1000 2000', s: '@numbers', p: 480, ts: Date.now() - 100e5 },
    { id: 'l5', t: 'n', n: '+888 7777 8888', s: '@premium', p: 920, ts: Date.now() - 50e5 },
    { id: 'l6', t: 'g', n: 'Золотая Груша', s: '@gifts', p: 65, ts: Date.now() - 20e5 },
    { id: 'l7', t: 'g', n: 'Редкий стикер-пак', s: '@gifts', p: 35, ts: Date.now() - 10e5 },
    { id: 'l8', t: 'g', n: 'VIP Badge', s: '@shop', p: 120, ts: Date.now() - 5e5 }
  ];
  saveDB();
}

function uuid() { return crypto.randomBytes(5).toString('hex'); }

function ensureUser(address) {
  if (!db.users[address]) {
    db.users[address] = {
      address,
      gram: DEMO ? 80 : 0,
      stars: DEMO ? 250 : 0,
      stake: 0,
      hist: [],
      own: { u: [], n: [], g: [], d: [] },
      created: Date.now()
    };
    if (DEMO) db.users[address].hist.unshift({
      id: uuid(), ty: 'in', c: 's', a: 250, to: 'Приветственный бонус PearWallet', ts: Date.now()
    });
    saveDB();
  }
  const u = db.users[address];
  if (!u.own) u.own = { u: [], n: [], g: [], d: [] };
  if (!u.own.d) u.own.d = [];
  return u;
}

function shortAddr(a) {
  if (!a) return '';
  return a.length > 16 ? a.slice(0, 5) + '…' + a.slice(-4) : a;
}

function okAddress(v) {
  return /^(UQ|EQ)[A-Za-z0-9_-]{46}$/.test(v) ||
         /^[a-z0-9-]{3,}\.pear$/i.test(v) ||
         /^@[A-Za-z0-9_]{5,32}$/.test(v) ||
         /^[a-z0-9_]{3,32}$/i.test(v);
}

function okDomain(name) {
  return /^[a-z0-9-]{3,20}$/i.test(name) && !name.startsWith('-') && !name.endsWith('-');
}

// Проверка Telegram WebApp initData (HMAC-SHA256 по токену бота)
function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const check = [...params.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
    const a = Buffer.from(calc), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
    if (age > 86400) return null; // старше суток — не принимаем
    return JSON.parse(params.get('user') || 'null');
  } catch (e) { return null; }
}

async function tg(method, params = {}) {
  const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || ('Telegram HTTP ' + r.status));
  return j.result;
}

async function handleUpdate(u) {
  if (u.pre_checkout_query) {
    const q = u.pre_checkout_query;
    const ok = q.currency === 'XTR' && String(q.invoice_payload || '').startsWith('dep:tg' + q.from.id + ':');
    return tg('answerPreCheckoutQuery', ok
      ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: 'Неверный платёж' });
  }
  const m = u.message;
  if (!m) return;
  if (m.successful_payment) {
    const p = m.successful_payment, addr = 'tg' + m.from.id;
    if (p.currency !== 'XTR' || !String(p.invoice_payload).startsWith('dep:' + addr + ':')) return;
    const cid = p.telegram_payment_charge_id;
    if (db.payments[cid]) return; // уже зачислено
    const usr = ensureUser(addr);
    usr.stars += p.total_amount;
    db.payments[cid] = { user: addr, amount: p.total_amount, ts: Date.now(), refunded: false };
    usr.hist.unshift({ id: uuid(), ty: 'in', c: 's', a: p.total_amount, to: 'Пополнение Telegram Stars', ts: Date.now() });
    saveDB();
    return;
  }
  if (m.text && /^\/start/.test(m.text) && PUBLIC_URL) {
    return tg('sendMessage', {
      chat_id: m.chat.id, text: 'Открой PearWallet 👇',
      reply_markup: { inline_keyboard: [[{ text: 'Открыть кошелёк', web_app: { url: PUBLIC_URL } }]] }
    });
  }
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
  };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- API ----------
async function handleApi(req, res, pathname, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Init-Data'
    });
    return res.end();
  }

  try {
    const PUBLIC_PATHS = ['/api/health', '/api/stats', '/api/tg-auth', '/api/market', '/api/domains', '/api/domain/check', '/api/tg-webhook'];
    const tgUser = verifyInitData(req.headers['x-init-data']);
    const me = tgUser && tgUser.id ? 'tg' + tgUser.id : null;
    if (me && tgUser.username) db.usernames['@' + tgUser.username.toLowerCase()] = me;
    if (!me && !DEMO && !PUBLIC_PATHS.includes(pathname)) {
      return json(res, 401, { error: 'Откройте кошелёк через Telegram' });
    }
    // тело запроса; при входе через Telegram адрес берётся ТОЛЬКО из подписи
    const rb = async () => { const b = await readBody(req); if (me) { b.address = me; b.from = me; } return b; };

    // Webhook Telegram
    if (pathname === '/api/tg-webhook' && req.method === 'POST') {
      if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return json(res, 403, { error: 'forbidden' });
      const upd = await readBody(req);
      handleUpdate(upd).catch(e => console.error('[webhook]', e.message));
      return json(res, 200, { ok: true });
    }

    // Health + stats
    if (pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        version: '2.0.0',
        botConfigured: !!BOT_TOKEN,
        demo: DEMO,
        users: Object.keys(db.users).length,
        domains: Object.keys(db.domains).length,
        listings: (db.domainListings || []).length,
        stats: db.stats,
        time: Date.now()
      });
    }

    // Telegram auth: initData -> стабильный адрес пользователя
    if (pathname === '/api/tg-auth' && req.method === 'POST') {
      const body = await rb();
      const user = verifyInitData(body.initData);
      if (!user || !user.id) return json(res, 401, { error: 'Неверные данные Telegram' });
      if (user.username) db.usernames['@' + user.username.toLowerCase()] = 'tg' + user.id;
      return json(res, 200, { ok: true, address: 'tg' + user.id, username: user.username || null, name: user.first_name || '' });
    }

    // Пополнение: инвойс в Telegram Stars (XTR)
    if (pathname === '/api/deposit' && req.method === 'POST') {
      const body = await rb();
      const amt = Math.floor(Number(body.amount));
      if (!/^tg\d+$/.test(body.address || '')) return json(res, 400, { error: 'Пополнение доступно только из Telegram' });
      if (!(amt >= 1 && amt <= 100000)) return json(res, 400, { error: 'Сумма: от 1 до 100000 ★' });
      const link = await tg('createInvoiceLink', {
        title: 'Пополнение PearWallet', description: amt + ' ★ на счёт PearWallet',
        payload: 'dep:' + body.address + ':' + uuid(), provider_token: '', currency: 'XTR',
        prices: [{ label: 'Stars', amount: amt }]
      });
      return json(res, 200, { ok: true, link });
    }

    // Платежи, доступные для возврата
    if (pathname === '/api/payments' && req.method === 'GET') {
      const list = Object.entries(db.payments)
        .filter(([, p]) => p.user === me && !p.refunded)
        .map(([id, p]) => ({ id, amount: p.amount, ts: p.ts }));
      return json(res, 200, list);
    }

    // Вывод = возврат Stars по конкретному платежу
    if (pathname === '/api/withdraw' && req.method === 'POST') {
      const body = await rb();
      const pay = db.payments[body.chargeId];
      if (!pay || pay.user !== body.address) return json(res, 404, { error: 'Платёж не найден' });
      if (pay.refunded) return json(res, 400, { error: 'Уже возвращён' });
      const u = ensureUser(body.address);
      if (u.stars < pay.amount) return json(res, 400, { error: 'Недостаточно ★ для возврата ' + pay.amount });
      pay.refunded = true; u.stars -= pay.amount; // сначала списываем, чтобы не было двойного возврата
      try {
        await tg('refundStarPayment', { user_id: Number(body.address.slice(2)), telegram_payment_charge_id: body.chargeId });
      } catch (e) {
        pay.refunded = false; u.stars += pay.amount;
        return json(res, 502, { error: 'Telegram: ' + e.message });
      }
      u.hist.unshift({ id: uuid(), ty: 'out', c: 's', a: pay.amount, to: 'Возврат Stars в Telegram', fee: 0, ts: Date.now() });
      saveDB();
      return json(res, 200, { ok: true, stars: u.stars });
    }

    // Global stats
    if (pathname === '/api/stats' && req.method === 'GET') {
      return json(res, 200, {
        users: Object.keys(db.users).length,
        domains: Object.keys(db.domains).length,
        domainListings: (db.domainListings || []).length,
        marketLots: (db.lots || []).length,
        ...db.stats
      });
    }

    // User
    if (pathname.startsWith('/api/user/') && req.method === 'GET') {
      const address = me || decodeURIComponent(pathname.slice(10)).trim();
      if (!address) return json(res, 400, { error: 'address required' });
      const u = ensureUser(address);
      return json(res, 200, {
        address: u.address,
        gram: +u.gram.toFixed(6),
        stars: u.stars,
        stake: u.stake,
        own: u.own,
        domains: u.own.d || [],
        created: u.created
      });
    }

    // History
    if (pathname.startsWith('/api/history/') && req.method === 'GET') {
      const address = me || decodeURIComponent(pathname.slice(13)).trim();
      const u = ensureUser(address);
      return json(res, 200, (u.hist || []).slice(0, 150));
    }

    // Send
    if (pathname === '/api/send' && req.method === 'POST') {
      const body = await rb();
      let { from, to, amount, currency, comment } = body;
      if (!from || !to || amount == null) return json(res, 400, { error: 'from, to, amount required' });
      if (!okAddress(to)) return json(res, 400, { error: 'Некорректный получатель' });
      const key = String(to).toLowerCase();
      if (db.domains[key]) to = db.domains[key];
      else if (db.usernames[key]) to = db.usernames[key];
      if (to === from) return json(res, 400, { error: 'Нельзя отправить самому себе' });
      if (!DEMO && !db.users[to]) return json(res, 404, { error: 'Получатель не найден. Он должен хотя бы раз открыть PearWallet' });

      const amt = parseFloat(amount);
      if (!(amt > 0)) return json(res, 400, { error: 'Сумма должна быть > 0' });

      const cur = currency === 's' ? 's' : 'g';
      const fee = cur === 'g' ? FEE : 0;
      const sender = ensureUser(from);
      const recipient = ensureUser(to);

      if (cur === 's') {
        if (amt % 1 !== 0) return json(res, 400, { error: 'Звёзды — только целые' });
        if (sender.stars < amt) return json(res, 400, { error: 'Недостаточно звёзд' });
        sender.stars -= amt;
        recipient.stars += amt;
      } else {
        if (sender.gram < amt + fee) return json(res, 400, { error: 'Недостаточно GRAM' });
        sender.gram = +(sender.gram - amt - fee).toFixed(6);
        recipient.gram = +(recipient.gram + amt).toFixed(6);
      }

      const id = uuid();
      const ts = Date.now();
      sender.hist.unshift({ id, ty: 'out', c: cur, a: amt, to, cm: comment || '', fee, ts });
      recipient.hist.unshift({ id: id + 'r', ty: 'in', c: cur, a: amt, to: from, cm: comment || '', ts });
      db.stats.sends = (db.stats.sends || 0) + 1;
      saveDB();
      return json(res, 200, { ok: true, id, from: { gram: sender.gram, stars: sender.stars }, to: shortAddr(to) });
    }

    // Swap
    if (pathname === '/api/swap' && req.method === 'POST') {
      const body = await rb();
      const { address, fromCurrency, amount } = body;
      if (!address || !fromCurrency || amount == null) return json(res, 400, { error: 'Не хватает полей' });
      const amt = parseFloat(amount);
      if (!(amt > 0)) return json(res, 400, { error: 'Сумма > 0' });

      const u = ensureUser(address);
      const from = fromCurrency === 's' ? 's' : 'g';

      if (from === 's') {
        if (amt % 1 !== 0) return json(res, 400, { error: 'Звёзды — целые' });
        if (u.stars < amt) return json(res, 400, { error: 'Недостаточно звёзд' });
        const got = amt / RATE;
        u.stars -= amt;
        u.gram = +(u.gram + got).toFixed(6);
        u.hist.unshift({ id: uuid(), ty: 'swap', c: 'g', a: got, fc: 's', fa: amt, ts: Date.now() });
      } else {
        if (u.gram < amt) return json(res, 400, { error: 'Недостаточно GRAM' });
        const got = Math.floor(amt * RATE);
        u.gram = +(u.gram - amt).toFixed(6);
        u.stars += got;
        u.hist.unshift({ id: uuid(), ty: 'swap', c: 's', a: got, fc: 'g', fa: amt, ts: Date.now() });
      }
      db.stats.swaps = (db.stats.swaps || 0) + 1;
      saveDB();
      return json(res, 200, { ok: true, gram: u.gram, stars: u.stars });
    }

    // Stake / Unstake
    if (pathname === '/api/stake' && req.method === 'POST') {
      const body = await rb();
      const { address, amount } = body;
      const amt = parseFloat(amount);
      if (!address || !(amt > 0)) return json(res, 400, { error: 'Некорректный запрос' });
      const u = ensureUser(address);
      if (u.gram < amt) return json(res, 400, { error: 'Недостаточно GRAM' });
      u.gram = +(u.gram - amt).toFixed(6);
      u.stake = +(u.stake + amt).toFixed(6);
      u.hist.unshift({ id: uuid(), ty: 'stk', c: 'g', a: amt, ts: Date.now() });
      saveDB();
      return json(res, 200, { ok: true, gram: u.gram, stake: u.stake });
    }

    if (pathname === '/api/unstake' && req.method === 'POST') {
      const body = await rb();
      const { address } = body;
      if (!address) return json(res, 400, { error: 'address required' });
      const u = ensureUser(address);
      if (u.stake <= 0) return json(res, 400, { error: 'Нечего выводить' });
      const amt = u.stake;
      u.gram = +(u.gram + amt).toFixed(6);
      u.stake = 0;
      u.hist.unshift({ id: uuid(), ty: 'unstk', c: 'g', a: amt, ts: Date.now() });
      saveDB();
      return json(res, 200, { ok: true, gram: u.gram, stake: 0 });
    }

    // Faucet (только демо)
    if (pathname === '/api/faucet' && req.method === 'POST') {
      if (!DEMO) return json(res, 403, { error: 'Недоступно' });
      const body = await rb();
      const { address } = body;
      if (!address) return json(res, 400, { error: 'address required' });
      const u = ensureUser(address);
      u.gram = +(u.gram + 1000).toFixed(6);
      u.hist.unshift({ id: uuid(), ty: 'in', c: 'g', a: 1000, to: 'Faucet PearWallet', ts: Date.now() });
      saveDB();
      return json(res, 200, { ok: true, gram: u.gram });
    }

    // ===== DOMAINS =====
    if (pathname === '/api/domain/check' && req.method === 'GET') {
      const name = (url.searchParams.get('name') || '').toLowerCase().replace(/\.pear$/i, '').trim();
      if (!okDomain(name)) return json(res, 400, { error: 'Имя: 3–20 символов (a-z, 0-9, -)', available: false });
      const full = name + '.pear';
      const taken = !!db.domains[full];
      const listing = (db.domainListings || []).find(l => l.domain === full);
      return json(res, 200, {
        name: full,
        available: !taken,
        price: DOMAIN_PRICE,
        forSale: !!listing,
        salePrice: listing ? listing.price : null
      });
    }

    if (pathname === '/api/domain/buy' && req.method === 'POST') {
      const body = await rb();
      const { address, name } = body;
      if (!address || !name) return json(res, 400, { error: 'address и name обязательны' });
      const clean = String(name).toLowerCase().replace(/\.pear$/i, '').trim();
      if (!okDomain(clean)) return json(res, 400, { error: 'Домен: 3–20 символов, a-z 0-9 дефис' });
      const full = clean + '.pear';
      if (db.domains[full]) return json(res, 400, { error: 'Домен уже занят' });

      const u = ensureUser(address);
      if (u.stars < DOMAIN_PRICE) return json(res, 400, { error: `Нужно ${DOMAIN_PRICE} ★ (у вас ${u.stars})` });

      u.stars -= DOMAIN_PRICE;
      u.own.d.push(full);
      db.domains[full] = address;
      u.hist.unshift({ id: uuid(), ty: 'domain', c: 's', a: DOMAIN_PRICE, to: full, ts: Date.now() });
      db.stats.domainsBought = (db.stats.domainsBought || 0) + 1;
      saveDB();
      return json(res, 200, { ok: true, domain: full, stars: u.stars, own: u.own });
    }

    // List domain for sale
    if (pathname === '/api/domain/list' && req.method === 'POST') {
      const body = await rb();
      const { address, domain, price } = body;
      if (!address || !domain || !(price > 0)) return json(res, 400, { error: 'Нужны address, domain, price' });
      const full = String(domain).toLowerCase();
      if (!full.endsWith('.pear')) return json(res, 400, { error: 'Только .pear домены' });
      if (db.domains[full] !== address) return json(res, 400, { error: 'Это не ваш домен' });
      if ((db.domainListings || []).some(l => l.domain === full)) return json(res, 400, { error: 'Уже на продаже' });

      const id = uuid();
      db.domainListings = db.domainListings || [];
      db.domainListings.unshift({ id, domain: full, seller: address, price: +price, ts: Date.now() });
      saveDB();
      return json(res, 200, { ok: true, id });
    }

    // Buy listed domain
    if (pathname === '/api/domain/buy-listing' && req.method === 'POST') {
      const body = await rb();
      const { address, listingId } = body;
      if (!address || !listingId) return json(res, 400, { error: 'Нужны address и listingId' });
      const listing = (db.domainListings || []).find(l => l.id === listingId);
      if (!listing) return json(res, 404, { error: 'Лот не найден' });
      if (listing.seller === address) return json(res, 400, { error: 'Нельзя купить свой лот' });

      const buyer = ensureUser(address);
      const seller = ensureUser(listing.seller);
      if (buyer.gram < listing.price) return json(res, 400, { error: 'Недостаточно GRAM' });

      buyer.gram = +(buyer.gram - listing.price).toFixed(6);
      seller.gram = +(seller.gram + listing.price).toFixed(6);

      // transfer ownership
      db.domains[listing.domain] = address;
      seller.own.d = (seller.own.d || []).filter(d => d !== listing.domain);
      buyer.own.d = buyer.own.d || [];
      buyer.own.d.push(listing.domain);

      db.domainListings = db.domainListings.filter(l => l.id !== listingId);

      const ts = Date.now();
      buyer.hist.unshift({ id: uuid(), ty: 'domain', c: 'g', a: listing.price, to: listing.domain, ts });
      seller.hist.unshift({ id: uuid(), ty: 'in', c: 'g', a: listing.price, to: 'Продажа ' + listing.domain, ts });
      saveDB();
      return json(res, 200, { ok: true, domain: listing.domain, gram: buyer.gram, own: buyer.own });
    }

    // Cancel listing
    if (pathname === '/api/domain/unlist' && req.method === 'POST') {
      const body = await rb();
      const { address, listingId } = body;
      const listing = (db.domainListings || []).find(l => l.id === listingId);
      if (!listing || listing.seller !== address) return json(res, 400, { error: 'Нельзя снять' });
      db.domainListings = db.domainListings.filter(l => l.id !== listingId);
      saveDB();
      return json(res, 200, { ok: true });
    }

    // All domains + listings
    if (pathname === '/api/domains' && req.method === 'GET') {
      const list = Object.entries(db.domains).map(([d, owner]) => ({
        domain: d,
        owner: shortAddr(owner),
        forSale: (db.domainListings || []).some(l => l.domain === d)
      }));
      return json(res, 200, { domains: list, listings: db.domainListings || [] });
    }

    // Market lots
    if (pathname === '/api/market' && req.method === 'GET') {
      const type = url.searchParams.get('t') || 'u';
      let items = (db.lots || []).filter(l => l.t === type);
      if (type === 'd') {
        items = (db.domainListings || []).map(l => ({
          id: l.id, t: 'd', n: l.domain, s: shortAddr(l.seller), p: l.price, listing: true
        }));
      }
      return json(res, 200, items);
    }

    // Buy market item
    if (pathname === '/api/buy' && req.method === 'POST') {
      const body = await rb();
      const { address, lotId, name, price, t } = body;
      if (!address) return json(res, 400, { error: 'address required' });
      const u = ensureUser(address);

      // Domain listing buy
      if (t === 'd' && lotId) {
        // redirect logic already in buy-listing, keep simple
        return json(res, 400, { error: 'Используйте /api/domain/buy-listing' });
      }

      const p = parseFloat(price);
      if (!(p > 0) || !name) return json(res, 400, { error: 'Некорректные данные' });
      if (u.gram < p) return json(res, 400, { error: 'Недостаточно GRAM' });

      u.gram = +(u.gram - p).toFixed(6);
      const type = t || 'g';
      if (!u.own[type]) u.own[type] = [];
      u.own[type].push(name);
      u.hist.unshift({ id: uuid(), ty: 'mk', c: 'g', a: p, to: name, ts: Date.now() });

      // remove from lots if present
      db.lots = (db.lots || []).filter(l => l.id !== lotId);
      saveDB();
      return json(res, 200, { ok: true, gram: u.gram, own: u.own });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[API]', e);
    return json(res, 500, { error: 'Ошибка сервера' });
  }
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    return handleApi(req, res, pathname, url);
  }

  let filePath = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC, 'index.html');
  }
  serveStatic(res, filePath);
});

server.listen(PORT, () => {
  if (BOT_TOKEN && PUBLIC_URL) {
    tg('setWebhook', { url: PUBLIC_URL + '/api/tg-webhook', secret_token: WEBHOOK_SECRET, allowed_updates: ['message', 'pre_checkout_query'] })
      .then(() => console.log('   Webhook set:', PUBLIC_URL + '/api/tg-webhook'))
      .catch(e => console.error('   setWebhook:', e.message));
    tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Кошелёк', web_app: { url: PUBLIC_URL } } }).catch(() => {});
  } else if (BOT_TOKEN) {
    console.log('   PUBLIC_URL не задан — вебхук не установлен (платежи не придут)');
  }
  console.log(`\n🚀 PearWallet v2.0 running on port ${PORT}`);
  console.log(`   Users: ${Object.keys(db.users).length} | Domains: ${Object.keys(db.domains).length}`);
  console.log(`   Open: http://localhost:${PORT}\n`);
});
