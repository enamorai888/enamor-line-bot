// api/submit-transfer.js
// 接收表單 → 寫入 Google Sheet（會員搬移申請）

const SHEET_URL = process.env.TRANSFER_SHEET_URL; // Apps Script webhook URL

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { old_phone, new_email, name, note } = req.body || {};

  if (!old_phone || !new_email) {
    return res.status(400).json({ ok: false, error: '缺少必填欄位' });
  }

  try {
    const payload = {
      timestamp: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
      old_phone,
      new_email,
      name: name || '',
      note: note || '',
      status: '待處理'
    };

    const sheetRes = await fetch(SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!sheetRes.ok) throw new Error('Sheet write failed');

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('submit-transfer error:', e);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
}
