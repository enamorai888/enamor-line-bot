const crypto = require('crypto');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const SHEET_URL = process.env.SHEET_URL || '';

const SYSTEM_PROMPT = `你是 EnamoR 的客服，名字是「EnamoR 客服」，台灣女性內著品牌。不要自稱「小助手」、「依戀」或其他名稱，統一自稱「EnamoR 客服」。用親切溫暖的繁體中文，語氣有質感但簡潔，不超過150字。

【退換貨政策】
- 7天鑑賞期內未拆封可退：登入官網>會員中心>訂單查詢申請
- 已拆封：貼身衣物基於衛生考量無法退換
- 試穿後：無法退換
- 換貨：可換顏色/尺寸，已拆封不接受

【出貨時間】
- 現貨：1~3個工作天出貨
- 預購A1：約14天；A2：約7天；B：以商品頁為準
- 超商/宅配：出貨後2~4個工作天

【其他常見】
- 免運：折扣後滿899（外島除外）
- 萊卡M號適合褲子M~XL；L號適合XL~3L
- 客服時間：週一~週五 09:00~12:00 / 13:00~17:00

【需要人工】回覆最後加 ###NEED_HUMAN###：
- 訂單查詢、退換貨進度、商品瑕疵、客人持續不滿、說要找真人

【政策直接擋，不需人工】
- 已拆封退貨、試穿後退貨、超過7天退貨`;

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, []);
  }
  return sessions.get(userId);
}

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: messages.slice(-12)
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || '抱歉，我現在無法回覆，請稍後再試。';
}

async function replyToLine(replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }]
    })
  });
  const data = await res.json();
  console.log('replyToLine result:', JSON.stringify(data));
}

async function notifySheet(userId, userMsg, botReply) {
  if (!SHEET_URL) return;
  await fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      source: 'LINE Bot',
      type: 'human_handoff',
      answers: JSON.stringify([{ q: '客人訊息', a: userMsg }]),
      summary: `LINE 用戶 ${userId}\n客人說：${userMsg}\nAI 回：${botReply}`
    })
  }).catch(() => {});
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('EnamoR LINE Bot OK');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const signature = req.headers['x-line-signature'];
  const rawBody = JSON.stringify(req.body);
  const hmac = crypto.createHmac('sha256', CHANNEL_SECRET)
    .update(rawBody).digest('base64');

  if (signature !== hmac) {
    console.log('Signature mismatch');
    return res.status(401).send('Invalid signature');
  }

  const events = req.body.events || [];

  for (const event of events) {
    if (event.type !== 'message' || event.message.type !== 'text') continue;

    const userId = event.source.userId;
    const userText = event.message.text.trim();
    const replyToken = event.replyToken;
    const messages = getSession(userId);

    messages.push({ role: 'user', content: userText });

    try {
      let reply = await callClaude(messages);
      const needHuman = reply.includes('###NEED_HUMAN###');
      reply = reply.replace('###NEED_HUMAN###', '').trim();

      if (needHuman) {
        reply += '\n\n已通知客服，將於工作時間（週一~週五 9~17時）回覆您。';
        await notifySheet(userId, userText, reply);
      }

      messages.push({ role: 'assistant', content: reply });
      if (messages.length > 20) messages.splice(0, 4);

      await replyToLine(replyToken, reply);
    } catch (e) {
      console.error('handler error:', e);
      try {
        await replyToLine(replyToken, '抱歉，系統暫時無法回覆，請稍後再試。');
      } catch (e2) {}
    }
  }

  return res.status(200).send('OK');
};
