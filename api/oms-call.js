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
//
// ── 2026-11-05 修正：逾時與重試 ──
// 症狀：採購建議的「需採購」永遠是 0。
// 原因：apiOrderList/searchDetail 的上游回應時間不穩定（實測 12s ~ 30s+），
//       舊的 25 秒硬上限會把一半的請求切斷回 504，前端把 504 當成「0 筆明細」，
//       於是日均銷量 0 → 再訂購點 0 → 什麼都不用採購。
// 做法：(1) 單次逾時放寬到 30 秒；
//       (2) 讀取類端點（searchList / searchDetail）失敗後自動再試一次，
//           整體有 52 秒的總預算，不會超過 maxDuration；
//       (3) 寫入類端點（createPurchase 等）永遠只打一次，絕不重試。
// 搭配：vercel.json 要幫這支開 maxDuration: 60。

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

// 單次嘗試的逾時（毫秒）
const ATTEMPT_TIMEOUT_MS = 30000;
// 含重試在內的總預算，必須明顯小於 vercel.json 的 maxDuration(60s)
const TOTAL_BUDGET_MS = 52000;
// 讀取類端點最多打幾次
const MAX_READ_ATTEMPTS = 2;

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

// 這次請求可不可以安全地重試？
// 只有「查詢」可以。建立採購單之類的寫入動作重打一次會變成兩張單。
function isRetryableRead(target, method, parsedBody) {
  if (method === 'GET') return true;              // GET 本來就是查詢
  if (target !== 'oms-proxy') return false;       // po-meta / receive-log / send-email 一律不重試
  const ep = parsedBody && typeof parsedBody.endpoint === 'string' ? parsedBody.endpoint : '';
  return /\/(searchList|searchDetail)$/i.test(ep.trim());
}

function parseBody(raw) {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  return raw;
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

  const parsedBody = req.method === 'POST' ? parseBody(req.body) : null;
  const bodyText = req.method === 'POST' ? JSON.stringify(parsedBody == null ? {} : parsedBody) : null;
  const maxAttempts = isRetryableRead(target, req.method, parsedBody) ? MAX_READ_ATTEMPTS : 1;

  const startedAt = Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    // 剩下的時間不夠再打一次像樣的請求，就別浪費了
    if (remaining < 4000) break;
    const thisTimeout = Math.min(ATTEMPT_TIMEOUT_MS, remaining);

    const init = {
      method: req.method,
      headers: { 'x-proxy-token': omsToken },
    };
    if (req.method === 'POST') {
      init.headers['Content-Type'] = 'application/json';
      init.body = bodyText;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), thisTimeout);
    init.signal = controller.signal;

    try {
      const upstream = await fetch(upstreamUrl, init);
      const text = await upstream.text();
      const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';

      // 上游自己回 5xx，而且還有重試額度，就再試一次
      if (upstream.status >= 500 && attempt < maxAttempts) {
        lastError = { kind: 'upstream_5xx', status: upstream.status };
        continue;
      }

      res.status(upstream.status);
      res.setHeader('Content-Type', contentType);
      res.setHeader('x-oms-attempts', String(attempt));
      res.setHeader('x-oms-elapsed-ms', String(Date.now() - startedAt));
      return res.send(text);
    } catch (e) {
      lastError = { kind: e.name === 'AbortError' ? 'timeout' : 'network', detail: e.message };
      if (attempt < maxAttempts) {
        console.warn(`oms-call retry: ${target} attempt ${attempt} ${lastError.kind}`);
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const elapsed = Date.now() - startedAt;
  res.setHeader('x-oms-attempts', String(maxAttempts));
  res.setHeader('x-oms-elapsed-ms', String(elapsed));

  if (lastError && lastError.kind === 'timeout') {
    console.error('oms-call timeout:', target, elapsed + 'ms');
    return res.status(504).json({
      error: 'upstream_timeout',
      target,
      attempts: maxAttempts,
      elapsed_ms: elapsed,
      hint: 'OMS 上游回應太慢，請再按一次拉取',
    });
  }

  console.error('oms-call error:', target, lastError && lastError.detail);
  return res.status(502).json({
    error: 'upstream_unreachable',
    target,
    attempts: maxAttempts,
    elapsed_ms: elapsed,
    detail: lastError ? lastError.detail || lastError.kind : 'unknown',
  });
};
