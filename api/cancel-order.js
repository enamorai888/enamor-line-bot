// api/cancel-order.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://enamorshop.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { order_id, order_token } = req.body;
  if (!order_id || !order_token) {
    return res.status(400).json({ error: 'Missing order_id or order_token' });
  }

  const SHOP = process.env.SHOPIFY_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  try {
    // 1. 抓訂單資料
    const orderRes = await fetch(
      `https://${SHOP}/admin/api/2024-10/orders/${order_id}.json?fields=id,token,created_at,cancelled_at,fulfillment_status,financial_status`,
      { headers: { 'X-Shopify-Access-Token': TOKEN } }
    );
    const { order } = await orderRes.json();

    // 驗證 token
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

    // 12小時檢查
    const hoursElapsed = (new Date() - new Date(order.created_at)) / (1000 * 60 * 60);
    if (hoursElapsed > 12) {
      return res.status(400).json({ error: 'over_12_hours' });
    }

    // 2. 判斷付款狀態決定取消方式
    const isPending = order.financial_status === 'pending'; // 貨到付款未付

    const cancelBody = isPending
      ? { reason: 'customer', email: false, restock: true }          // 不退款
      : { reason: 'customer', email: false, restock: true, refund: { shipping: { full_refund: true }, transactions: [{ kind: 'refund', amount: order.total_price, gateway: order.payment_gateway }] } }; // 退款

    // 3. 直接取消訂單（不走標籤，直接 API 取消）
    const cancelRes = await fetch(
      `https://${SHOP}/admin/api/2024-10/orders/${order_id}/cancel.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(cancelBody)
      }
    );

    if (!cancelRes.ok) {
      const err = await cancelRes.json();
      console.error('Cancel failed:', err);
      throw new Error('Cancel failed');
    }

    return res.status(200).json({ success: true, refunded: !isPending });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
