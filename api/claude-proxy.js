// api/claude-proxy.js
// 允許來源：enamorshop.com + enamor-line-bot.vercel.app
// 驗證：x-proxy-token header（設定在 Vercel 環境變數 PROXY_SECRET）

const ALLOWED_ORIGINS = [
  'https://enamorshop.com',
  'https://www.enamorshop.com',
  'https://enamor-line-bot.vercel.app',
];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-proxy-token');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // ── Token 驗證 ──────────────────────────────────────────
  const PROXY_SECRET = process.env.PROXY_SECRET;
  if (PROXY_SECRET) {
    const token = req.headers['x-proxy-token'];
    if (!token || token !== PROXY_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();

    // 修復 AI 把 URL 換行輸出的問題
    if (data.content?.[0]?.text) {
      data.content[0].text = data.content[0].text
        .replace(/(https?:\/\/[^\s\n]+)\n([a-zA-Z0-9\-._~/?#@!$&'*+,;=%]+)/g, '$1$2')
        .replace(/(https?:\/\/[^\s\n]+)\n([a-zA-Z0-9\-._~/?#@!$&'*+,;=%]+)/g, '$1$2');
    }

    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
