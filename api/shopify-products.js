// api/shopify-products.js
// 使用 Admin API REST（shpat_ token）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const shop = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN; // shpat_...

  if (!shop || !token) {
    return res.status(500).json({ error: 'Shopify env vars not set', products: [] });
  }

  const { query = '' } = req.query;
  if (!query.trim()) return res.status(200).json({ products: [] });

  try {
    // Admin REST API 搜尋商品
    const url = `https://${shop}/admin/api/2026-01/products.json?limit=6&title=${encodeURIComponent(query)}`;

    const r = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('Admin API error:', r.status, err);
      return res.status(200).json({ products: [] });
    }

    const data = await r.json();
    const products = (data.products || []).map(p => ({
      title: p.title,
      url: `https://${shop}/products/${p.handle}`,
      price: p.variants?.[0]?.price || '0',
      tags: p.tags || '',
      description: (p.body_html || '').replace(/<[^>]+>/g, '').slice(0, 150)
    }));

    return res.status(200).json({ products });

  } catch (err) {
    console.error('shopify-products error:', err);
    return res.status(200).json({ products: [] });
  }
}
