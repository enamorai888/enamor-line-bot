// api/verify-otp.js
//
// 驗證 email 收到的一次性驗證碼，回傳該 email 可取消的訂單，
// 並簽發一張「取消通行證」(ticket)。
//
// 為什麼要發通行證：
//   以前這支只負責「列出訂單」，而 /api/cancel-order 是獨立的端點、
//   沒有任何呼叫端驗證。等於驗證碼只鎖了前門，任何人都能直接打
//   cancel-order 取消別人的訂單並觸發退款。
//   現在 cancel-order 會要求這張票，且票裡綁死了 email 與允許取消的訂單編號。
//
// 票的內容是公開可讀的（base64），但被 HMAC 簽章保護，改一個字就失效。
// 有效期 15 分鐘。

const crypto = require('crypto');

const TICKET_TTL_MS = 15 * 60 * 1000;
// 前綴做用途隔離，確保這張票永遠不可能被當成後台登入 cookie 使用
const TICKET_PREFIX = 'cancel-ticket.v1.';

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signTicket(payloadB64, secret) {
  return crypto.createHmac('sha256', secret)
    .update(TICKET_PREFIX + payloadB64).digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Missing fields' });

  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    console.error('verify-otp 缺少環境變數: ADMIN_SESSION_SECRET');
    return res.status(500).json({ error: 'server_not_configured' });
  }

  const key = `otp:${email.toLowerCase()}`;
  const getRes = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
  });
  const { result } = await getRes.json();
  if (!result) return res.status(400).json({ error: 'otp_not_found' });
  if (result !== otp) return res.status(400).json({ error: 'otp_invalid' });

  await fetch(`${process.env.KV_REST_API_URL}/del/${key}`, {
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
  });

  const SHOP = process.env.SHOPIFY_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ORDER_TOKEN;

  try {
    const ordersRes = await fetch(
      `https://${SHOP}/admin/api/2026-07/orders.json?email=${encodeURIComponent(email)}&status=any&limit=20&fields=id,name,created_at,cancelled_at,fulfillment_status,financial_status,total_price,line_items`,
      { headers: { 'X-Shopify-Access-Token': TOKEN } }
    );

    const shopifyData = await ordersRes.json();

    if (!ordersRes.ok) {
      console.error('Shopify error:', ordersRes.status);
      return res.status(500).json({ error: 'shopify_error' });
    }

    const orders = shopifyData.orders || [];
    const now = new Date();
    const cancellable = orders
      .filter(o => {
        if (o.cancelled_at) return false;
        if (o.fulfillment_status === 'fulfilled') return false;
        const hours = (now - new Date(o.created_at)) / (1000 * 60 * 60);
        return hours <= 12;
      })
      .map(o => ({
        id: o.id,
        name: o.name,
        created_at: o.created_at,
        financial_status: o.financial_status,
        total_price: o.total_price,
        items: o.line_items.map(i => ({ title: i.title, quantity: i.quantity }))
      }));

    // ── 簽發通行證：綁定 email 與這批訂單編號 ──
    const payload = {
      e: email.toLowerCase(),
      o: cancellable.map(o => String(o.id)),
      x: Date.now() + TICKET_TTL_MS
    };
    const payloadB64 = b64url(JSON.stringify(payload));
    const ticket = payloadB64 + '.' + signTicket(payloadB64, secret);

    return res.status(200).json({ success: true, orders: cancellable, ticket });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
};
