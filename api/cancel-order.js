// api/cancel-order.js
//
// 取消訂單並退款。
//
// 這支以前完全沒有呼叫端驗證：丟一個 order_id 進來，只要單子未出貨、
// 12 小時內，就會直接取消並開退款。任何人都能跳過驗證碼直接打它。
//
// 現在必須帶 /api/verify-otp 簽發的通行證 (ticket)，而且會三重確認：
//   1. 票的簽章有效、沒過期
//   2. 要取消的 order_id 在票允許的清單裡
//   3. 向 Shopify 取回的訂單 email 與票上的 email 相符
//
// 取消紀錄改寫到環境變數 CANCEL_LOG_WEBHOOK 指定的 Apps Script，
// 並附上 CANCEL_LOG_SECRET 讓 Apps Script 驗證來源。
// 欄位名對齊紀錄表的 schema；event_id 讓它能對重送去重。
// 失敗也會記一筆（result=失敗），這樣紀錄表看得到沒成功的取消。
// 紀錄寫入失敗不會擋下取消——顧客的取消權不該因為記帳壞掉而失效。

const crypto = require('crypto');
const nodemailer = require('nodemailer');

const TICKET_PREFIX = 'cancel-ticket.v1.';

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function signTicket(payloadB64, secret) {
  return crypto.createHmac('sha256', secret)
    .update(TICKET_PREFIX + payloadB64).digest('hex');
}

// 回傳票裡的內容，任何一關不過就回 null
function readTicket(ticket, secret) {
  if (typeof ticket !== 'string' || !ticket) return null;
  const dot = ticket.lastIndexOf('.');
  if (dot < 1) return null;

  const payloadB64 = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!timingSafeEqual(sig, signTicket(payloadB64, secret))) return null;

  let payload;
  try {
    const json = Buffer.from(
      payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'
    ).toString('utf8');
    payload = JSON.parse(json);
  } catch (e) {
    return null;
  }

  if (!payload || typeof payload.e !== 'string' || !Array.isArray(payload.o)) return null;
  if (typeof payload.x !== 'number' || payload.x < Date.now()) return null;

  return payload;
}

// 寫一筆取消紀錄。永遠不丟例外，失敗只寫 log。
async function writeLog(fields) {
  const LOG_URL = process.env.CANCEL_LOG_WEBHOOK;
  const LOG_SECRET = process.env.CANCEL_LOG_SECRET;
  if (!LOG_URL || !LOG_SECRET) {
    console.error('取消紀錄未寫入：缺少 CANCEL_LOG_WEBHOOK 或 CANCEL_LOG_SECRET');
    return;
  }
  try {
    await fetch(LOG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({
        secret: LOG_SECRET,
        timestamp: new Date().toISOString(),
        source: 'vercel-cancel-order'
      }, fields))
    });
  } catch (e) {
    console.error('取消紀錄寫入失敗:', e.message);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { order_id, ticket } = req.body || {};
  if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    console.error('cancel-order 缺少環境變數: ADMIN_SESSION_SECRET');
    return res.status(500).json({ error: 'server_not_configured' });
  }

  // ── 關卡一、二：票有效，且這張單在票允許的清單裡 ──
  const pass = readTicket(ticket, secret);
  if (!pass) {
    return res.status(401).json({ error: 'ticket_invalid', hint: '請重新收取驗證碼' });
  }
  if (!pass.o.includes(String(order_id))) {
    console.warn('cancel-order 票與訂單不符:', pass.e, order_id);
    return res.status(403).json({ error: 'order_not_in_ticket' });
  }

  const SHOP = process.env.SHOPIFY_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ORDER_TOKEN;

  try {
    const orderRes = await fetch(
      `https://${SHOP}/admin/api/2026-07/orders/${encodeURIComponent(order_id)}.json`,
      { headers: { 'X-Shopify-Access-Token': TOKEN } }
    );
    const { order } = await orderRes.json();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // ── 關卡三：訂單的 email 要與票上的相符 ──
    if (String(order.email || '').toLowerCase() !== pass.e) {
      console.warn('cancel-order email 不符:', pass.e, order.id);
      return res.status(403).json({ error: 'order_not_yours' });
    }

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
      `https://${SHOP}/admin/api/2026-07/orders/${encodeURIComponent(order_id)}/cancel.json`,
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
      await writeLog({
        event_id: 'cancel-fail-' + order.id + '-' + Date.now(),
        order_name: order.name,
        order_id: String(order.id),
        email: order.email,
        customer_name: [order.customer && order.customer.last_name, order.customer && order.customer.first_name].filter(Boolean).join(''),
        reason: '顧客自助取消',
        total_price: order.total_price,
        result: '失敗',
        refund_status: '',
        error: JSON.stringify(err).slice(0, 500)
      });
      return res.status(500).json({ error: 'cancel_failed' });
    }

    const paymentMethod = order.payment_gateway_names?.[0] || order.financial_status;
    const price = Math.floor(parseFloat(order.total_price));

    // ── 寫取消紀錄（失敗不擋取消）──
    await writeLog({
      event_id: 'cancel-' + order.id,
      order_name: order.name,
      order_id: String(order.id),
      email: order.email,
      customer_name: [order.customer && order.customer.last_name, order.customer && order.customer.first_name].filter(Boolean).join(''),
      reason: '顧客自助取消',
      total_price: order.total_price,
      result: '成功',
      refund_status: isPending ? '貨到付款，無需退款' : '需人工退款（付款方式：' + paymentMethod + '）',
      error: ''
    });

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
