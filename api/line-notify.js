// api/line-notify.js
// 部署位置：GitHub enamorai888/enamor-line-bot → api/line-notify.js

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ── 從 Shopify Tags 取出 LINE UID ──────────────────────────────────────
function extractLineUid(shopifyTags) {
  if (!shopifyTags) return null;
  try {
    // Klaviyo 傳來的是 JSON array 字串
    const tags = typeof shopifyTags === 'string'
      ? JSON.parse(shopifyTags)
      : shopifyTags;
    const tag = tags.find(t => t.startsWith('uid_line_'));
    if (!tag) return null;
    // uid_line_Uxxxxxxx → Uxxxxxxx
    return tag.replace('uid_line_', '');
  } catch (e) {
    console.error('extractLineUid error:', e.message);
    return null;
  }
}

// ── 組訊息內容 ─────────────────────────────────────────────────────────
function buildMessage(event_type, data) {
  switch (event_type) {

    case 'abandoned_cart':
      return `🛒 您的購物車還有商品等您～\n\n` +
        `${data.product_name ? '商品：' + data.product_name + '\n' : ''}` +
        `結帳請點：${data.checkout_url || 'https://enamorshop.com/cart'}\n\n` +
        `有任何問題歡迎找我們 💕`;

    case 'winback':
      return `好久不見 🌸\n\n` +
        `距離上次購買已經一段時間了，` +
        `最近有新品上架，歡迎回來逛逛！\n\n` +
        `https://enamorshop.com`;

    case 'new_product':
      return `✨ 新品上架！\n\n` +
        `${data.product_name ? data.product_name + '\n' : ''}` +
        `${data.product_url ? data.product_url + '\n' : 'https://enamorshop.com/collections/new\n'}` +
        `\n手刀去看看 👀`;

    case 'promotion':
      return `🎉 ${data.title || '限時優惠開跑！'}\n\n` +
        `${data.description || ''}\n` +
        `${data.url || 'https://enamorshop.com'}\n\n` +
        `優惠期間有限，把握機會 💕`;

    case 'points_added':
      return `🎁 EN POINT 入帳通知\n\n` +
        `您已獲得 ${data.points || ''} 點\n` +
        `點數可於下次購物折抵使用\n\n` +
        `https://enamorshop.com/account`;

    case 'tier_upgrade':
      return `🌟 恭喜升級！\n\n` +
        `您已升級為 ${data.tier_name || '新等級'} 會員\n` +
        `專屬權益即刻生效 🎊\n\n` +
        `https://enamorshop.com/account`;

    case 'birthday':
      return `🎂 生日快樂！\n\n` +
        `${data.gift_description || '專屬生日禮已送達您的帳戶'}\n` +
        `祝您生日愉快，今天要好好寵愛自己 💕\n\n` +
        `https://enamorshop.com/account`;

    case 'shipping':
      return `📦 您的訂單已出貨！\n\n` +
        `${data.order_name ? '訂單：' + data.order_name + '\n' : ''}` +
        `${data.tracking_number ? '追蹤號碼：' + data.tracking_number + '\n' : ''}` +
        `${data.tracking_url ? data.tracking_url + '\n' : ''}` +
        `\n預計 1-3 個工作天送達 🚚`;

    default:
      return data.message || null;
  }
}

// ── 發 LINE push ───────────────────────────────────────────────────────
async function sendLinePush(uid, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      to: uid,
      messages: [{ type: 'text', text }]
    })
  });
  const result = await res.json();
  console.log('LINE push result:', JSON.stringify(result));
  return res.ok;
}

// ── Main Handler ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      email,
      event_type,
      shopify_tags,
      data = {}
    } = req.body;

    if (!email || !event_type) {
      return res.status(400).json({ error: 'Missing email or event_type' });
    }

    // 取出 LINE UID
    const lineUid = extractLineUid(shopify_tags);

    if (!lineUid) {
      console.log(`No LINE UID for ${email}, skipping`);
      return res.status(200).json({ status: 'skipped', reason: 'no_line_uid' });
    }

    // 組訊息
    const message = buildMessage(event_type, data);

    if (!message) {
      console.log(`No message template for event_type: ${event_type}`);
      return res.status(200).json({ status: 'skipped', reason: 'no_message_template' });
    }

    // 發送
    const ok = await sendLinePush(lineUid, message);

    return res.status(200).json({
      status: ok ? 'sent' : 'failed',
      email,
      event_type,
      uid: lineUid.substring(0, 8) + '...' // log 不暴露完整 UID
    });

  } catch (e) {
    console.error('line-notify error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
