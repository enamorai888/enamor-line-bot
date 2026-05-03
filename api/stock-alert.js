// api/stock-alert.js
// EnamoR 缺貨提醒 — 每天中午 12 點寄 email
// 部署位置：enamorai888/enamor-line-bot repo
// Vercel Cron: 每天 UTC 04:00（= TST 12:00）

const nodemailer = require('nodemailer');

// ── 常數 ──
const OMS_PROXY = 'https://enamor-oms.vercel.app/api/oms-proxy';
const OMS_TOKEN = '28447208';
const SHEET_ID = '1jYnzBWyvF23asaPFjqYaEl5LXOg77inIaJlCMkzdOS8';
const SHEET_KEY = 'AIzaSyCrFGNy_-YgRWsrOw0H_tfTqeCbnIkVZA8';
const SALES_DAYS = 30;
const ALERT_DAYS = 3; // 可用天數 ≤ 3 天就警示
const DEFAULT_LEAD = 7;
const DEFAULT_SAFETY = 7;

// ── OMS Proxy 呼叫 ──
async function omsCall(endpoint, body) {
  const res = await fetch(OMS_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proxy-token': OMS_TOKEN },
    body: JSON.stringify({ endpoint, body })
  });
  if (!res.ok) throw new Error(`OMS ${endpoint} → ${res.status}`);
  return res.json();
}

// ── 載入供應商對照表 ──
async function loadSupplierMap() {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A:Q?key=${SHEET_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Sheet → ${res.status}`);
  const { values: rows } = await res.json();
  if (!rows || rows.length < 2) throw new Error('Sheet 空');

  const h = rows[0];
  const ci = (n) => h.indexOf(n);
  const iBC = ci('商品條碼'), iVID = ci('廠商編號'), iVN = ci('廠商名稱');
  const iVS = ci('廠商貨號'), iVSZ = ci('尺寸說明'), iVC = ci('廠商顏色說明');
  const iACT = ci('Shopify啟用'), iNM = ci('商品名稱');

  const map = {};
  rows.slice(1).forEach(r => {
    const bc = (r[iBC] || '').trim();
    const active = (r[iACT] || '').trim();
    if (bc && active === 'V' && !map[bc]) {
      map[bc] = {
        vid: (r[iVID] || '').trim(),
        vn: (r[iVN] || '').trim(),
        vs: (r[iVS] || '').trim(),
        vsz: (r[iVSZ] || '').trim(),
        vc: (r[iVC] || '').trim(),
        nm: iNM >= 0 ? (r[iNM] || '').trim() : ''
      };
    }
  });
  return map;
}

// ── 主邏輯 ──
async function getAlertItems() {
  // 1. 供應商對照表
  const supMap = await loadSupplierMap();

  // 2. 庫存
  const stockRes = await omsCall(
    '/api/v2/default/getStocksData/searchList',
    { 'view_products_stock.stock_group': '10' }
  );
  const stockData = stockRes.retval || [];

  // 3. 30 天銷量
  const dd = new Date();
  dd.setDate(dd.getDate() - SALES_DAYS);
  const ds = dd.toISOString().slice(0, 10);
  const orderRes = await omsCall(
    '/api/v2/default/apiOrderList/searchDetail',
    { 'orders.created_at@start': ['>=', ds] }
  );
  const rv = orderRes.retval || {};
  const orderItems = rv['訂單明細'] || [];
  const orderBase = rv['基本資料'] || [];

  // orderId → date
  const odMap = {};
  orderBase.forEach(o => {
    const oid = (o['orders.orders_id'] || '').trim();
    const dt = (o['orders.created_at'] || '').slice(0, 10);
    if (oid && dt) odMap[oid] = dt;
  });

  // SKU 銷量 + 日期區間
  const skuSales = {};
  const skuDates = {};
  orderItems.forEach(i => {
    const m = (i['orders_products.products_model'] || '').trim();
    const q = parseInt(i['orders_products.products_quantity'] || 0);
    const oid = (i['orders_products.orders_id'] || '').trim();
    if (!m || q <= 0) return;
    skuSales[m] = (skuSales[m] || 0) + q;
    const dt = odMap[oid];
    if (dt) {
      if (!skuDates[m]) skuDates[m] = { first: dt, last: dt };
      if (dt < skuDates[m].first) skuDates[m].first = dt;
      if (dt > skuDates[m].last) skuDates[m].last = dt;
    }
  });

  // 4. 採購中
  const poRes = await omsCall(
    '/api/v2/default/apiPurchaseHeaderList/searchDetail',
    { 'purchase_header.status': '60' }
  );
  const poData = (poRes.retval || {}).purchase || [];
  const pendPO = {};
  if (Array.isArray(poData)) {
    poData.forEach(p => {
      const m = (p['purchase.products_model'] || '').trim();
      const pq = parseInt(p['purchase.purchase_quantity'] || 0);
      const sq = parseInt(p['purchase.stock_quantity'] || 0);
      const rem = pq - sq;
      if (m && rem > 0) pendPO[m] = (pendPO[m] || 0) + rem;
    });
  }

  // 5. 合併計算
  const skuStock = {};
  stockData.forEach(s => {
    const m = (s['view_products_stock.products_model'] || '').trim();
    const q = parseInt(s['view_products_stock.stock_qty'] || 0);
    const n = (s['view_products_stock.products_name'] || '').trim();
    if (!m) return;
    if (!skuStock[m]) skuStock[m] = { stk: 0, nm: n };
    skuStock[m].stk += q;
  });

  const today = new Date().toISOString().slice(0, 10);
  const alerts = [];

  Object.entries(skuStock).forEach(([bc, inf]) => {
    const sp = supMap[bc];
    if (!sp) return; // 不在 Shopify = 跳過

    const sold = skuSales[bc] || 0;
    const po = pendPO[bc] || 0;
    const ld = DEFAULT_LEAD;
    const sf = DEFAULT_SAFETY;

    // 斷貨修正（跟 Purchase-oms.html 同邏輯）
    let effDays = SALES_DAYS;
    let isStockout = false;
    const dates = skuDates[bc];
    if (inf.stk === 0 && sold > 0 && dates) {
      const daysSinceLast = Math.round(
        (new Date(today).getTime() - new Date(dates.last).getTime()) / 86400000
      );
      if (daysSinceLast > 7) {
        const span = Math.round(
          (new Date(dates.last).getTime() - new Date(dates.first).getTime()) / 86400000
        ) + 1;
        effDays = Math.max(1, span);
        isStockout = true;
      }
    }

    const da = sold / effDays;
    const rop = Math.ceil(da * (ld + sf));
    const eff = inf.stk + po;
    const rawSug = Math.max(0, rop - eff);
    const sug = rawSug > 0 ? Math.ceil(rawSug / 10) * 10 : 0;
    const dl = da > 0 ? Math.floor(inf.stk / da) : 999;

    if (dl <= ALERT_DAYS) {
      alerts.push({
        bc,
        nm: sp.nm || inf.nm || '',
        vid: sp.vid,
        vn: sp.vn,
        vs: sp.vs,
        vc: sp.vc,
        vsz: sp.vsz,
        stk: inf.stk,
        po,
        da: Math.round(da * 10) / 10,
        dl,
        sug,
        isStockout
      });
    }
  });

  // 按可用天數排序（最急的在前）
  alerts.sort((a, b) => a.dl - b.dl);
  return alerts;
}

// ── 產 Email HTML ──
function buildEmailHTML(alerts) {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

  if (alerts.length === 0) {
    return `
      <div style="font-family:'Noto Sans TC',sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="font-size:16px;color:#2d7a3a">✓ 庫存充足</h2>
        <p style="color:#888;font-size:13px">截至 ${now}，所有 SKU 可用天數 > ${ALERT_DAYS} 天。</p>
      </div>`;
  }

  // 按供應商分組
  const byVendor = {};
  alerts.forEach(a => {
    if (!byVendor[a.vid]) byVendor[a.vid] = { vn: a.vn, items: [] };
    byVendor[a.vid].items.push(a);
  });

  let vendorHTML = '';
  Object.entries(byVendor)
    .sort((a, b) => a[1].items[0].dl - b[1].items[0].dl)
    .forEach(([vid, { vn, items }]) => {
      const totalSug = items.reduce((s, i) => s + i.sug, 0);
      let rows = '';
      items.forEach(i => {
        const dlColor = i.dl === 0 ? '#c0392b' : i.dl <= 1 ? '#e67e22' : '#888';
        const dlText = i.stk === 0 ? '已斷貨' : `${i.dl}天`;
        const soTag = i.isStockout ? ' <span style="font-size:10px;background:#e67e22;color:#fff;padding:1px 4px;border-radius:2px">斷貨修正</span>' : '';
        rows += `
          <tr>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;color:#888;font-family:monospace">${i.vs || i.bc}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${i.vc}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px">${i.vsz}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i.nm || '—'}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;font-weight:700;text-align:right;font-family:monospace">${i.stk}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;text-align:right;color:${i.po ? '#e67e22' : '#ccc'};font-family:monospace">${i.po || '—'}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;text-align:right;font-family:monospace">${i.da}${soTag}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;font-weight:700;text-align:right;color:${dlColor};font-family:monospace">${dlText}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:14px;font-weight:700;text-align:right;color:#c0392b;font-family:monospace">${i.sug > 0 ? i.sug : '—'}</td>
          </tr>`;
      });

      vendorHTML += `
        <div style="margin-bottom:20px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-family:monospace;font-size:12px;background:#f3f3f0;padding:3px 8px;border-radius:4px;font-weight:600">${vid}</span>
            <span style="font-size:13px;font-weight:600">${vn}</span>
            <span style="font-size:11px;color:#c0392b;font-weight:600">⚠ ${items.length} 項</span>
            ${totalSug > 0 ? `<span style="font-size:11px;color:#888;margin-left:auto">建議 ${totalSug} 件</span>` : ''}
          </div>
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:#f9f9f7">
                <th style="padding:5px 8px;text-align:left;font-size:10px;color:#888;font-weight:600;text-transform:uppercase;font-family:monospace">貨號</th>
                <th style="padding:5px 8px;text-align:left;font-size:10px;color:#888;font-weight:600">顏色</th>
                <th style="padding:5px 8px;text-align:left;font-size:10px;color:#888;font-weight:600">尺寸</th>
                <th style="padding:5px 8px;text-align:left;font-size:10px;color:#888;font-weight:600">品名</th>
                <th style="padding:5px 8px;text-align:right;font-size:10px;color:#888;font-weight:600">庫存</th>
                <th style="padding:5px 8px;text-align:right;font-size:10px;color:#888;font-weight:600">採購中</th>
                <th style="padding:5px 8px;text-align:right;font-size:10px;color:#888;font-weight:600">日均</th>
                <th style="padding:5px 8px;text-align:right;font-size:10px;color:#888;font-weight:600">可用</th>
                <th style="padding:5px 8px;text-align:right;font-size:10px;color:#888;font-weight:600;color:#c0392b">建議</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    });

  const zeroCount = alerts.filter(a => a.stk === 0).length;
  const criticalCount = alerts.filter(a => a.dl <= 1 && a.stk > 0).length;

  return `
    <div style="font-family:'Noto Sans TC','Helvetica Neue',sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#1a1a1a">
      <div style="border-bottom:1px solid #eee;padding-bottom:12px;margin-bottom:16px">
        <h1 style="font-size:16px;font-weight:600;margin:0">⚠ EnamoR 缺貨提醒</h1>
        <p style="font-size:12px;color:#888;margin:4px 0 0;font-family:monospace">${now}</p>
      </div>

      <div style="display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap">
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 16px;min-width:100px">
          <div style="font-size:10px;color:#888;text-transform:uppercase;font-family:monospace;letter-spacing:.5px">警示 SKU</div>
          <div style="font-size:22px;font-weight:700;color:#c0392b;font-family:monospace">${alerts.length}</div>
          <div style="font-size:11px;color:#888">可用 ≤ ${ALERT_DAYS} 天</div>
        </div>
        ${zeroCount > 0 ? `
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:10px 16px;min-width:100px">
          <div style="font-size:10px;color:#888;text-transform:uppercase;font-family:monospace;letter-spacing:.5px">已斷貨</div>
          <div style="font-size:22px;font-weight:700;color:#c0392b;font-family:monospace">${zeroCount}</div>
          <div style="font-size:11px;color:#888">庫存 = 0</div>
        </div>` : ''}
        ${criticalCount > 0 ? `
        <div style="background:#fff8f0;border:1px solid #fed7aa;border-radius:6px;padding:10px 16px;min-width:100px">
          <div style="font-size:10px;color:#888;text-transform:uppercase;font-family:monospace;letter-spacing:.5px">明天斷</div>
          <div style="font-size:22px;font-weight:700;color:#e67e22;font-family:monospace">${criticalCount}</div>
          <div style="font-size:11px;color:#888">可用 ≤ 1 天</div>
        </div>` : ''}
      </div>

      ${vendorHTML}

      <div style="border-top:1px solid #eee;padding-top:12px;margin-top:8px">
        <p style="font-size:11px;color:#bbb;margin:0">
          採購平台：<a href="https://enamor-line-bot.vercel.app/Purchase-oms.html" style="color:#888">Purchase-oms.html</a>
          ｜門檻：可用 ≤ ${ALERT_DAYS} 天｜交期預設 ${DEFAULT_LEAD} 天 + 安全 ${DEFAULT_SAFETY} 天
        </p>
      </div>
    </div>`;
}

// ── Vercel Handler ──
module.exports = async function handler(req, res) {
  // 只允許 GET（Cron 用 GET 觸發）
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const alerts = await getAlertItems();

    // 寄信
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,  // ai@enamor.com.tw
        pass: process.env.GMAIL_PASS   // Google 應用程式密碼
      }
    });

    const subject = alerts.length > 0
      ? `⚠ 缺貨提醒：${alerts.length} 項 SKU 可用 ≤ ${ALERT_DAYS} 天`
      : `✓ 庫存充足（${new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })}）`;

    await transporter.sendMail({
      from: `"EnamoR 庫存" <${process.env.GMAIL_USER}>`,
      to: 'ruby@enamor.com.tw',
      subject,
      html: buildEmailHTML(alerts)
    });

    return res.status(200).json({
      ok: true,
      alertCount: alerts.length,
      sent: new Date().toISOString()
    });
  } catch (err) {
    console.error('stock-alert error:', err);
    return res.status(500).json({ error: err.message });
  }
};
