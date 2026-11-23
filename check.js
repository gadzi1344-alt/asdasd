/**
 * Диагностика сервера. Запуск:  node check.js
 * Читает BOT_TOKEN и BOT_API_URL из .env, проверяет методы Bot API
 * и печатает результат. Токен в выводе скрыт — результат можно пересылать.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
} catch (e) {}

const TOKEN = process.env.BOT_TOKEN || '';
const BASE = (process.env.BOT_API_URL || '').replace(/\/+$/, '');
if (!TOKEN || !BASE) {
  console.log('Заполни в файле .env две строки:\nBOT_TOKEN=...\nBOT_API_URL=https://адрес-твоего-bot-api-server');
  process.exit(1);
}

const hide = s => String(s).split(TOKEN).join('<TOKEN>');

function call(method) {
  return new Promise(resolve => {
    const u = new URL(`${BASE}/bot${TOKEN}/${method}`);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { timeout: 15000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 1500) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.on('error', e => resolve({ status: 0, body: e.message }));
  });
}

(async () => {
  console.log('=== PearWallet check ===');
  console.log('BOT_API_URL:', BASE);
  for (const m of ['getMe', 'getMyStarBalance', 'getStarTransactions', 'getAvailableGifts', 'getWebhookInfo']) {
    const r = await call(m);
    console.log(`\n--- ${m} -> HTTP ${r.status}\n${hide(r.body)}`);
  }
  console.log('\n=== конец: скопируй всё выше и отправь в чат ===');
})();
