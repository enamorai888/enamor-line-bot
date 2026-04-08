module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

  const SHOP = process.env.SHOPIFY_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ORDER_TOKEN;

  try {
    const orderRes = await fetch(
      `https://${SHOP}/admin/api/2026-07/orders/${order_id}.json?fields=id,created_at,cancelled_at,fulfillment_status,financial_status,total_price`,
      { headers: { 'X-Shopify-Access-Token': TOKEN } }
    );
    const { order } = await orderRes.json();

    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.cancelled_at) return res.status(400).json({ error: 'already_cancelled' });
    if (order.fulfillment_status === 'fulfilled') return res.status(400).json({ error: 'already_fulfilled' });

    const hours = (Date.now() - new Date(order.created_at)) / (1000 * 60 * 60);
    if (hours > 12) return res.status(400).json({ error: 'over_12_hours' });

    const isPending = order.financial_status === 'pending';

    const cancelRes = await fetch(
      `https://${SHOP}/admin/api/2026-07/orders/${order_id}/cancel.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(isPending ? {} : { refund: { shipping: { full_refund: true } } })
      }
    );

    if (!cancelRes.ok) {
      const err = await cancelRes.json();
      console.error('Cancel error:', err);
      return res.status(500).json({ error: 'cancel_failed' });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
};
