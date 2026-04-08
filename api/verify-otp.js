// api/verify-otp.js
import { otpStore } from './send-otp.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Missing fields' });

  const record = otpStore.get(email.toLowerCase());
  if (!record) return res.status(400).json({ error: 'otp_not_found' });
  if (Date.now() > record.expires) {
    otpStore.delete(email.toLowerCase());
    return res.status(400).json({ error: 'otp_expired' });
  }
  if (record.otp !== otp) return res.status(400).json({ error: 'otp_invalid' });

  otpStore.delete(email.toLowerCase());

  // 查訂單
  const SHOP = process.env.SHOPIFY_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

  try {
    const ordersRes = await fetch(
      `https://${SHOP}/admin/api/2024-10/orders.json?email=${encodeURIComponent(email)}&status=open&limit=20&fields=id,name,created_at,cancelled_at,fulfillment_status,financial_status,total_price,line_items,token`,
      { headers: { 'X-Shopify-Access-Token': TOKEN } }
    );
    const { orders } = await ordersRes.json();

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
        token: o.token,
        items: o.line_items.map(i => ({ title: i.title, quantity: i.quantity }))
      }));

    return res.status(200).json({ success: true, orders: cancellable });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
}
