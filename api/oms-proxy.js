/**
 * EnamoR OMS Proxy API
 * Vercel Serverless Function
 * 
 * 功能：統一處理 OMS API 認證 + 請求轉發
 * - 自動取得 / 刷新 Token
 * - 前端只需打這個 proxy，不碰 OMS 認證
 * 
 * 環境變數（Vercel 設定）：
 *   OMS_API_URL    = https://oms.licodes.net/demo   （測試站）
 *   OMS_CLIENT_ID  = lifecom
 *   OMS_CHECK_VALUE = XNmsgn4D
 *   OMS_PROXY_SECRET = 28447208  （防外部濫用，跟 claude-proxy 用同一組）
 * 
 * 用法：
 *   POST /api/oms-proxy
 *   Headers: { "x-proxy-token": "28447208" }
 *   Body: {
 *     "endpoint": "/api/v2/default/getStocksData/searchList",
 *     "body": { ... }
 *   }
 */

// ── Token 快取（冷啟動會清空，但同一實例內有效）──
let cachedToken = null;
let tokenExpiry = 0;

const OMS_API_URL = process.env.OMS_API_URL || 'https://oms.licodes.net/demo';
const OMS_CLIENT_ID = process.env.OMS_CLIENT_ID || 'lifecom';
const OMS_CHECK_VALUE = process.env.OMS_CHECK_VALUE || 'XNmsgn4D';
const PROXY_SECRET = process.env.OMS_PROXY_SECRET || process.env.PROXY_SECRET || '28447208';

// ── 取得 Token ──
async function getToken() {
  // 如果快取的 token 還沒過期，直接用
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const url = `${OMS_API_URL}/api/v1/token/getToken`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ClientId: OMS_CLIENT_ID,
      CheckValue: OMS_CHECK_VALUE,
    }),
  });

  if (!res.ok) {
    throw new Error(`OMS Token 取得失敗: HTTP ${res.status}`);
  }

  const data = await res.json();

  if (!data.result || !data.retval?.access_token) {
    throw new Error(`OMS Token 取得失敗: ${data.msg || '未知錯誤'}`);
  }

  cachedToken = data.retval.access_token;
  // Token 快取 50 分鐘（假設有效期 1 小時，提前 10 分鐘刷新）
  tokenExpiry = Date.now() + 50 * 60 * 1000;

  return cachedToken;
}

// ── 轉發請求到 OMS ──
async function forwardToOMS(endpoint, body) {
  const token = await getToken();
  const url = `${OMS_API_URL}${endpoint}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body || {}),
  });

  const data = await res.json();

  // 如果 token 過期（401），重新取得再試一次
  if (res.status === 401 || (data.result === false && data.msg?.includes('token'))) {
    cachedToken = null;
    tokenExpiry = 0;

    const newToken = await getToken();
    const retryRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${newToken}`,
      },
      body: JSON.stringify(body || {}),
    });

    return await retryRes.json();
  }

  return data;
}

// ── Vercel Handler ──
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-proxy-token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 驗證 proxy token
  const proxyToken = req.headers['x-proxy-token'];
  if (proxyToken !== PROXY_SECRET) {
    return res.status(403).json({ error: '未授權' });
  }

  try {
    const { endpoint, body } = req.body;

    if (!endpoint) {
      return res.status(400).json({ error: '缺少 endpoint 參數' });
    }

    // 白名單：只允許特定 endpoint
    const ALLOWED_ENDPOINTS = [
      '/api/v1/token/getToken',
      '/api/v2/default/getStocksData/searchList',
      '/api/v2/default/apiOrderList/searchList',
      '/api/v2/default/apiOrderList/searchDetail',
      '/api/v2/default/apiPurchaseHeaderList/searchList',
      '/api/v2/default/apiPurchaseHeaderList/searchDetail',
      '/api/v2/default/action/createPurchase',
    ];

    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      return res.status(400).json({ error: `不允許的 endpoint: ${endpoint}` });
    }

    const data = await forwardToOMS(endpoint, body);
    return res.status(200).json(data);

  } catch (err) {
    console.error('OMS Proxy Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
