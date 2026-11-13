
const db = require("../db");
const lebtech = require("./lebtech");

const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_CATEGORIES = new Set([
  "electronics",
  "computers-accessories"
]);

function asText(value, max = 255) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function safeUrl(value) {
  try {
    const url = new URL(value);

    return url.protocol === "https:" ||
      url.protocol === "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function money(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) &&
    n >= 0 &&
    n <= 9999999999
    ? n.toFixed(2)
    : null;
}

// =====================================
// NORMALIZE AND DEDUPLICATE OFFERS
// =====================================

function normalizeOffers(rawOffers) {
  const unique = new Map();

  for (const item of rawOffers) {
    const storeName = asText(item.storeName);
    const amount = money(item.price);

    if (
      !storeName ||
      storeName === "Unknown store" ||
      amount === null
    ) {
      continue;
    }

    const condition =
      asText(item.condition, 50) || "New";

    const currency =
      asText(item.currency, 10).toUpperCase() || "USD";

    const availability =
      typeof item.availability === "boolean"
        ? (
            item.availability
              ? "In stock"
              : "Out of stock"
          )
        : (
            asText(item.availability, 50) || "Unknown"
          );

    const link = safeUrl(item.url);
    const date = new Date(item.checkedAt || Date.now());

    const checkedAt = Number.isFinite(date.getTime())
      ? date.toISOString()
      : new Date().toISOString();

    const offer = {
      storeName,
      amount,
      condition,
      currency,
      availability,
      link,
      checkedAt
    };

    // Keep the lowest reported price for each
    // store and condition of this exact product.
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
// GET SAVED PRICE HISTORY
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
    ORDER BY
      h.recorded_at DESC,
      h.id DESC
    LIMIT 100
    `,
    [productId]
  );

  return result.rows;
}

// =====================================
// FETCH, SAVE AND TRACK STORE PRICES
// =====================================

async function trackProduct(product, categorySlug) {
  const externalId = asText(product?.externalId, 100);
  const name = asText(product?.name, 500);

  if (
    !ID_PATTERN.test(externalId) ||
    !name ||
    !VALID_CATEGORIES.has(categorySlug)
  ) {
    const error = new Error(
      "Invalid product details or category"
    );

    error.status = 400;
    throw error;
  }

  // The backend retrieves the actual prices.
  // The browser cannot supply retailer prices.
  const liveOffers =
    await lebtech.getProductPrices(externalId);

  const validOffers = normalizeOffers(liveOffers);
  const client = await db.pool.connect();

  let productId;

  const stats = {
    newOffers: 0,
    priceChanges: 0,
    unchangedOffers: 0,
    skippedOffers: liveOffers.length - validOffers.length
  };

  try {
    await client.query("BEGIN");

    // Prevent duplicate inserts from simultaneous checks.
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
      throw new Error("Product category is missing");
    }

    // =====================================
    // ENSURE DATA SOURCE EXISTS
    // =====================================

    const source = await client.query(
      `
      INSERT INTO public.data_sources
        (name, source_type, description, base_url)
      VALUES
        (
          'LebTech',
          'MCP',
          'Lebanese retailer product prices',
          'https://lebtechlb.com/api/mcp'
        )
      ON CONFLICT (name)
      DO UPDATE SET is_active = TRUE
      RETURNING id
      `
    );

    const sourceId = source.rows[0].id;

    // =====================================
    // SAVE BRAND IF AVAILABLE
    // =====================================

    let brandId = null;
    const brandName = asText(product.brand);

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

    // =====================================
    // SAVE OR UPDATE PRODUCT
    // =====================================

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
          brand_id = COALESCE($3, brand_id),
          image_url = COALESCE($4, image_url),
          product_url = COALESCE($5, product_url),
          updated_at = NOW()
        WHERE id = $1
        `,
        [
          productId,
          name,
          brandId,
          safeUrl(product.image),
          safeUrl(product.productUrl)
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
        VALUES
          (
            $1, $2, $3, $4, $5::jsonb,
            'external', 'LebTech', $6, $7
          )
        RETURNING id
        `,
        [
          name,
          brandId,
          category.rows[0].id,
          safeUrl(product.image),
          JSON.stringify({
            catalogCategory:
              asText(product.category, 100) || null,
            market: "Lebanon"
          }),
          externalId,
          safeUrl(product.productUrl)
        ]
      );

      productId = inserted.rows[0].id;
    }

    // =====================================
    // SAVE EACH RETAILER OFFER
    // =====================================

    for (const offer of validOffers) {
      const storeSite = offer.link
        ? new URL(offer.link).origin
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
        [offer.storeName, storeSite]
      );

      const previous = await client.query(
        `
        SELECT id, price, currency
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
      let changed = false;

      if (previous.rows.length) {
        const row = previous.rows[0];
        offerId = row.id;

        changed =
          row.price === null ||
          Number(row.price).toFixed(2) !== offer.amount ||
          row.currency !== offer.currency;

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
            offer.link,
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
          VALUES
            (
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
            offer.link,
            offer.checkedAt
          ]
        );

        offerId = inserted.rows[0].id;
        changed = true;
        stats.newOffers++;
      }

      // Only record a new observation when
      // the price is new or has changed.
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

  const history = await getProductHistory(productId);

  return {
    productId,
    offers: liveOffers,
    history,
    stats: {
      ...stats,
      offersTracked: validOffers.length
    }
  };
}

module.exports = {
  trackProduct,
  getProductHistory
};
