
const BASE_URL = "https://world.openbeautyfacts.org";
const db = require("../db");

const HEADERS = {
  "User-Agent": "Knowly/1.0 (academic product research)",
  "Accept": "application/json"
};

const FIELDS = [
  "code",
  "product_name",
  "brands",
  "quantity",
  "categories",
  "image_url",
  "image_front_url",
  "ingredients_text",
  "countries"
].join(",");

const cache = new Map();
const CACHE_MS = 15 * 60 * 1000;

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function formatProduct(product) {
  return {
    barcode: product.code || null,
    name: product.product_name || "Unknown product",
    brand: product.brands || null,
    quantity: product.quantity || null,
    category: product.categories || null,
    image: product.image_url ||
      product.image_front_url || null,
    ingredients: product.ingredients_text || null,
    countries: product.countries || null,
    source: "Open Beauty Facts"
  };
}

async function fetchJSON(url) {
  const response = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    throw new Error(
      `Open Beauty Facts HTTP ${response.status}`
    );
  }

  return response.json();
}

function rankProducts(products, term) {
  const words = normalize(term).split(/\s+/).filter(Boolean);
  const seen = new Set();

  return products
    .filter(p => p.code && p.product_name)
    .map(p => {
      const product = formatProduct(p);
      const name = normalize(p.product_name);
      const brand = normalize(p.brands);
      const combined = `${name} ${brand}`;

      const matches = words.filter(w =>
        combined.includes(w)
      ).length;

      const score =
        matches * 10 +
        (name === normalize(term) ? 20 : 0) +
        (brand.includes(normalize(term)) ? 10 : 0);

      return { ...product, score, matches };
    })
    .filter(p => p.matches > 0)
    .sort((a, b) => b.score - a.score)
    .filter(p => {
      if (seen.has(p.barcode)) return false;
      seen.add(p.barcode);
      return true;
    })
    .slice(0, 12)
    .map(({ score, matches, ...product }) => product);
}

// =====================================
// FALLBACK: SAVED POSTGRESQL PRODUCTS
// =====================================

async function searchSavedProducts(term) {
  const result = await db.pool.query(
    `
    SELECT
      p.id,
      p.name,
      p.barcode,
      p.image_url,
      p.description,
      p.specifications,
      b.name AS brand_name,
      c.name AS category_name,
      p.source_name
    FROM public.products p
    LEFT JOIN public.brands b
      ON b.id = p.brand_id
    JOIN public.categories c
      ON c.id = p.category_id
    WHERE (
      c.slug = 'beauty-personal-care'
      OR c.parent_id = (
        SELECT id
        FROM public.categories
        WHERE slug = 'beauty-personal-care'
        LIMIT 1
      )
    )
    AND (
      p.name ILIKE $1
      OR b.name ILIKE $1
    )
    ORDER BY p.name
    LIMIT 12
    `,
    [`%${term}%`]
  );

  return result.rows;
}

// =====================================
// SEARCH BEAUTY PRODUCTS
// =====================================

async function searchProducts(searchTerm) {
  const term = String(searchTerm || "").trim();

  if (!term) return [];

  if (term.length > 100) {
    throw new Error("Search term too long");
  }

  const key = normalize(term);
  const cached = cache.get(key);

  if (cached && Date.now() < cached.expires) {
    return cached.products;
  }

  let externalProducts = [];

  // First: full-text search using legacy endpoint
  try {
    const params = new URLSearchParams({
      search_terms: term,
      search_simple: "1",
      action: "process",
      json: "1",
      page_size: "50",
      fields: FIELDS
    });

    const data = await fetchJSON(
      `${BASE_URL}/cgi/search.pl?${params}`
    );

    externalProducts = rankProducts(
      data.products || [],
      term
    );
  } catch (error) {
    console.log(
      "Beauty keyword search unavailable:",
      error.message
    );
  }

  // Second: try structured brand search
  if (!externalProducts.length) {
    try {
      const params = new URLSearchParams({
        brands_tags: normalize(term).replace(/\s+/g, "-"),
        fields: FIELDS,
        page_size: "50"
      });

      const data = await fetchJSON(
        `${BASE_URL}/api/v2/search?${params}`
      );

      externalProducts = rankProducts(
        data.products || [],
        term
      );
    } catch (error) {
      console.log(
        "Beauty brand search unavailable:",
        error.message
      );
    }
  }

  // Third: fallback to saved products
  if (!externalProducts.length) {
    const savedProducts = await searchSavedProducts(term);

    if (savedProducts.length) {
      return savedProducts;
    }
  }

  // Cache successful, non-empty results only
  if (externalProducts.length) {
    cache.set(key, {
      products: externalProducts,
      expires: Date.now() + CACHE_MS
    });
  }

  return externalProducts;
}

// =====================================
// GET PRODUCT BY BARCODE
// =====================================

async function getProductByBarcode(barcode) {
  if (!/^[0-9]{8,14}$/.test(String(barcode || ""))) {
    throw new Error("Invalid product barcode");
  }

  const params = new URLSearchParams({
    fields: FIELDS
  });

  const data = await fetchJSON(
    `${BASE_URL}/api/v2/product/` +
    `${encodeURIComponent(barcode)}.json?${params}`
  );

  if (data.status !== 1 || !data.product) {
    return null;
  }

  return formatProduct(data.product);
}

module.exports = {
  searchProducts,
  getProductByBarcode
};
