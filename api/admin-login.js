// api/admin-login.js
// 內部後台頁面的登入端點。
//
// 取代原本寫在前端的 if (password === '28447208')。
// 密碼存在 Vercel 環境變數 ADMIN_PASSWORD，永遠不會出現在前端原始碼。
// 驗證成功後簽發一個 HttpOnly cookie（JavaScript 讀不到，所以也偷不走）。
//
// 用法：
//   POST /api/admin-login   { "password": "..." }   → 設定 cookie
//   GET  /api/admin-login                           → 查詢目前是否已登入
//   DELETE /api/admin-login                         → 登出

const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  'https://enamorshop.com',
  'https://www.enamorshop.com',
  'https://enamor-line-bot.vercel.app',
];

const SESSION_HOURS = 12;
const COOKIE_NAME = 'enamor_admin';

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sign(expiry, secret) {
  return crypto.createHmac('sha256', secret).update(String(expiry)).digest('hex');
}

function readSession(req, secret) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)enamor_admin=([^;]+)/);
  if (!match) return null;

  const value = decodeURIComponent(match[1]);
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;

  const exp = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return null;
  if (Number(exp) < Date.now()) return null;
  if (!timingSafeEqual(sig, sign(exp, secret))) return null;

  return { expiresAt: Number(exp) };
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

// 以 IP 計數，擋暴力猜密碼。KV 不可用時回傳 null（放行）。
async function bumpFailure(ip) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  const key = `adminlogin:fail:${ip}`;
  try {
    const auth = { Authorization: `Bearer ${token}` };
    const r = await fetch(`${url}/incr/${encodeURIComponent(key)}`, { headers: auth });
    if (!r.ok) return null;
    const { result } = await r.json();
    const count = Number(result);
    if (count === 1) {
      await fetch(`${url}/expire/${encodeURIComponent(key)}/900`, { headers: auth });
    }
    return count;
  } catch (e) {
    console.error('admin-login kv error:', e.message);
    return null;
  }
}

async function readFailures(ip) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return 0;

  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(`adminlogin:fail:${ip}`)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return 0;
    const { result } = await r.json();
    return Number(result) || 0;
  } catch (e) {
    return 0;
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  const originAllowed = ALLOWED_ORIGINS.includes(origin);

  if (originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (origin && !originAllowed) return res.status(403).json({ error: 'origin_not_allowed' });

  const secret = process.env.ADMIN_SESSION_SECRET;
  const password = process.env.ADMIN_PASSWORD;

  if (!secret || !password) {
    return res.status(500).json({
      error: 'server_not_configured',
      hint: '請在 Vercel 設定 ADMIN_PASSWORD 與 ADMIN_SESSION_SECRET',
    });
  }

  // ── 查詢登入狀態 ──
  if (req.method === 'GET') {
    const session = readSession(req, secret);
    return res.status(200).json({ authenticated: Boolean(session) });
  }

  // ── 登出 ──
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // ── 登入 ──
  const ip = clientIp(req);
  const failures = await readFailures(ip);
  if (failures >= 10) {
    res.setHeader('Retry-After', '900');
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const supplied = typeof body.password === 'string' ? body.password : '';

  if (!supplied || !timingSafeEqual(supplied, password)) {
    await bumpFailure(ip);
    // 固定延遲，避免用回應時間推測密碼長度
    await new Promise((r) => setTimeout(r, 400));
    return res.status(401).json({ error: 'bad_password' });
  }

  const expiry = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const value = `${expiry}.${sign(expiry, secret)}`;

  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`
  );

  return res.status(200).json({ ok: true, expiresAt: expiry });
};
