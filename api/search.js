// /api/search -> eBay Browse API proxy (keeps your keys on the server)
// Env vars (set in Vercel): EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_SELLER
// Optional: EBAY_MARKETPLACE (default EBAY_US), EBAY_DEFAULT_CATEGORY (default 6028)

let cached = { token: null, expiresAt: 0 };

async function getToken() {
  if (cached.token && Date.now() < cached.expiresAt - 60000) return cached.token;

  const basic = Buffer.from(
    process.env.EBAY_CLIENT_ID + ':' + process.env.EBAY_CLIENT_SECRET
  ).toString('base64');

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });
  if (!res.ok) throw new Error('Token request failed (' + res.status + ')');

  const data = await res.json();
  cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

const SORTS = {
  relevance: null,
  priceAsc: 'price',
  priceDesc: '-price',
  newest: 'newlyListed',
};

module.exports = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const sort = SORTS[req.query.sort] || null;

    const params = new URLSearchParams({
      filter: 'sellers:{' + process.env.EBAY_SELLER + '}',
      limit: String(limit),
      offset: String(offset),
    });
    if (q) params.set('q', q);
    else params.set('category_ids', process.env.EBAY_DEFAULT_CATEGORY || '6028');
    if (sort) params.set('sort', sort);

    const token = await getToken();
    const ebay = await fetch(
      'https://api.ebay.com/buy/browse/v1/item_summary/search?' + params.toString(),
      {
        headers: {
          Authorization: 'Bearer ' + token,
          'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE || 'EBAY_US',
        },
      }
    );

    if (!ebay.ok) {
      const detail = await ebay.text();
      console.error('eBay error', ebay.status, detail);
      return res.status(502).json({ error: 'eBay request failed', status: ebay.status });
    }

    const data = await ebay.json();
    const items = (data.itemSummaries || []).map(function (i) {
      return {
        id: i.itemId,
        title: i.title,
        price: i.price ? Number(i.price.value) : null,
        currency: i.price ? i.price.currency : 'USD',
        image:
          (i.image && i.image.imageUrl) ||
          (i.thumbnailImages && i.thumbnailImages[0] && i.thumbnailImages[0].imageUrl) ||
          '',
        url: i.itemWebUrl,
        condition: i.condition || '',
      };
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({
      total: data.total || 0,
      offset: offset,
      limit: limit,
      hasMore: Boolean(data.next),
      items: items,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
};
