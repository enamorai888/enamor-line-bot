// api/send-otp.js
import nodemailer from 'nodemailer';

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
  const expires = Date.now() + 10 * 60 * 1000;
  otpStore.set(email.toLowerCase(), { otp, expires });

  try {
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
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to send email' });
  }
}

export { otpStore };
