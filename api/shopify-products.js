// api/shopify-products.js
// 使用 Headless Storefront API（shpat_ private token）
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const shop = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) {
    return res.status(500).json({ error: 'Shopify env vars not set', products: [] });
  }

  const { query = '' } = req.query;
  if (!query.trim()) return res.status(200).json({ products: [] });

  const graphqlQuery = `
    query SearchProducts($query: String!) {
      search(query: $query, first: 6, types: [PRODUCT]) {
        edges {
          node {
            ... on Product {
              title
              handle
              description(truncateAt: 150)
              tags
              priceRange {
                minVariantPrice {
                  amount
                }
              }
              metafields(
                identifiers: [
                  {namespace: "custom", key: "preorder_type"},
                  {namespace: "custom", key: "size_options"},
                  {namespace: "custom", key: "stretch_score"}
                ]
              ) {
                key
                value
              }
            }
          }
        }
      }
    }
  `;

  const PREORDER_LABEL = {
    'a1': 'A1 生產製程中（約14個工作天）',
    'a2': 'A2 長銷熱賣補貨（約7個工作天）',
    'b':  'B 流行性商品（以商品頁標示時間為準）',
    'A1': 'A1 生產製程中（約14個工作天）',
    'A2': 'A2 長銷熱賣補貨（約7個工作天）',
    'B':  'B 流行性商品（以商品頁標示時間為準）'
  };

  try {
    const r = await fetch(`https://${shop}/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Shopify-Storefront-Private-Token': token
      },
      body: JSON.stringify({ query: graphqlQuery, variables: { query } })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('Storefront API error:', r.status, err);
      return res.status(200).json({ products: [] });
    }

    const data = await r.json();
    if (data.errors) {
      console.error('GraphQL errors:', JSON.stringify(data.errors));
      return res.status(200).json({ products: [] });
    }

    const edges = data?.data?.search?.edges || [];
    const products = edges.map(({ node: p }) => {
      const mf = {};
      (p.metafields || []).forEach(m => { if (m) mf[m.key] = m.value; });

      const preorderRaw = mf['preorder_type'] || '';
      const preorderLabel = PREORDER_LABEL[preorderRaw] || '';

      let sizeText = '';
      try {
        const sizes = JSON.parse(mf['size_options'] || '[]');
        if (sizes.length) sizeText = sizes.join('、');
      } catch {}

      const stretchScore = mf['stretch_score'] || '';

      return {
        title: p.title,
        url: `https://enamorshop.com/products/${p.handle}`,
        price: p.priceRange?.minVariantPrice?.amount || '0',
        tags: p.tags?.join(', ') || '',
        description: p.description || '',
        preorder_type: preorderLabel,
        size_options: sizeText,
        stretch_score: stretchScore
      };
    });

    return res.status(200).json({ products });
  } catch (err) {
    console.error('shopify-products error:', err);
    return res.status(200).json({ products: [] });
  }
}
