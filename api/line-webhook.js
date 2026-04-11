const crypto = require('crypto');

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const SHEET_URL = process.env.SHEET_URL || '';
const SHEET_READER_URL = 'https://enamor-line-bot.vercel.app/api/sheet-reader';

// ── System Prompt ──────────────────────────────────────────────────────
const SYSTEM_DEFAULT = `你是 EnamoR 的專屬顧問，台灣女性內著精品品牌。以優雅、簡潔、有溫度的繁體中文回覆，語氣像精品門市的資深顧問，不超過 150 字。

【核心語氣原則】
- 不說「當然！」「絕對！」「作為AI」「非常感謝您的來訊」「您好，我為您整理」
- 不過度道歉，直接切入重點
- 推薦商品時要有說服力，點出材質與穿著感受
- 句子精煉，避免重複用語
- 起頭不要「您好！」，直接給資訊或帶一句有溫度的開場
- 結尾帶一個輕引導（例如：「有其他問題歡迎繼續詢問」），不要硬收
- LINE 不支援 Markdown，禁止使用 [文字](連結) 格式，連結必須直接貼出完整網址

【回覆語氣風格 — 非常重要】
你說話的方式要像一個熟悉品牌、真心想幫客人的顧問朋友，不是在唸條款。
帶「喔」「呢」「哦」等自然口語語尾，偶爾給貼心小提醒，結尾可以輕輕反問引導。
不要條列清單式回答，用流暢的對話口吻說明。

【回覆範例 — 請照這個語氣回答】

Q：請問免運費是多少？
A：只要結帳時扣除折扣後的實際金額達到 NT$899，宅配和超商取貨都可以免運喔！要特別注意的是，免運門檻是以折扣後的金額為準，外島或海外地區的話就不在範圍內了。有其他問題歡迎繼續問我 😊

Q：我想要退貨
A：沒問題，我來幫您說明一下退貨流程喔！請先登入官網，到「會員中心」點選「訂單紀錄」，找到那筆訂單後就可以申請退貨，系統會提供 7-11 退貨便代號，3天內到 IBON 操作就完成了。詳細步驟可以參考這裡：https://enamorshop.com/pages/return_policy 需要我幫您確認其他細節嗎？

Q：什麼時候可以收到？
A：這要看您購買的商品是否有預購款式喔！如果全部都是現貨，我們會在 1~3 個工作天內出貨，出貨後超商或宅配大約再 2~4 天就能收到。如果訂單裡有預購商品，需要等全部商品到齊後才會一起寄出。想確認您的訂單狀況，可以告訴我商品名稱，我幫您判斷看看 😊

Q：可以推薦我塑身褲嗎？
A：沒問題，我很樂意幫您推薦！挑塑身褲最重要的是穿得住，才能有修飾效果。如果是第一次嘗試、或希望找彈性好又不壓迫的款式，非常推薦我們的「萊卡抗菌無縫系列」，材質彈性很好、穿起來很服貼。尺寸的話，平常穿 M~XL 選 M 號，XL~3L 選 L 號。不知道您比較在意修飾腹部還是大腿呢？告訴我，我可以幫您推薦更適合的款式！

Q：我換貨可以換尺寸嗎？
A：可以的喔！未拆封的商品都可以申請換貨，換顏色或換尺寸都沒問題。不過如果已經拆封，因為是貼身衣物，基於衛生考量就沒辦法受理換貨了，這點要請您先確認一下喔。需要申請的話，一樣到官網「會員中心 > 訂單紀錄」辦理 😊

【退換貨政策】
- 7天鑑賞期內未拆封可退：官網 > 會員中心 > 訂單查詢申請，取得7-11退貨便代號，3天內至IBON操作
- 已拆封：貼身衣物基於衛生考量無法退換
- 試穿後：無法退換
- 換貨：可換顏色/尺寸，已拆封不接受；換款式須退貨後重新下單
- 退貨與換貨不能同時申請

【出貨時間】
- 現貨：1~3個工作天
- 預購類型說明：
  A1「生產製程中」：約14個工作天
  A2「長銷熱賣補貨」：約7個工作天
- 萊卡（Lycra）抗菌無縫系列：預購類型為 A1，約 14 個工作天
  B「流行性商品」：以商品頁標示時間為準
- 若客人問特定商品是哪個類型，回答「我可以協助您判斷，請告訴我商品名稱」
- 超商/宅配：出貨後2~4工作天

【常見問題】
- 免運：折扣後滿899（外島除外）
- 黑名單：前筆未取貨被鎖，完成取貨過鑑賞期後自動解除
- 生日購物金：壽星當月1日自動發送
- 紅利金：訂單完成後自動發放
- 客服時間：週一~週五 09:00~12:00 / 13:00~17:00
- 萊卡M號適合褲子M~XL；L號適合XL~3L
- 團購方案：主揪滿額可選加贈點數或當期滿額禮，詳情：https://enamorshop.com/pages/group-buy

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

【轉人工條件】回覆末尾加 ###NEED_HUMAN###，只限以下情況：
- 客人要查真實訂單狀態、物流進度（需要後台資料）
- 退換貨已申請但遇到問題、要追蹤進度
- 商品有實體瑕疵需要回報
- 客人明確說「找真人」「找客服」「投訴」
- 客人持續重複表達不滿，AI 無法解決

【不需要轉人工，AI 自己回答】
- 退換貨流程說明、退貨方式、換貨規定
- 取消訂單流程說明
- 出貨時間、預購說明
- 免運條件、折扣說明
- 商品推薦、尺寸建議
- 任何政策說明類問題

【模糊問句處理 — 重要】
- 問句不清楚或資訊不足時，先簡短反問確認，不要自行推斷
- 例如客人說「哪邊取編號」→ 先問「請問您想查的是哪一種編號呢？例如訂單編號、退貨編號？」
- 不要猜測客人意圖然後直接回答，猜錯比不答更傷
- 反問要簡短、溫和，一次只問一個問題

【政策直接擋回，不需人工】
- 已拆封退貨、試穿後退貨、超過7天退貨

【對話結束偵測 — 重要】
- 客人說「謝謝/感謝/好的謝謝/沒問題/掰掰/再見/知道了/了解了/好的/OK/收到」等明確結束語時，在回覆末尾加 ###CLOSING###
- 只在對話明確結束時加，一般問答不加

【情緒偵測 — 重要】
- 偵測到客人有負面情緒（說「不爽/生氣/很差/失望/爛/差評/投訴/太差了/不可以/怎麼這樣/什麼態度/太誇張/受不了」等）時：
  1. 回覆開頭說「您好，我是 EnamoR 的專屬顧問！感覺您有點不開心 🙏」
  2. 接著溫柔詢問具體問題，語氣誠懇不過度道歉
  3. 在回覆末尾加 ###EMOTION###
- 只在情緒明顯時觸發，一般抱怨不加`;

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
const contactSessions = new Map();
const ratingSessionUsers = new Set();
const closingPendingSessions = new Set();
const ratingPendingSessions = new Set();

function getSession(userId) {
  if (!sessions.has(userId)) sessions.set(userId, []);
  return sessions.get(userId);
}

// ── Shopify 商品即時查詢 ──────────────────────────────────────────────
const PRODUCTS_URL = 'https://enamor-line-bot.vercel.app/api/shopify-products';

async function fetchShopifyProducts(keyword) {
  try {
    const r = await fetch(PRODUCTS_URL + '?query=' + encodeURIComponent(keyword), {
      signal: AbortSignal.timeout(5000)
    });
    const data = await r.json();
    return data.products || [];
  } catch (e) {
    console.error('fetchShopifyProducts error:', e.message);
    return [];
  }
}

function buildProductContext(products) {
  if (!products || !products.length) return '';
  const lines = products.slice(0, 5).map(p => {
    const preorder = p.preorder_type ? '｜預購：' + p.preorder_type : '｜現貨';
    const sizes = p.size_options ? '｜尺寸：' + p.size_options : '';
    const stretch = p.stretch_score ? '｜彈力：' + p.stretch_score + '/5' : '';
    return '- ' + p.title + '｜NT$' + p.price + '｜' + p.url + preorder + sizes + stretch;
  });
  return '\n\n【目前相關商品，請優先推薦並直接附上完整網址，LINE 不支援 Markdown】\n' + lines.join('\n');
}

function isProductQuery(text) {
  const keywords = ['推薦', '商品', '內褲', '內衣', '睡衣', '背心', '褲', '衣', '款式', '材質', '尺寸', '彈性', '涼感', '無痕', '塑身', '高腰', '中腰', '低腰', '莫代爾', '萊卡', '想買', '有沒有', '哪款'];
  return keywords.some(k => text.includes(k));
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
const QUICK_MENU = `請輸入數字選擇服務：\n1. 商品推薦\n2. 尺寸建議\n3. 免運說明\n4. 客服時間\n5. 退換貨相關\n6. 配送相關\n7. 取消訂單\n8. 團購優惠\n9. 好友推薦\n10. 舊站會員遷移\n11. 訂單查詢\n12. 其他（請文字簡述）`;

const QUICK_REPLIES = {
  '1': '__AI__',
  '2': '尺寸選對了穿起來才舒服！萊卡系列的話，平時褲子穿 M～XL 建議選 M 號，XL～3L 就選 L 號喔。每個人的身形不太一樣，如果您告訴我平時穿的尺寸，我可以幫您更精準地建議 😊',
  '3': '只要結帳時折扣後的實際金額滿 NT$899，宅配和超商取貨都可以免運喔！要注意的是免運是以折扣後的金額為準，外島地區的話不在範圍內。有其他問題歡迎繼續問我 😊',
  '4': '我們的客服服務時間是週一至週五 09:00–12:00 / 13:00–17:00 喔！如果在非服務時間留言也沒關係，我們會在下個工作日盡快回覆您 💌',
  '5': '我來幫您說明退換貨流程喔！7天鑑賞期內未拆封的商品可以申請退貨，登入官網 > 會員中心 > 訂單查詢申請，系統會提供 7-11 退貨便代號，3天內到 IBON 操作就完成了。\n\n需要注意的是，已拆封的貼身衣物基於衛生考量無法退換，試穿過後也是同樣的規定喔，購買前請您先確認一下。\n\n詳細說明可以參考這裡：https://enamorshop.com/pages/return_policy 有其他問題歡迎繼續問我 😊',
  '6': '現貨商品我們會在 1~3 個工作天內出貨，出貨後超商或宅配大約再 2~4 天就能收到喔！如果訂單裡有預購商品，需要等全部商品備齊後才會一起寄出。萊卡抗菌無縫系列預購約 14 天，其他預購款約 7 天。想確認特定商品的狀態，告訴我商品名稱我幫您查 😊',
  '7': '下單後 12 小時內可自助取消訂單，點此連結操作：\nhttps://enamor-line-bot.vercel.app/cancel.html\n\n超過 12 小時或遇到問題，請輸入「真人」由客服協助。',
  '8': 'EnamoR 提供團購主揪專屬優惠，訂單滿額可選擇加贈點數或當期滿額禮。\n\n詳情請見：https://enamorshop.com/pages/group-buy\n\n有其他問題歡迎繼續詢問 😊',
  '9': '好友推薦活動說明即將上線，敬請期待！如有相關問題歡迎直接詢問。',
  '10': '如需申請舊站會員點數遷移，請點以下連結填寫資料，我們將在 3–5 個工作天內完成，完成後寄信通知您 😊\n\nhttps://enamor-line-bot.vercel.app/transfer.html',
  '11': '訂單查詢需人工協助，請提供手機號碼與訂單編號後四碼，客服將於工作時間回覆您。###NEED_HUMAN###',
  '12': '__AI__'
};

// ── 歡迎語 ─────────────────────────────────────────────────────────────
const WELCOME_MESSAGE = `您好！我是 EnamoR AI 客服，很高興為您服務。\n商品諮詢、尺寸建議或訂單問題，歡迎直接告訴我。\n\n${QUICK_MENU}`;

// ── 評分訊息 ───────────────────────────────────────────────────────────
const RATING_MESSAGE = `很高興能為您服務\n請為這次服務評分，您的回饋對我們的優化非常有幫助\n\n1. 😞 不滿意\n2. 😐 尚可\n3. 🙂 算滿意\n4. 😍 非常滿意\n\n（直接輸入數字即可）`;

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

    // ── 評分回覆處理（轉人工後觸發）────────────────────────────────
    if (ratingSessionUsers.has(userId)) {
      const ratingMap = { '1': '😞 不滿意', '2': '😐 尚可', '3': '🙂 算滿意', '4': '😍 非常滿意' };
      if (ratingMap[userText]) {
        ratingSessionUsers.delete(userId);
        await saveRating(userId, ratingMap[userText]);
        await replyToLine(replyToken, '感謝您的回饋 💕');
      } else {
        await replyToLine(replyToken, '請輸入 1～4 的數字進行評分 🙏');
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
        contactSessions.set(userId, { caseType, history, step: 'phone', phone: '' });
        await replyToLine(replyToken, '請輸入您的訂單手機號碼');
      } else {
        await replyToLine(replyToken, '請輸入數字選擇問題類型：\n1. 退換貨\n2. 商品問題\n3. 訂單問題\n4. 其他');
      }
      continue;
    }

    // ── 聯絡資訊收集流程 ─────────────────────────────────────────────
    if (contactSessions.has(userId)) {
      const cs = contactSessions.get(userId);
      if (cs.step === 'phone') {
        cs.phone = userText;
        cs.step = 'name';
        await replyToLine(replyToken, '謝謝！請輸入您的 LINE 顯示名稱');
      } else if (cs.step === 'name') {
        const lineName = userText;
        contactSessions.delete(userId);
        await notifySheet(userId, '真人客服請求',
          `類型：${cs.caseType}\n手機：${cs.phone}\nLINE名稱：${lineName}\n\n近期對話：\n${cs.history}`,
          'human_handoff'
        );
        await replyToLine(replyToken, `已收到您的請求\n類型：${cs.caseType}\n手機：${cs.phone}\nLINE：${lineName}\n\n人工客服將於工作時間（週一～週五 9:00–17:00）與您聯繫，請耐心等候。\n如為非服務時間，工作日會盡快回覆您。\n客服信箱：service@enamor.com.tw`);
        ratingSessionUsers.add(userId);
        await replyToLine(replyToken, `很高興能為您服務\n請為這次服務評分，您的回饋對我們的優化非常有幫助\n\n1. 😞 不滿意\n2. 😐 尚可\n3. 🙂 算滿意\n4. 😍 非常滿意\n\n（直接輸入數字即可）`);
      }
      continue;
    }

    // ── 取消訂單關鍵字 ────────────────────────────────────────────────
    const CANCEL_TRIGGERS = ['取消訂單', '取消', '不想要了', '想取消', '取消單'];
    if (CANCEL_TRIGGERS.some(w => userText.includes(w))) {
      await replyToLine(replyToken, '下單後 12 小時內可自助取消訂單，點此連結操作：\nhttps://enamor-line-bot.vercel.app/cancel.html\n\n超過 12 小時或遇到問題，請輸入「真人」由客服協助。');
      continue;
    }

    // ── 主動要求真人 ──────────────────────────────────────────────────
    const HUMAN_TRIGGERS = ['真人', '人工', '真人客服', '客服', '克服', '找人', '找客服'];
    if (HUMAN_TRIGGERS.some(w => userText === w || userText.startsWith(w))) {
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
      if (quickReply === '__AI__') {
        const initMsg = userText === '1' ? '請問您想找哪類商品？例如：塑身、涼感、無痕、莫代爾……告訴我需求我來推薦。' : '請問您想詢問什麼？直接告訴我，我來協助您。';
        messages.push({ role: 'user', content: initMsg });
        await replyToLine(replyToken, initMsg);
        continue;
      }
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

      let msgsToSend = messages.slice(-12);
      if (isProductQuery(userText)) {
        const products = await fetchShopifyProducts(userText);
        const productCtx = buildProductContext(products);
        if (productCtx) {
          msgsToSend = [...msgsToSend];
          const last = msgsToSend[msgsToSend.length - 1];
          msgsToSend[msgsToSend.length - 1] = {
            ...last,
            content: last.content + productCtx
          };
        }
      }

      let reply = await callClaude(msgsToSend, systemPrompt);

      const needHuman = reply.includes('###NEED_HUMAN###');
      const isClosing = reply.includes('###CLOSING###');
      const hasEmotion = reply.includes('###EMOTION###');
      reply = reply.replace('###NEED_HUMAN###', '').replace('###CLOSING###', '').replace('###EMOTION###', '').trim();

      if (needHuman) {
        reply += '\n\n已通知客服，將於工作時間（週一～週五 9:00–17:00）回覆您。';
        await notifySheet(userId, userText, reply);
      }

      messages.push({ role: 'assistant', content: reply });
      if (messages.length > 20) messages.splice(0, 4);

      if (hasEmotion) {
        reply += '\n\n────\n如需真人客服協助，請輸入「真人」';
      }

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
