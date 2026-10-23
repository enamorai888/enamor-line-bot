// api/oms-call.js
//
// enamor-oms 的中轉站。
//
// 問題：enamor-oms 是另一個 Vercel 專案（不同網域），它的端點靠 x-proxy-token
// 驗證。前端要直接打它，就得把那串 token 寫在網頁裡——寫在前端的東西永遠是公開的。
// 而 admin-login 發的 cookie 只在 enamor-line-bot.vercel.app 上，跨網域不會送過去。
//
// 做法：前端改打這支同網域的端點（cookie 會送到），這裡驗證 cookie 之後，
// 由伺服器端補上 x-proxy-token 再轉發給 enamor-oms。token 存在 Vercel 環境變數
// OMS_PROXY_TOKEN，前端完全拿不到。
//
// 用法（前端）：
//   POST /api/oms-call?target=oms-proxy          body: { endpoint, body }
//   POST /api/oms-call?target=po-meta            body: { action, ... }
//   POST /api/oms-call?target=receive-log        body: { ... }
//   GET  /api/oms-call?target=receive-log&action=get&purchase_no=XXX
//   POST /api/oms-call?target=send-purchase-email  body: { orders }
//
// 回應：原樣回傳 enamor-oms 的狀態碼與內容，方便排錯。

const crypto = require('crypto');

const UPSTREAM_BASE = 'https://enamor-oms.vercel.app/api/';

// 只允許這幾支，避免變成任何人都能借道的開放代理
const ALLOWED_TARGETS = new Set([
  'oms-proxy',
  'po-meta',
  'receive-log',
  'send-purchase-email',
]);

const ALLOWED_ORIGINS = [
  'https://enamorshop.com',
  'https://www.enamorshop.com',
  'https://enamor-line-bot.vercel.app',
];

const COOKIE_NAME = 'enamor_admin';
const UPSTREAM_TIMEOUT_MS = 25000;

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sign(expiry, secret) {
  return crypto.createHmac('sha256', secret).update(String(expiry)).digest('hex');
}

// 與 admin-login.js 完全相同的驗證邏輯
function readSession(req, secret) {
  const raw = req.headers.cookie || '';
  const match = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE_NAME + '=([^;]+)'));
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

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  const originAllowed = ALLOWED_ORIGINS.includes(origin);

  if (originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (origin && !originAllowed) {
    return res.status(403).json({ error: 'origin_not_allowed' });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.ADMIN_SESSION_SECRET;
  const omsToken = process.env.OMS_PROXY_TOKEN;

  // 環境變數沒設就直接擋下，不要安靜放行
  if (!secret) {
    return res.status(500).json({
      error: 'server_not_configured',
      hint: '請在 Vercel 設定 ADMIN_SESSION_SECRET',
    });
  }
  if (!omsToken) {
    return res.status(500).json({
      error: 'server_not_configured',
      hint: '請在 Vercel 設定 OMS_PROXY_TOKEN',
    });
  }

  // ── 必須先登入 ──
  if (!readSession(req, secret)) {
    return res.status(401).json({ error: 'not_authenticated', hint: '請重新登入後再試' });
  }

  // ── 檢查 target ──
  const url = new URL(req.url, 'http://localhost');
  const target = url.searchParams.get('target') || '';
  if (!ALLOWED_TARGETS.has(target)) {
    return res.status(400).json({
      error: 'bad_target',
      allowed: Array.from(ALLOWED_TARGETS),
    });
  }

  // target 以外的 query 參數原樣帶到上游（receive-log 的 GET 會用到）
  url.searchParams.delete('target');
  const qs = url.searchParams.toString();
  const upstreamUrl = UPSTREAM_BASE + target + (qs ? '?' + qs : '');

  const init = {
    method: req.method,
    headers: { 'x-proxy-token': omsToken },
  };

  if (req.method === 'POST') {
    const body = req.body;
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body == null ? {} : body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  init.signal = controller.signal;

  try {
    const upstream = await fetch(upstreamUrl, init);
    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    return res.send(text);
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'upstream_timeout', target });
    }
    console.error('oms-call error:', target, e.message);
    return res.status(502).json({ error: 'upstream_unreachable', target, detail: e.message });
  } finally {
    clearTimeout(timer);
  }
};
