const nodemailer = require('nodemailer');

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
  const SHEET_URL = 'https://script.google.com/macros/s/AKfycbwVJj2tFDZ11CZWxsquHuhcI40NDSy3uWydiY-3TJqyiy5pxbVSfIVnkTXtWNWukZmG/exec';

  try {
    const orderRes = await fetch(
      `https://${SHOP}/admin/api/2026-07/orders/${order_id}.json`,
      { headers: { 'X-Shopify-Access-Token': TOKEN } }
    );
    const { order } = await orderRes.json();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.cancelled_at) return res.status(400).json({ error: 'already_cancelled' });
    if (order.fulfillment_status === 'fulfilled') return res.status(400).json({ error: 'already_fulfilled' });

    const hours = (Date.now() - new Date(order.created_at)) / (1000 * 60 * 60);
    if (hours > 12) return res.status(400).json({ error: 'over_12_hours' });

    const isPending = order.financial_status === 'pending';
    let cancelBody = {};

    if (!isPending) {
      const refundLineItems = order.line_items.map(item => ({
        line_item_id: item.id,
        quantity: item.quantity,
        restock_type: 'no_restock'
      }));

      const shippingAmount = order.shipping_lines.reduce((sum, s) => {
        return sum + parseFloat(s.price || 0);
      }, 0);

      cancelBody = {
        refund: {
          shipping: { amount: shippingAmount.toFixed(2), full_refund: false },
          refund_line_items: refundLineItems,
          notify: true
        }
      };
    }

    const cancelRes = await fetch(
      `https://${SHOP}/admin/api/2026-07/orders/${order_id}/cancel.json`,
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
      console.error('Cancel error:', JSON.stringify(err));
      return res.status(500).json({ error: 'cancel_failed' });
    }

    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const paymentMethod = order.payment_gateway_names?.[0] || order.financial_status;
    const note = isPending ? '貨到付款，無需退款' : '需人工退款';
    const price = Math.floor(parseFloat(order.total_price));

    await fetch(SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cancelled_at: now,
        order_name: order.name,
        email: order.email,
        total_price: order.total_price,
        payment_method: paymentMethod,
        note: note
      })
    }).catch(e => console.error('Sheet write error:', e));

    const refundNote = isPending
      ? '此訂單為貨到付款，取消後無需退款。'
      : '退款將於 3–5 個工作天內退回原付款方式。';

    const itemList = order.line_items.map(i =>
      `<tr>
        <td style="padding:8px 0;font-size:13px;color:#555;border-bottom:1px solid #eee">${i.title}${i.variant_title ? ' - ' + i.variant_title : ''}</td>
        <td style="padding:8px 0;font-size:13px;color:#555;border-bottom:1px solid #eee;text-align:right">× ${i.quantity}</td>
      </tr>`
    ).join('');

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: `"EnamoR 恩娜茉兒" <${process.env.GMAIL_USER}>`,
      to: order.email,
      subject: `【EnamoR】訂單 ${order.name} 已取消`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <p style="font-size:13px;color:#888;letter-spacing:0.1em">ENAMOR 恩娜茉兒</p>
          <h2 style="font-size:20px;font-weight:400;margin:16px 0 8px">訂單已取消</h2>
          <p style="font-size:14px;color:#555;line-height:1.7">您的訂單 <strong>${order.name}</strong> 已成功取消。</p>
          <table style="width:100%;margin:24px 0;border-collapse:collapse">
            ${itemList}
          </table>
          <div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:8px">
            <span style="color:#888">訂單金額</span>
            <span>NT$ ${price.toLocaleString()}</span>
          </div>
          <div style="background:#f9eeec;border:1px solid #f0c4be;border-radius:2px;padding:12px 16px;margin:20px 0;font-size:13px;color:#c0392b;line-height:1.6">
            ${refundNote}
          </div>
          <p style="font-size:13px;color:#888;line-height:1.7">如有任何問題，請聯繫客服：<br>
            <a href="mailto:service@enamorshop.com" style="color:#1a1814">service@enamorshop.com</a>
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:32px 0">
          <p style="font-size:11px;color:#aaa">© EnamoR 恩娜茉兒</p>
        </div>
      `
    }).catch(e => console.error('Email error:', e));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
};
