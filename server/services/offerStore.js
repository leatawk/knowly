// =====================================================
// KNOWLY - STORE OFFERS IN POSTGRESQL
//
// Shared by every feature that saves or reads a retailer
// price: electronics tracking, grocery/beauty offers,
// automotive listings and manually verified prices.
//
// Rules enforced here:
//   - one row per real listing (no duplicates)
//   - price_history gets a row only for a first
//     observation or a real price change
//   - prices in different currencies are never ranked
//     against each other
// =====================================================

const db = require("../db");
const { toNumber, safeURL } = require("./normalize");

const INACTIVE = "Not listed";

// What the customer sees instead of a provider name.
const SOURCE_LABELS = {
  "LebTech": "Store listing",
  "Speero": "Store listing",
  "Open Prices": "Reported by shoppers",
  "Knowly verified listing": "Verified listing"
};

// -------------------------------------
// Find-or-create helpers (inside a transaction)
// -------------------------------------

async function ensureSource(client, name, type, description, baseUrl) {
  const result = await client.query(
    `
    INSERT INTO public.data_sources
      (name, source_type, description, base_url)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (name)
    DO UPDATE SET is_active = TRUE
    RETURNING id
    `,
    [name, type, description, baseUrl]
  );

  return result.rows[0].id;
}

async function ensureStore(client, name, websiteUrl, country) {
  const result = await client.query(
    `
    INSERT INTO public.stores (name, website_url, country)
    VALUES ($1, $2, $3)
    ON CONFLICT (name, country)
    DO UPDATE SET
      website_url = COALESCE(stores.website_url, EXCLUDED.website_url)
    RETURNING id
    `,
    [name, websiteUrl || null, country]
  );

  return result.rows[0].id;
}

async function ensureBrand(client, name) {
  if (!name) return null;

  const result = await client.query(
    `
    INSERT INTO public.brands (name)
    VALUES ($1)
    ON CONFLICT (name)
    DO UPDATE SET name = EXCLUDED.name
    RETURNING id
    `,
    [name]
  );

  return result.rows[0].id;
}

// One product_variants row per product + variant key.
async function ensureVariant(client, productId, variant) {
  if (!variant) return null;

  const existing = await client.query(
    `
    SELECT id
    FROM public.product_variants
    WHERE product_id = $1
      AND sku = $2
    ORDER BY id
    LIMIT 1
    `,
    [productId, variant.key]
  );

  if (existing.rows.length) return existing.rows[0].id;

  const inserted = await client.query(
    `
    INSERT INTO public.product_variants
      (product_id, variant_name, attributes, sku)
    VALUES ($1, $2, $3::jsonb, $4)
    RETURNING id
    `,
    [
      productId,
      variant.label,
      JSON.stringify(variant.attributes || {}),
      variant.key
    ]
  );

  return inserted.rows[0].id;
}

// -------------------------------------
// Insert or update ONE offer
//
// existing: the matching row ({ id, price, currency })
//           or null when the listing is new.
// Returns { id, status } where status is
// "new" | "changed" | "unchanged".
// -------------------------------------

async function saveOffer(client, existing, offer) {
  const price = Number(offer.price).toFixed(2);
  let id;
  let status;

  if (existing) {
    id = existing.id;

    status =
      existing.price === null ||
      Number(existing.price).toFixed(2) !== price ||
      existing.currency !== offer.currency
        ? "changed"
        : "unchanged";

    await client.query(
      `
      UPDATE public.offers
      SET
        price = $2,
        currency = $3,
        "condition" = $4,
        availability = $5,
        product_url = COALESCE($6, product_url),
        last_checked_at = $7,
        data_source_id = $8,
        variant_id = $9
      WHERE id = $1
      `,
      [
        id,
        price,
        offer.currency,
        offer.condition,
        offer.availability,
        offer.url,
        offer.checkedAt,
        offer.sourceId,
        offer.variantId || null
      ]
    );
  } else {
    const inserted = await client.query(
      `
      INSERT INTO public.offers
        (
          product_id, variant_id, store_id, data_source_id,
          price, currency, "condition", availability,
          product_url, last_checked_at
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
      `,
      [
        offer.productId,
        offer.variantId || null,
        offer.storeId,
        offer.sourceId,
        price,
        offer.currency,
        offer.condition,
        offer.availability,
        offer.url,
        offer.checkedAt
      ]
    );

    id = inserted.rows[0].id;
    status = "new";
  }

  // Record only a first observation or a real change.
  if (status !== "unchanged") {
    await client.query(
      `
      INSERT INTO public.price_history
        (offer_id, price, currency, recorded_at)
      VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))
      `,
      [id, price, offer.currency, offer.recordedAt || null]
    );
  }

  return { id, status };
}

// -------------------------------------
// Read offers
// -------------------------------------

const OFFER_SELECT = `
  SELECT
    o.id,
    o.product_id,
    o.price,
    o.currency,
    o."condition" AS condition,
    o.availability,
    o.product_url,
    o.last_checked_at,
    s.name AS store_name,
    s.website_url AS store_website,
    s.country AS store_country,
    v.variant_name,
    v.attributes AS variant_attributes,
    d.name AS source_name
  FROM public.offers o
  LEFT JOIN public.stores s ON s.id = o.store_id
  LEFT JOIN public.product_variants v ON v.id = o.variant_id
  LEFT JOIN public.data_sources d ON d.id = o.data_source_id
`;

function formatOffer(row, liveIds) {
  const store = row.store_name || "Unknown store";
  const availability = row.availability || "Unknown";

  return {
    id: String(row.id),
    store,
    storeName: store,
    storeUrl: safeURL(row.store_website),
    market: row.store_country || null,
    price: toNumber(row.price),
    currency: row.currency || "USD",
    condition: row.condition || "New",
    availability,
    variant: row.variant_name || null,
    url: safeURL(row.product_url),
    checkedAt: row.last_checked_at
      ? new Date(row.last_checked_at).toISOString()
      : null,
    sourceLabel: SOURCE_LABELS[row.source_name] || "Store listing",
    active: availability !== INACTIVE,
    live: Boolean(liveIds && liveIds.has(String(row.id)))
  };
}

function sortOffers(offers) {
  const rank = offer =>
    !offer.active ? 2 : offer.availability === "Out of stock" ? 1 : 0;

  return offers.sort((a, b) =>
    rank(a) - rank(b) ||
    a.currency.localeCompare(b.currency) ||
    a.price - b.price
  );
}

async function readOffers(productId, liveIds) {
  const result = await db.pool.query(
    `${OFFER_SELECT}
     WHERE o.product_id = $1
       AND o.price IS NOT NULL`,
    [productId]
  );

  return sortOffers(
    result.rows.map(row => formatOffer(row, liveIds))
  );
}

async function readOffersForProducts(productIds) {
  const grouped = new Map();
  if (!productIds.length) return grouped;

  const result = await db.pool.query(
    `${OFFER_SELECT}
     WHERE o.product_id = ANY($1::bigint[])
       AND o.price IS NOT NULL`,
    [productIds]
  );

  for (const row of result.rows) {
    const key = String(row.product_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(formatOffer(row));
  }

  for (const offers of grouped.values()) sortOffers(offers);

  return grouped;
}

// -------------------------------------
// Lowest verified price
//
// Prices are ranked only inside one currency. When a
// product has offers in several currencies, "best" is
// null and the caller shows one lowest price per currency.
// -------------------------------------

function summarize(offers) {
  const listed = offers.filter(offer => offer.active);

  const available = listed.filter(
    offer => offer.availability !== "Out of stock"
  );

  const pool = available.length ? available : listed;
  const lowest = new Map();

  for (const offer of pool) {
    const current = lowest.get(offer.currency);

    if (!current || offer.price < current.price) {
      lowest.set(offer.currency, offer);
    }
  }

  const lowestByCurrency = [...lowest.values()];

  return {
    best: lowestByCurrency.length === 1 ? lowestByCurrency[0] : null,
    lowestByCurrency,
    offerCount: listed.length,
    storeCount: new Set(listed.map(offer => offer.store)).size
  };
}

module.exports = {
  INACTIVE,
  ensureSource,
  ensureStore,
  ensureBrand,
  ensureVariant,
  saveOffer,
  readOffers,
  readOffersForProducts,
  summarize
};
