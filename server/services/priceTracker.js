
const db = require("../db");
const electronics = require("./lebtech");

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED = new Set([
  "electronics",
  "computers-accessories"
]);

const pending = new Map();

let blockedUntil = 0;
let consecutiveLimits = 0;

function clean(value, max = 255) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function safeURL(value) {
  try {
    const url = new URL(value);

    return ["https:", "http:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function toPrice(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) &&
    number >= 0 &&
    number <= 9999999999
    ? number.toFixed(2)
    : null;
}

// =====================================
// DETECT RATE LIMITING
// =====================================

function isRateLimited(error) {
  return (
    Number(error?.code || error?.status) === 429 ||
    /(?:\b429\b|error.?1015|rate.?limit)/i.test(
      String(error?.message || "")
    )
  );
}

function startCooldown(error) {
  consecutiveLimits++;

  const reported = Number(
    String(error?.message || "").match(
      /"retry_after"\s*:\s*(\d+)/
    )?.[1] || 30
  );

  const exponentialSeconds = Math.min(
    600,
    30 * 2 ** Math.min(consecutiveLimits - 1, 5)
  );

  const waitSeconds = Math.max(
    30,
    reported,
    exponentialSeconds
  );

  blockedUntil = Date.now() + waitSeconds * 1000;

  console.warn(
    `Price requests paused for ${waitSeconds} seconds due to rate limiting.`
  );

  return waitSeconds;
}

// =====================================
// NORMALIZE STORE OFFERS
// =====================================

function normalizeOffers(rawOffers) {
  const unique = new Map();

  for (const item of rawOffers) {
    const storeName = clean(item.storeName);
    const amount = toPrice(item.price);

    if (
      !storeName ||
      storeName.toLowerCase() === "unknown store" ||
      amount === null
    ) {
      continue;
    }

    const condition =
      clean(item.condition, 50) || "New";

    const currency =
      clean(item.currency, 10).toUpperCase() || "USD";

    const availability =
      typeof item.availability === "boolean"
        ? (
            item.availability
              ? "In stock"
              : "Out of stock"
          )
        : clean(item.availability, 50) || "Unknown";

    const parsedTime = Date.parse(
      item.checkedAt || ""
    );

    const checkedAt = Number.isFinite(parsedTime)
      ? new Date(parsedTime).toISOString()
      : new Date().toISOString();

    const offer = {
      storeName,
      amount,
      condition,
      currency,
      availability,
      url: safeURL(item.url),
      checkedAt
    };

    const key =
      `${storeName.toLowerCase()}|${condition.toLowerCase()}`;

    const previous = unique.get(key);

    if (
      !previous ||
      Number(amount) < Number(previous.amount)
    ) {
      unique.set(key, offer);
    }
  }

  return [...unique.values()];
}

// =====================================
// READ SAVED PRICE HISTORY
// =====================================

async function getProductHistory(productId) {
  if (!/^[1-9][0-9]*$/.test(String(productId))) {
    const error = new Error("Invalid product ID");
    error.status = 400;
    throw error;
  }

  const result = await db.pool.query(
    `
    SELECT
      h.id,
      h.offer_id,
      h.price,
      h.currency,
      h.recorded_at,
      s.name AS store_name,
      o."condition" AS condition
    FROM public.price_history h
    JOIN public.offers o
      ON o.id = h.offer_id
    LEFT JOIN public.stores s
      ON s.id = o.store_id
    WHERE o.product_id = $1
    ORDER BY h.recorded_at DESC, h.id DESC
    LIMIT 100
    `,
    [productId]
  );

  return result.rows;
}

// =====================================
// USE PREVIOUSLY SAVED PRICES
// =====================================

async function savedSnapshot(externalId, reason) {
  const matched = await db.pool.query(
    `
    SELECT id
    FROM public.products
    WHERE source_name = 'LebTech'
      AND external_id = $1
    ORDER BY id
    LIMIT 1
    `,
    [externalId]
  );

  const productId = matched.rows[0]?.id || null;

  if (!productId) {
    return {
      productId: null,
      offers: [],
      history: [],
      stats: null,
      warning:
        `${reason} No previously saved offers exist for this product yet.`,
      fromSavedData: true
    };
  }

  const saved = await db.pool.query(
    `
    SELECT
      s.name AS "storeName",
      o.price,
      o.currency,
      o."condition" AS condition,
      o.availability,
      o.product_url AS url,
      o.last_checked_at AS "checkedAt"
    FROM public.offers o
    LEFT JOIN public.stores s
      ON s.id = o.store_id
    WHERE o.product_id = $1
      AND o.price IS NOT NULL
    ORDER BY o.price ASC
    `,
    [productId]
  );

  return {
    productId,
    offers: saved.rows,
    history: await getProductHistory(productId),
    stats: null,
    warning: saved.rows.length
      ? `${reason} Showing previously saved prices, which may be outdated.`
      : `${reason} No previously saved offers exist for this product yet.`,
    fromSavedData: true
  };
}

// =====================================
// FETCH AND TRACK LIVE PRICES
// =====================================

async function performTracking(
  product,
  categorySlug,
  externalId,
  name
) {
  let liveOffers;

  try {
    liveOffers =
      await electronics.getProductPrices(externalId);

    blockedUntil = 0;
    consecutiveLimits = 0;

  } catch (error) {
    if (!isRateLimited(error)) {
      throw error;
    }

    const wait = startCooldown(error);

    return savedSnapshot(
      externalId,
      `Live prices are temporarily rate limited. Retry in at least ${wait} seconds.`
    );
  }

  if (!Array.isArray(liveOffers)) {
    throw new Error(
      "Pricing service returned an unexpected response"
    );
  }

  const validOffers = normalizeOffers(liveOffers);

  if (validOffers.length === 0) {
    return savedSnapshot(
      externalId,
      "No usable live store offers were returned."
    );
  }

  const client = await db.pool.connect();

  let productId;

  const stats = {
    newOffers: 0,
    priceChanges: 0,
    unchangedOffers: 0,
    skippedOffers:
      liveOffers.length - validOffers.length,
    offersTracked: validOffers.length
  };

  try {
    await client.query("BEGIN");

    await client.query(
      `
      SELECT pg_advisory_xact_lock(
        hashtext('knowly-price-track'),
        hashtext($1)
      )
      `,
      [externalId]
    );

    const category = await client.query(
      `
      SELECT id
      FROM public.categories
      WHERE slug = $1
      LIMIT 1
      `,
      [categorySlug]
    );

    if (!category.rows.length) {
      throw new Error(
        "Product category is missing from PostgreSQL"
      );
    }

    // DATA SOURCE

    const source = await client.query(
      `
      INSERT INTO public.data_sources
        (
          name,
          source_type,
          description,
          base_url
        )
      VALUES (
        'LebTech',
        'MCP',
        'Lebanese retailer prices',
        'https://lebtechlb.com/api/mcp'
      )
      ON CONFLICT (name)
      DO UPDATE SET is_active = TRUE
      RETURNING id
      `
    );

    const sourceId = source.rows[0].id;

    // BRAND

    let brandId = null;

    const brandName = clean(product.brand);

    if (brandName) {
      const brand = await client.query(
        `
        INSERT INTO public.brands (name)
        VALUES ($1)
        ON CONFLICT (name)
        DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        `,
        [brandName]
      );

      brandId = brand.rows[0].id;
    }

    // PRODUCT

    const existing = await client.query(
      `
      SELECT id
      FROM public.products
      WHERE source_name = 'LebTech'
        AND external_id = $1
      ORDER BY id
      LIMIT 1
      FOR UPDATE
      `,
      [externalId]
    );

    if (existing.rows.length) {
      productId = existing.rows[0].id;

      await client.query(
        `
        UPDATE public.products
        SET
          name = $2,
          category_id = $3,
          brand_id = COALESCE($4, brand_id),
          image_url = COALESCE($5, image_url),
          product_url = COALESCE($6, product_url),
          updated_at = NOW()
        WHERE id = $1
        `,
        [
          productId,
          name,
          category.rows[0].id,
          brandId,
          safeURL(product.image),
          safeURL(product.productUrl)
        ]
      );
    } else {
      const inserted = await client.query(
        `
        INSERT INTO public.products
          (
            name,
            brand_id,
            category_id,
            image_url,
            specifications,
            source_type,
            source_name,
            external_id,
            product_url
          )
        VALUES (
          $1, $2, $3, $4, $5::jsonb,
          'external', 'LebTech', $6, $7
        )
        RETURNING id
        `,
        [
          name,
          brandId,
          category.rows[0].id,
          safeURL(product.image),
          JSON.stringify({
            catalogCategory:
              clean(product.category, 100) || null,
            market: "Lebanon"
          }),
          externalId,
          safeURL(product.productUrl)
        ]
      );

      productId = inserted.rows[0].id;
    }

    // STORE OFFERS

    for (const offer of validOffers) {
      const website = offer.url
        ? new URL(offer.url).origin
        : null;

      const store = await client.query(
        `
        INSERT INTO public.stores
          (name, website_url, country)
        VALUES ($1, $2, 'Lebanon')
        ON CONFLICT (name, country)
        DO UPDATE SET
          website_url = COALESCE(
            EXCLUDED.website_url,
            stores.website_url
          )
        RETURNING id
        `,
        [offer.storeName, website]
      );

      const previous = await client.query(
        `
        SELECT
          id,
          price,
          currency
        FROM public.offers
        WHERE product_id = $1
          AND store_id = $2
          AND variant_id IS NULL
          AND COALESCE("condition", 'New') = $3
        ORDER BY id
        LIMIT 1
        FOR UPDATE
        `,
        [
          productId,
          store.rows[0].id,
          offer.condition
        ]
      );

      let offerId;
      let changed;

      if (previous.rows.length) {
        const prior = previous.rows[0];
        offerId = prior.id;

        changed =
          prior.price === null ||
          Number(prior.price).toFixed(2) !== offer.amount ||
          prior.currency !== offer.currency;

        await client.query(
          `
          UPDATE public.offers
          SET
            price = $2,
            currency = $3,
            "condition" = $4,
            availability = $5,
            product_url = COALESCE(
              $6,
              product_url
            ),
            last_checked_at = $7,
            data_source_id = $8
          WHERE id = $1
          `,
          [
            offerId,
            offer.amount,
            offer.currency,
            offer.condition,
            offer.availability,
            offer.url,
            offer.checkedAt,
            sourceId
          ]
        );

        if (changed) {
          stats.priceChanges++;
        } else {
          stats.unchangedOffers++;
        }
      } else {
        const inserted = await client.query(
          `
          INSERT INTO public.offers
            (
              product_id,
              store_id,
              data_source_id,
              price,
              currency,
              "condition",
              availability,
              product_url,
              last_checked_at
            )
          VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9
          )
          RETURNING id
          `,
          [
            productId,
            store.rows[0].id,
            sourceId,
            offer.amount,
            offer.currency,
            offer.condition,
            offer.availability,
            offer.url,
            offer.checkedAt
          ]
        );

        offerId = inserted.rows[0].id;

        changed = true;
        stats.newOffers++;
      }

      // RECORD ONLY NEW OR CHANGED PRICES

      if (changed) {
        await client.query(
          `
          INSERT INTO public.price_history
            (offer_id, price, currency)
          VALUES ($1, $2, $3)
          `,
          [
            offerId,
            offer.amount,
            offer.currency
          ]
        );
      }
    }

    await client.query("COMMIT");

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return {
    productId,
    offers: liveOffers,
    history: await getProductHistory(productId),
    stats,
    warning: "",
    fromSavedData: false
  };
}

// =====================================
// RATE-LIMIT-SAFE ENTRY POINT
// =====================================

async function trackProduct(product, categorySlug) {
  const externalId = clean(
    product?.externalId,
    100
  );

  const name = clean(product?.name, 500);

  if (
    !UUID.test(externalId) ||
    !name ||
    !ALLOWED.has(categorySlug)
  ) {
    const error = new Error(
      "Invalid product or category"
    );

    error.status = 400;
    throw error;
  }

  // Respect cooldown before contacting the provider.

  if (Date.now() < blockedUntil) {
    const seconds = Math.ceil(
      (blockedUntil - Date.now()) / 1000
    );

    return savedSnapshot(
      externalId,
      `Live prices are temporarily rate limited. Retry in ${seconds} seconds.`
    );
  }

  // Avoid duplicate requests for the same product.

  if (pending.has(externalId)) {
    return pending.get(externalId);
  }

  const task = performTracking(
    product,
    categorySlug,
    externalId,
    name
  ).finally(() => {
    pending.delete(externalId);
  });

  pending.set(externalId, task);

  return task;
}

module.exports = {
  trackProduct,
  getProductHistory
};
