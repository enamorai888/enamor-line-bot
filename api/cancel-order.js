// api/cancel-order.js
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://enamorshop.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { order_id, order_token } = req.body;
  if (!order_id || !order_token) {
    return res.status(400).json({ error: 'Missing order_id or order_token' });
  }

  const SHOP = process.env.SHOPIFY_DOMAIN;        // ← 改這行
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  try {
    // 1. 先抓訂單資料，驗證 token 並確認時間
    const orderRes = await fetch(
      `https://${SHOP}/admin/api/2024-10/orders/${order_id}.json?fields=id,token,created_at,cancelled_at,fulfillment_status,financial_status`,
      { headers: { 'X-Shopify-Access-Token': TOKEN } }
    );
    const { order } = await orderRes.json();

    // 驗證 token（防止亂猜 order_id）
    if (order.token !== order_token) {
      return res.status(403).json({ error: 'Invalid order token' });
    }

    // 已取消
    if (order.cancelled_at) {
      return res.status(400).json({ error: 'already_cancelled' });
    }

    // 已出貨
    if (order.fulfillment_status === 'fulfilled') {
      return res.status(400).json({ error: 'already_fulfilled' });
    }

    // 計算下單時間是否在12小時內
    const createdAt = new Date(order.created_at);
    const now = new Date();
    const hoursElapsed = (now - createdAt) / (1000 * 60 * 60);

    if (hoursElapsed > 12) {
      return res.status(400).json({ error: 'over_12_hours' });
    }

    // 2. 加標籤 cancel-requested（讓 Flow 接手）
    const tagsRes = await fetch(
      `https://${SHOP}/admin/api/2024-10/orders/${order_id}.json`,
      {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          order: { id: order_id, tags: 'cancel-requested' }
        })
      }
    );

    if (!tagsRes.ok) throw new Error('Failed to tag order');

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
