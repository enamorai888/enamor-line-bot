module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const SHEET_ID = '14GsmS8LpNHvhXAxxLlNTTUwpbZZuXJZeg6Xx-JXQso0';
  const sheets = ['客服FAQ', 'FAQ設定', '熱賣商品'];
  const result = {};

  try {
    for (const sheet of sheets) {
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheet)}&headers=1`;
      const r = await fetch(url);
      const text = await r.text();
      const json = JSON.parse(text.substring(47).slice(0, -2));
      const cols = json.table.cols.map(c => c.label || c.id);
      const rows = json.table.rows;
      result[sheet] = rows.map(row => {
        const obj = {};
        cols.forEach((col, i) => {
          obj[col] = row.c[i]?.v ?? '';
        });
        return obj;
      });
    }
    return res.status(200).json({ success: true, data: result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
