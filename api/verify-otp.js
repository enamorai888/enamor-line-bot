module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Missing fields' });

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
    console.log('Shopify status:', ordersRes.status);
    console.log('Shopify response:', JSON.stringify(shopifyData).slice(0, 300));

    if (!ordersRes.ok) {
      return res.status(500).json({ error: 'shopify_error', detail: shopifyData });
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

    return res.status(200).json({ success: true, orders: cancellable });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
};
