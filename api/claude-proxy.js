// api/claude-proxy.js
// EnamoR AI Proxy —— 2026-10 安全重寫
//
// 為什麼要改：
//   舊版把 req.body 原封不動轉給 Anthropic，而驗證只靠前端寫死的
//   x-proxy-token。寫在前端的字串永遠是公開的，等於沒有鎖，任何人
//   都能用這支端點當免費的通用 Claude API。
//
// 新的分工：
//   1. 對外任務（support）：model / system / max_tokens 全部由這支檔案
//      決定，前端只能送 messages。前端不再持有任何密碼。
//   2. 對內任務（admin）：需要 /api/admin-login 簽發的 HttpOnly cookie，
//      可自帶 system 與 prompt，但 model 與 max_tokens 仍受白名單與上限約束。
//   3. 速率限制：以 Vercel KV（Upstash REST）按 IP + 任務計數。
//   4. x-proxy-token 已完全移除。

const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  'https://enamorshop.com',
  'https://www.enamorshop.com',
  'https://enamor-line-bot.vercel.app',
];

const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-sonnet-4-20250514',
]);

// ── 對外客服的 system prompt（從 support.html 搬過來）──────────
const SUPPORT_SYSTEM = `你是 EnamoR 恩娜茉兒的 AI 客服，專業、親切、簡潔。

品牌資訊：
- 台灣MIT女性內衣褲品牌，主力為 ZERO-TEX 萊卡抗菌系列
- 免運門檻：折扣後滿 NT$999（外島除外）
- 客服時間：週一至週五 09:00–17:00
- 現貨出貨：1-3個工作天，宅配1-2天
- 預購類型：A1（生產製程中）、A2（長銷補貨）、B（流行性商品）
- 退貨：收到7天內、未拆封、未洗滌可申請；內衣褲拆封後不可退
- 換貨：尺寸、顏色可換，已穿著不受理
- 取消訂單：下單12小時內可自助取消
- 已付款退款：7-14個工作天退回

回覆原則：
- 用繁體中文，語氣溫柔有質感
- 簡短直接，不超過3段
- 無法確認的事項（如特定訂單）請引導使用下方功能查詢
- 結尾可視情況引導加入 LINE @enamorshop`;

const TASKS = {
  // 對外：客服頁。前端只能送 messages。
  support: {
    requireAdmin: false,
    model: 'claude-sonnet-4-6',
    maxTokens: 500,
    system: SUPPORT_SYSTEM,
    allowClientSystem: false,
    maxMessages: 10,
    maxChars: 4000,
    perMinute: 6,
    perDay: 150,
  },
  // 對內：studio / shopify-ops / sales。需要 admin cookie。
  admin: {
    requireAdmin: true,
    model: 'claude-sonnet-4-6',
    maxTokens: 4096,
    system: null,
    allowClientSystem: true,
    maxMessages: 30,
    maxChars: 40000,
    perMinute: 40,
    perDay: 3000,
  },
};

// ── 工具 ────────────────────────────────────────────────────
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 驗證 /api/admin-login 簽發的 session cookie：  <expiryMs>.<hmac>
function hasValidAdminSession(req) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return false;

  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)enamor_admin=([^;]+)/);
  if (!match) return false;

  const value = decodeURIComponent(match[1]);
  const dot = value.lastIndexOf('.');
  if (dot < 1) return false;

  const exp = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;

  const expected = crypto.createHmac('sha256', secret).update(exp).digest('hex');
  return timingSafeEqual(sig, expected);
}

// Upstash REST 計數。KV 不可用時回傳 null（放行，不擋住客人）。
async function bumpCounter(key, windowSeconds) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;

  try {
    const auth = { Authorization: `Bearer ${token}` };
    const incrRes = await fetch(`${url}/incr/${encodeURIComponent(key)}`, { headers: auth });
    if (!incrRes.ok) return null;
    const { result } = await incrRes.json();
    const count = Number(result);
    if (count === 1) {
      await fetch(`${url}/expire/${encodeURIComponent(key)}/${windowSeconds}`, { headers: auth });
    }
    return count;
  } catch (e) {
    console.error('rate-limit kv error:', e.message);
    return null;
  }
}

// 只留下 role 與 content，並限制長度；任何多餘欄位都丟掉。
function sanitizeMessages(input, cfg) {
  if (!Array.isArray(input)) return { error: 'messages_must_be_array' };

  const trimmed = input.slice(-cfg.maxMessages);
  const out = [];
  let total = 0;

  for (const m of trimmed) {
    if (!m || typeof m !== 'object') return { error: 'bad_message' };
    if (m.role !== 'user' && m.role !== 'assistant') return { error: 'bad_role' };
    if (typeof m.content !== 'string') return { error: 'content_must_be_string' };

    // 明確拒絕，不要靜靜截斷：被切一半的問題會得到莫名其妙的回覆
    total += m.content.length;
    if (total > cfg.maxChars) return { error: 'payload_too_large' };

    out.push({ role: m.role, content: m.content });
  }

  if (!out.length) return { error: 'messages_empty' };
  if (out[out.length - 1].role !== 'user') return { error: 'last_message_must_be_user' };
  return { messages: out };
}

// ── Handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  const originAllowed = ALLOWED_ORIGINS.includes(origin);

  if (originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // POST 一定帶 Origin。擋掉瀏覽器端的隨手濫用（curl 可偽造，
  // 所以真正的防線是下面的速率限制與伺服器端參數鎖定）。
  if (origin && !originAllowed) {
    return res.status(403).json({ error: 'origin_not_allowed' });
  }

  if (!process.env.CLAUDE_API_KEY) {
    return res.status(500).json({ error: 'server_not_configured' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const taskName = typeof body.task === 'string' ? body.task : '';
  const cfg = TASKS[taskName];
  if (!cfg) return res.status(400).json({ error: 'unknown_task' });

  if (cfg.requireAdmin && !hasValidAdminSession(req)) {
    return res.status(401).json({ error: 'admin_login_required' });
  }

  // ── 速率限制 ──
  const ip = clientIp(req);
  const minuteKey = `aiproxy:${taskName}:${ip}:m:${Math.floor(Date.now() / 60000)}`;
  const dayKey = `aiproxy:${taskName}:${ip}:d:${new Date().toISOString().slice(0, 10)}`;

  const perMin = await bumpCounter(minuteKey, 70);
  if (perMin !== null && perMin > cfg.perMinute) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'rate_limited', scope: 'minute' });
  }
  const perDay = await bumpCounter(dayKey, 60 * 60 * 24 + 60);
  if (perDay !== null && perDay > cfg.perDay) {
    return res.status(429).json({ error: 'rate_limited', scope: 'day' });
  }

  // ── 參數：伺服器端決定 ──
  const clean = sanitizeMessages(body.messages, cfg);
  if (clean.error) return res.status(400).json({ error: clean.error });

  let model = cfg.model;
  if (cfg.allowClientSystem && typeof body.model === 'string' && ALLOWED_MODELS.has(body.model)) {
    model = body.model;
  }

  let maxTokens = cfg.maxTokens;
  if (cfg.allowClientSystem && Number.isInteger(body.max_tokens)) {
    maxTokens = Math.min(Math.max(body.max_tokens, 1), cfg.maxTokens);
  }

  let system = cfg.system;
  if (cfg.allowClientSystem && typeof body.system === 'string') {
    system = body.system.slice(0, 20000);
  }

  const payload = { model, max_tokens: maxTokens, messages: clean.messages };
  if (system) payload.system = system;

  // ── 呼叫 Anthropic ──
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      // 不要把上游錯誤細節回給前端
      console.error('anthropic error', response.status, JSON.stringify(data).slice(0, 500));
      return res.status(502).json({ error: 'upstream_error' });
    }

    let text = Array.isArray(data.content)
      ? data.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('')
      : '';

    // 修復 AI 把 URL 換行輸出的問題（沿用舊版行為）
    text = text
      .replace(/(https?:\/\/[^\s\n]+)\n([a-zA-Z0-9\-._~/?#@!$&'*+,;=%]+)/g, '$1$2')
      .replace(/(https?:\/\/[^\s\n]+)\n([a-zA-Z0-9\-._~/?#@!$&'*+,;=%]+)/g, '$1$2');

    // 保留 content[0].text 形狀，前端舊的讀法不會壞
    return res.status(200).json({
      text,
      content: [{ type: 'text', text }],
      stop_reason: data.stop_reason || null,
    });
  } catch (e) {
    console.error('proxy error:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
};
