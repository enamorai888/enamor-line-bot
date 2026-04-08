// api/send-otp.js
const otpStore = new Map();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Date.now() + 10 * 60 * 1000; // 10分鐘有效
  otpStore.set(email.toLowerCase(), { otp, expires });

  try {
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'EnamoR <service@enamorshop.com>',
        to: email,
        subject: '【EnamoR】取消訂單驗證碼',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
            <p style="font-size:13px;color:#888;letter-spacing:0.1em">ENAMOR 恩娜茉兒</p>
            <h2 style="font-size:20px;font-weight:400;margin:16px 0 8px">取消訂單驗證碼</h2>
            <p style="font-size:14px;color:#555;line-height:1.7">您的驗證碼為：</p>
            <div style="font-size:36px;font-weight:500;letter-spacing:0.2em;margin:24px 0;color:#1a1814">${otp}</div>
            <p style="font-size:13px;color:#888;line-height:1.7">驗證碼 10 分鐘內有效。<br>若非本人操作，請忽略此信。</p>
            <hr style="border:none;border-top:1px solid #eee;margin:32px 0">
            <p style="font-size:11px;color:#aaa">© EnamoR 恩娜茉兒</p>
          </div>
        `
      })
    });

    if (!sendRes.ok) {
      const err = await sendRes.json();
      console.error('Resend error:', err);
      throw new Error('Email send failed');
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to send email' });
  }
}

export { otpStore };
