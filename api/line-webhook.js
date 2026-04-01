const crypto = require('crypto');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const SHEET_URL = process.env.SHEET_URL || '';
const SHEET_READER_URL = 'https://enamor-line-bot.vercel.app/api/sheet-reader';

// ── System Prompt ──────────────────────────────────────────────────────
const SYSTEM_DEFAULT = `你是 EnamoR 的專屬顧問，台灣女性內著精品品牌。以優雅、簡潔、有溫度的繁體中文回覆，語氣像精品門市的資深顧問，不超過 150 字。

【核心語氣原則】
- 不說「當然！」「絕對！」「作為AI」「非常感謝您的來訊」
- 不過度道歉，直接給解答
- 推薦商品時要有說服力，點出材質與穿著感受
- 句子精煉，避免重複用語

【退換貨政策】
- 7天鑑賞期內未拆封可退：官網 > 會員中心 > 訂單查詢申請，取得7-11退貨便代號，3天內至IBON操作
- 已拆封：貼身衣物基於衛生考量無法退換
- 試穿後：無法退換
- 換貨：可換顏色/尺寸，已拆封不接受；換款式須退貨後重新下單
- 退貨與換貨不能同時申請

【出貨時間】
- 現貨：1~3個工作天
- 預購A1：約14天；A2：約7天；B：以商品頁為準
- 超商/宅配：出貨後2~4工作天

【常見問題】
- 免運：折扣後滿899（外島除外）
- 黑名單：前筆未取貨被鎖，完成取貨過鑑賞期後自動解除
- 生日購物金：壽星當月1日自動發送
- 紅利金：訂單完成後自動發放
- 客服時間：週一~週五 09:00~12:00 / 13:00~17:00
- 萊卡M號適合褲子M~XL；L號適合XL~3L

【商品推薦 — 重要】
- 若 system prompt 內有【熱賣商品】清單，優先從中推薦
- 推薦格式：商品名稱 👉 連結（LINE 純文字，直接貼出完整網址）
- 例：ZERO-TEX 萊卡無縫內褲（低腰）👉 https://enamorshop.com/products/201-seml
- 嚴禁自行編造商品名稱或連結
- LINE 不支援 Markdown，禁止使用 [文字](連結) 格式，連結必須直接貼出完整網址

【導購策略 — 重要】
- 絕對不說「抱歉，沒有這個商品」或「資料中沒有」，改為積極轉介
- 客人說「塑身/收腹/顯瘦/修飾」→ 推高腰款（包覆下腹、修飾線條）
- 客人說「舒適/透氣/棉」→ 推莫代爾或棉質系列
- 客人說「涼感/夏天/冰涼」→ 推冰爽系列
- 客人說「無痕/貼身/外穿」→ 推無縫系列
- 找不到完全符合的商品時：從清單中選最接近的1~2款推薦，說明為何適合，語氣要有說服力
- 推薦時點出材質感受與穿著場景，讓客人有畫面感

【轉人工條件】回覆末尾加 ###NEED_HUMAN###：
- 訂單查詢、退換貨進度、商品瑕疵、客人持續不滿、說要找真人

【政策直接擋回，不需人工】
- 已拆封退貨、試穿後退貨、超過7天退貨

【對話結束偵測 — 重要】
- 客人說「謝謝/感謝/好的謝謝/沒問題/掰掰/再見/知道了/了解了/好的/OK/收到」等明確結束語時，在回覆末尾加 ###CLOSING###
- 只在對話明確結束時加，一般問答不加`;

// ── Sheet 快取（10分鐘）────────────────────────────────────────────────
let sheetCache = null;
let sheetCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000;

async function getSystemPrompt() {
  const now = Date.now();
  if (sheetCache && now - sheetCacheTime < CACHE_TTL) return sheetCache;
  try {
    const r = await fetch(SHEET_READER_URL);
    const res = await r.json();
    if (!res.success || !res.data) return SYSTEM_DEFAULT;
    const data = res.data;
    const parts = [];
    if (data['FAQ設定'] && data['FAQ設定'].length) {
      const lines = data['FAQ設定'].map(row => {
        const vals = Object.values(row).filter(v => v && v.toString().trim());
        return vals.join(' | ');
      }).filter(l => l.trim());
      if (lines.length) parts.push('【FAQ設定】\n' + lines.join('\n'));
    }
    if (data['客服FAQ'] && data['客服FAQ'].length) {
      const lines = data['客服FAQ'].map(row => {
        const vals = Object.values(row).filter(v => v && v.toString().trim());
        return vals.join(' | ');
      }).filter(l => l.trim());
      if (lines.length) parts.push('【客服FAQ】\n' + lines.join('\n'));
    }
    if (data['熱賣商品'] && data['熱賣商品'].length) {
      const prodLines = data['熱賣商品']
        .filter(row => row['是否顯示'] === true || row['是否顯示'] === 'TRUE')
        .map(row => {
          const name = row['商品名稱'] || '';
          const url = row['商品連結'] || '';
          const discount = row['折扣說明'] || '';
          const note = row['備註'] || '';
          return `${name} | ${url}${discount ? ' | ' + discount : ''}${note ? ' | ' + note : ''}`;
        }).filter(l => l.trim());
      if (prodLines.length) parts.push('【熱賣商品】（推薦時直接貼完整網址，LINE 不支援 Markdown）\n' + prodLines.join('\n'));
    }
    const prompt = parts.length > 0
      ? SYSTEM_DEFAULT + '\n\n=== Google Sheet 即時資料 ===\n' + parts.join('\n\n')
      : SYSTEM_DEFAULT;
    sheetCache = prompt;
    sheetCacheTime = now;
    return prompt;
  } catch (e) {
    console.error('Sheet fetch error:', e.message);
    return SYSTEM_DEFAULT;
  }
}

// ── Session 管理 ───────────────────────────────────────────────────────
const sessions = new Map();
const humanRequestSessions = new Map();
const closingPendingSessions = new Set(); // 已送出關懷語，等待確認是否真的結束
const ratingPendingSessions = new Set();  // 已送出評分邀請，等待評分中

function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, []);
  return sessions.get(userId);
}

// ── Claude API ─────────────────────────────────────────────────────────
async function callClaude(messages, systemPrompt) {
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
      system: systemPrompt,
      messages: messages.slice(-12)
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || '抱歉，我現在無法回覆，請稍後再試。';
}

// ── LINE 回覆 ──────────────────────────────────────────────────────────
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

// ── 案件寫入 Sheet ─────────────────────────────────────────────────────
async function notifySheet(userId, userMsg, botReply, type = 'human_handoff') {
  if (!SHEET_URL) return;
  await fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      source: 'LINE Bot',
      type,
      answers: JSON.stringify([{ q: '客人訊息', a: userMsg }]),
      summary: `LINE 用戶 ${userId}\n客人說：${userMsg}\nAI 回：${botReply}`
    })
  }).catch(() => {});
}

// ── 評分寫入 Sheet ─────────────────────────────────────────────────────
async function saveRating(userId, rating) {
  if (!SHEET_URL) return;
  await fetch(SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      source: 'LINE Bot',
      type: 'rating',
      answers: JSON.stringify([{ q: '滿意度評分', a: rating }]),
      summary: `LINE 用戶 ${userId} 評分：${rating}`
    })
  }).catch(() => {});
}

// ── 快捷選單 ───────────────────────────────────────────────────────────
const QUICK_MENU = `請輸入數字選擇服務：\n1️⃣ 尺寸建議\n2️⃣ 退換貨政策\n3️⃣ 免運說明\n4️⃣ 客服時間\n5️⃣ 訂單查詢`;

const QUICK_REPLIES = {
  '1': '尺寸建議：\n・萊卡系列 M號適合褲子 M～XL；L號適合 XL～3L\n・建議參考商品頁尺寸表，或告訴我您平時穿的尺寸，我幫您建議 😊',
  '2': '退換貨政策：\n・7天鑑賞期內未拆封可退\n・登入官網 > 會員中心 > 訂單查詢申請退貨\n・已拆封貼身衣物基於衛生考量無法退換\n・試穿後無法退換\n・換貨可換顏色/尺寸，已拆封不接受\n\n詳情：https://enamorshop.com/pages/return_policy',
  '3': '免運說明：\n・折扣後金額滿 NT$899 免運（外島除外）',
  '4': '客服時間：\n週一～週五 09:00–12:00 / 13:00–17:00\n\n非服務時間可留言，將於下個工作日回覆 💌',
  '5': '訂單查詢需人工協助，請提供手機號碼與訂單編號後四碼，客服將於工作時間回覆。###NEED_HUMAN###'
};

// ── 歡迎語 ─────────────────────────────────────────────────────────────
const WELCOME_MESSAGE = `EnamoR 恩娜茉兒，您好 🌸

我是 EnamoR AI 客服，很高興為您服務。
商品諮詢、尺寸建議或訂單問題，歡迎直接告訴我 💕

${QUICK_MENU}`;

// ── 評分訊息 ───────────────────────────────────────────────────────────
const RATING_MESSAGE = `很高興能幫到您 🌸
請為這次服務評分，您的回饋對我們的優化非常有幫助 🙏

1️⃣ 😞 不滿意
2️⃣ 😐 尚可
3️⃣ 🙂 算滿意
4️⃣ 😍 非常滿意

（直接輸入數字即可）`;

const RATING_MAP = {
  '1': '😞 不滿意',
  '2': '😐 尚可',
  '3': '🙂 算滿意',
  '4': '😍 非常滿意',
  '😞': '😞 不滿意',
  '😐': '😐 尚可',
  '🙂': '🙂 算滿意',
  '😍': '😍 非常滿意'
};


// ── 主 Handler ─────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('EnamoR LINE Bot OK');
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const signature = req.headers['x-line-signature'];
  const rawBody = JSON.stringify(req.body);
  const hmac = crypto.createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
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

    // ── 評分收集中 ────────────────────────────────────────────────────
    if (ratingPendingSessions.has(userId)) {
      const ratingLabel = RATING_MAP[userText];
      if (ratingLabel) {
        ratingPendingSessions.delete(userId);
        await saveRating(userId, ratingLabel);
        await replyToLine(replyToken, `感謝您的評分 💕\n期待下次再為您服務 🌸`);
      } else {
        // 不是評分表情，當作新對話繼續
        ratingPendingSessions.delete(userId);
        messages.push({ role: 'user', content: userText });
        const systemPrompt = await getSystemPrompt();
        let reply = await callClaude(messages, systemPrompt);
        reply = reply.replace('###CLOSING###', '').replace('###NEED_HUMAN###', '').trim();
        messages.push({ role: 'assistant', content: reply });
        await replyToLine(replyToken, reply);
      }
      continue;
    }

    // ── 結束關懷後，等待確認是否真的結束 ─────────────────────────────
    if (closingPendingSessions.has(userId)) {
      closingPendingSessions.delete(userId);
      const endingWords = ['沒了', '不用', '不用了', '沒有', '沒其他', '謝謝', '感謝', '好', 'OK', 'ok', '掰', '再見', '拜拜'];
      const isReallyDone = endingWords.some(w => userText.includes(w));
      if (isReallyDone) {
        ratingPendingSessions.add(userId);
        await replyToLine(replyToken, RATING_MESSAGE);
      } else {
        // 客人還有問題，繼續正常對話
        messages.push({ role: 'user', content: userText });
        const systemPrompt = await getSystemPrompt();
        let reply = await callClaude(messages, systemPrompt);
        const isClosing = reply.includes('###CLOSING###');
        reply = reply.replace('###CLOSING###', '').replace('###NEED_HUMAN###', '').trim();
        messages.push({ role: 'assistant', content: reply });
        if (isClosing) {
          reply += '\n\n請問還有什麼需要協助的地方嗎？😊';
          closingPendingSessions.add(userId);
        }
        await replyToLine(replyToken, reply);
      }
      continue;
    }

    // ── 真人客服流程：等待問題類型 ────────────────────────────────────
    if (humanRequestSessions.has(userId)) {
      const typeMap = { '1': '🔄 退換貨', '2': '📦 商品問題', '3': '📋 訂單問題', '4': '❓ 其他' };
      const caseType = typeMap[userText];
      if (caseType) {
        humanRequestSessions.delete(userId);
        const history = messages.slice(-6)
          .filter(m => m.role === 'user' && m.content !== '__init__')
          .map(m => m.content).join('\n');
        await notifySheet(userId, '真人客服請求', `類型：${caseType}\n\n近期對話：\n${history}`);
        await replyToLine(replyToken,
          `已收到您的請求 🙏\n問題類型：${caseType}\n\n客服將於工作時間（週一～週五 9:00–17:00）與您聯繫，請稍候。`
        );
      } else {
        await replyToLine(replyToken, '請輸入數字選擇問題類型：\n1. 退換貨\n2. 商品問題\n3. 訂單問題\n4. 其他');
      }
      continue;
    }

    // ── 主動要求真人 ──────────────────────────────────────────────────
    if (['真人', '人工', '真人客服'].includes(userText)) {
      humanRequestSessions.set(userId, true);
      await replyToLine(replyToken, '好的，請問是哪類問題？\n1. 退換貨\n2. 商品問題\n3. 訂單問題\n4. 其他');
      continue;
    }

    // ── 選單 ──────────────────────────────────────────────────────────
    if (userText === '0' || userText.toLowerCase() === 'menu' || userText === '選單') {
      await replyToLine(replyToken, QUICK_MENU);
      continue;
    }

    // ── 數字快捷 ──────────────────────────────────────────────────────
    if (QUICK_REPLIES[userText]) {
      let quickReply = QUICK_REPLIES[userText];
      const needHuman = quickReply.includes('###NEED_HUMAN###');
      quickReply = quickReply.replace('###NEED_HUMAN###', '').trim();
      if (needHuman) await notifySheet(userId, userText, quickReply);
      await replyToLine(replyToken, quickReply);
      continue;
    }

    // ── 第一則訊息：歡迎語 ────────────────────────────────────────────
    if (messages.length === 0) {
      messages.push({ role: 'user', content: '__init__' });
      await replyToLine(replyToken, WELCOME_MESSAGE);
      continue;
    }

    // ── AI 回覆 ───────────────────────────────────────────────────────
    messages.push({ role: 'user', content: userText });

    try {
      const systemPrompt = await getSystemPrompt();
      let reply = await callClaude(messages, systemPrompt);

      const needHuman = reply.includes('###NEED_HUMAN###');
      const isClosing = reply.includes('###CLOSING###');
      reply = reply.replace('###NEED_HUMAN###', '').replace('###CLOSING###', '').trim();

      if (needHuman) {
        reply += '\n\n已通知客服，將於工作時間（週一～週五 9:00–17:00）回覆您。';
        await notifySheet(userId, userText, reply);
      }

      messages.push({ role: 'assistant', content: reply });
      if (messages.length > 20) messages.splice(0, 4);

      // 第3則 AI 對話後附上轉真人提示
      const aiCount = messages.filter(m => m.role === 'assistant').length;
      if (aiCount === 3) {
        reply += '\n\n────\n如需真人客服，請輸入「真人」';
      }

      // 偵測到結束語 → 加關懷句並進入等待狀態
      if (isClosing) {
        reply += '\n\n請問還有什麼需要協助的地方嗎？😊';
        closingPendingSessions.add(userId);
      }

      await replyToLine(replyToken, reply);
    } catch (e) {
      console.error('handler error:', e);
      try {
        await replyToLine(replyToken, '抱歉，系統暫時無法回覆，請稍後再試。');
      } catch {}
    }
  }

  return res.status(200).send('OK');
};
