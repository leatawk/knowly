// =====================================================
// KNOWLY - SAVED PRODUCTS (WISHLIST) AND SAVED COMPARISONS
//
// Everything here belongs to the logged-in user
// (req.user from auth.requireUser).
//
//   wishlists          existing table: user_id + product_id
//   saved_comparisons  added by database/migrations.js
// =====================================================

const db = require("../db");
const catalog = require("./catalog");

const MAX_SAVED_PRODUCTS = 200;
const MAX_SAVED_COMPARISONS = 50;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function validId(value) {
  return /^[1-9][0-9]{0,18}$/.test(String(value || ""));
}

// A product reference from the frontend -> its PostgreSQL id.
// Products found in a search are saved first (catalog.resolve).
async function productIdFor(ref) {
  if (!ref || typeof ref !== "object") {
    throw fail(400, "Unknown product.");
  }

  if (validId(ref.id)) {
    const found = await db.pool.query(
      "SELECT id FROM public.products WHERE id = $1",
      [ref.id]
    );

    if (found.rows.length) return String(found.rows[0].id);
  }

  const detail = await catalog.resolve(ref);

  if (!detail.product.id) {
    throw fail(
      503,
      "This product cannot be saved right now because its store prices are temporarily unavailable. Try again in a minute."
    );
  }

  return String(detail.product.id);
}

// -------------------------------------
// Everything the user saved
// -------------------------------------

async function list(userId) {
  const wished = await db.pool.query(
    `
    SELECT product_id
    FROM public.wishlists
    WHERE user_id = $1
    ORDER BY created_at DESC, id DESC
    `,
    [userId]
  );

  const compared = await db.pool.query(
    `
    SELECT id, name, product_ids, created_at
    FROM public.saved_comparisons
    WHERE user_id = $1
    ORDER BY created_at DESC, id DESC
    `,
    [userId]
  );

  // One query for every product the page needs.
  const ids = [
    ...wished.rows.map(row => String(row.product_id)),
    ...compared.rows.flatMap(row => row.product_ids.map(String))
  ];

  const products = await catalog.productsByIds([...new Set(ids)]);
  const byId = new Map(products.map(product => [product.id, product]));

  return {
    products: wished.rows
      .map(row => byId.get(String(row.product_id)))
      .filter(Boolean),

    comparisons: compared.rows
      .map(row => ({
        id: String(row.id),
        name: row.name,
        createdAt: row.created_at,
        products: row.product_ids
          .map(id => byId.get(String(id)))
          .filter(Boolean)
      }))
      // A comparison whose products were removed is not shown.
      .filter(comparison => comparison.products.length >= 2)
  };
}

// -------------------------------------
// Wishlist
// -------------------------------------

async function saveProduct(userId, ref) {
  const productId = await productIdFor(ref);

  const count = await db.pool.query(
    "SELECT COUNT(*)::int AS total FROM public.wishlists WHERE user_id = $1",
    [userId]
  );

  if (count.rows[0].total >= MAX_SAVED_PRODUCTS) {
    throw fail(400, `You can save up to ${MAX_SAVED_PRODUCTS} products. Remove some first.`);
  }

  // UNIQUE(user_id, product_id): saving twice changes nothing.
  await db.pool.query(
    `
    INSERT INTO public.wishlists (user_id, product_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, product_id) DO NOTHING
    `,
    [userId, productId]
  );

  return list(userId);
}

async function removeProduct(userId, productId) {
  if (!validId(productId)) throw fail(400, "Invalid product ID");

  await db.pool.query(
    "DELETE FROM public.wishlists WHERE user_id = $1 AND product_id = $2",
    [userId, productId]
  );

  return list(userId);
}

// -------------------------------------
// Saved comparisons
// -------------------------------------

function shortName(name) {
  const clean = String(name || "Product").replace(/\s+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

async function saveComparison(userId, body) {
  const input = body && typeof body === "object" ? body : {};
  const items = input.items;

  if (!Array.isArray(items) || items.length < 2 || items.length > 5) {
    throw fail(400, "A comparison needs 2 to 5 products.");
  }

  const ids = [];

  // One after another, to stay gentle on live price sources.
  for (const item of items) {
    ids.push(await productIdFor(item));
  }

  if (new Set(ids).size !== ids.length) {
    throw fail(400, "A comparison needs different products.");
  }

  const names = await db.pool.query(
    "SELECT id, name FROM public.products WHERE id = ANY($1::bigint[])",
    [ids]
  );

  const nameById = new Map(names.rows.map(row => [String(row.id), row.name]));

  const typed = String(input.name || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const name = typed || ids.map(id => shortName(nameById.get(id))).join(" vs ").slice(0, 200);

  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('knowly-saved-comparisons'), hashtext($1))",
      [String(userId)]
    );

    // The same set of products is saved only once.
    const sorted = [...ids].sort((a, b) => Number(a) - Number(b));

    const existing = await client.query(
      `
      SELECT id
      FROM public.saved_comparisons
      WHERE user_id = $1
        AND (SELECT array_agg(x ORDER BY x) FROM unnest(product_ids) AS x) = $2::bigint[]
      LIMIT 1
      `,
      [userId, sorted]
    );

    if (!existing.rows.length) {
      const count = await client.query(
        "SELECT COUNT(*)::int AS total FROM public.saved_comparisons WHERE user_id = $1",
        [userId]
      );

      if (count.rows[0].total >= MAX_SAVED_COMPARISONS) {
        throw fail(400, `You can save up to ${MAX_SAVED_COMPARISONS} comparisons. Delete some first.`);
      }

      await client.query(
        `
        INSERT INTO public.saved_comparisons (user_id, name, product_ids)
        VALUES ($1, $2, $3::bigint[])
        `,
        [userId, name, ids]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return list(userId);
}

async function removeComparison(userId, comparisonId) {
  if (!validId(comparisonId)) throw fail(400, "Invalid comparison ID");

  await db.pool.query(
    "DELETE FROM public.saved_comparisons WHERE id = $1 AND user_id = $2",
    [comparisonId, userId]
  );

  return list(userId);
}

module.exports = {
  list,
  saveProduct,
  removeProduct,
  saveComparison,
  removeComparison
};
