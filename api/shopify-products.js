// api/shopify-products.js
// 使用 Headless Storefront API（shpat_ private token）

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
            }
          }
        }
      }
    }
  `;

  try {
    const r = await fetch(`https://${shop}/api/2026-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Shopify-Storefront-Private-Token': token  // shpat_ 用這個 header
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: { query }
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('Storefront API error:', r.status, err);
      return res.status(200).json({ products: [] });
    }

    const data = await r.json();

    // 如果有錯誤回傳在 errors 欄位
    if (data.errors) {
      console.error('GraphQL errors:', JSON.stringify(data.errors));
      return res.status(200).json({ products: [] });
    }

    const edges = data?.data?.search?.edges || [];
    const products = edges.map(({ node: p }) => ({
      title: p.title,
      url: `https://${shop}/products/${p.handle}`,
      price: p.priceRange?.minVariantPrice?.amount || '0',
      tags: p.tags?.join(', ') || '',
      description: p.description || ''
    }));

    return res.status(200).json({ products });

  } catch (err) {
    console.error('shopify-products error:', err);
    return res.status(200).json({ products: [] });
  }
}
