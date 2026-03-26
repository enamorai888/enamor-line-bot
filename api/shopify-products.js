// api/shopify-products.js
// 使用 Storefront API（shpss_ token）— 永不過期，不需要 OAuth 流程

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const shop = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN; // shpss_...

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
        'X-Shopify-Storefront-Access-Token': token
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: { query }
      })
    });

    if (!r.ok) throw new Error(`Storefront API error: ${r.status}`);

    const data = await r.json();
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
