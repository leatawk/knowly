
const BASE_URL = "https://world.openfoodfacts.org";

// Cache successful searches for 15 minutes
const CACHE_DURATION = 15 * 60 * 1000;

// Avoid retrying repeatedly when service is unavailable
const COOLDOWN_DURATION = 60 * 1000;

const searchCache = new Map();
const pendingSearches = new Map();

let unavailableUntil = 0;

const HEADERS = {
  "User-Agent": "Knowly/1.0 (academic product research application)",
  "Accept": "application/json"
};

// =====================================
// HELPERS
// =====================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    image: product.image_url || null,
    ingredients: product.ingredients_text || null,
    countries: product.countries || null,
    countries_tags: product.countries_tags || [],
    stores: product.stores || null,
    source: "Open Food Facts",
    isLebanese: (product.countries_tags || [])
      .includes("en:lebanon")
  };
}

const FIELDS = [
  "code",
  "product_name",
  "brands",
  "quantity",
  "categories",
  "image_url",
  "ingredients_text",
  "countries",
  "countries_tags",
  "stores"
].join(",");

// =====================================
// FETCH WITH CONTROLLED RETRY
// =====================================

async function fetchJSON(url, isSearch = false) {
  if (isSearch && Date.now() < unavailableUntil) {
    throw new Error(
      "Open Food Facts is temporarily unavailable. Try again later."
    );
  }

  const maxAttempts = isSearch ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let response;

    try {
      response = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      if (attempt < maxAttempts - 1) {
        await sleep(1500);
        continue;
      }

      throw new Error(
        "Could not connect to Open Food Facts."
      );
    }

    if (response.ok) {
      return response.json();
    }

    if (response.status === 429 || response.status === 503) {
      if (attempt < maxAttempts - 1) {
        await sleep(1500);
        continue;
      }

      if (isSearch) {
        unavailableUntil = Date.now() + COOLDOWN_DURATION;
      }

      throw new Error(
        `Open Food Facts HTTP ${response.status}: service temporarily unavailable`
      );
    }

    throw new Error(
      `Open Food Facts HTTP ${response.status}`
    );
  }
}

// =====================================
// GET PRODUCT BY BARCODE
// =====================================

async function getProductByBarcode(barcode) {
  if (!/^[0-9]{8,14}$/.test(String(barcode || ""))) {
    throw new Error("Invalid barcode");
  }

  const url =
    `${BASE_URL}/api/v2/product/${encodeURIComponent(barcode)}.json` +
    `?fields=${encodeURIComponent(FIELDS)}`;

  const data = await fetchJSON(url);

  if (data.status !== 1 || !data.product) {
    return null;
  }

  return formatProduct(data.product);
}

// =====================================
// SEARCH PRODUCTS BY NAME
// =====================================

async function performSearch(searchTerm) {
  // Open Food Facts search API
  const params = new URLSearchParams({
    search_terms: searchTerm,
    search_simple: "1",
    action: "process",
    json: "1",
    fields: FIELDS,
    page_size: "50"
  });

  const url =
    `${BASE_URL}/cgi/search.pl?${params.toString()}`;

  const data = await fetchJSON(url, true);

  const words = normalize(searchTerm)
    .split(/\s+/)
    .filter(Boolean);

  const seen = new Set();

  const results = (data.products || [])
    .filter(product =>
      product.code &&
      product.product_name
    )
    .map(product => {
      const formatted = formatProduct(product);

      const searchableText = normalize(
        `${product.product_name} ${product.brands || ""}`
      );

      const matchedWords = words.filter(word =>
        searchableText.includes(word)
      ).length;

      const exactName = normalize(product.product_name) ===
        normalize(searchTerm);

      return {
        ...formatted,
        relevance: matchedWords,
        exactName
      };
    })
    .filter(product =>
      product.relevance === words.length
    )
    .filter(product => {
      if (seen.has(product.barcode)) return false;

      seen.add(product.barcode);
      return true;
    })
    .sort((a, b) => {
      if (a.isLebanese !== b.isLebanese) {
        return Number(b.isLebanese) -
          Number(a.isLebanese);
      }

      if (a.exactName !== b.exactName) {
        return Number(b.exactName) -
          Number(a.exactName);
      }

      return a.name.localeCompare(b.name);
    })
    .slice(0, 12);

  return results;
}

// =====================================
// CACHED SEARCH
// =====================================

async function searchProducts(searchTerm) {
  const term = String(searchTerm || "").trim();

  if (!term) {
    return [];
  }

  if (term.length > 100) {
    throw new Error("Search term is too long");
  }

  const key = normalize(term);
  const cached = searchCache.get(key);

  if (cached && Date.now() < cached.expiresAt) {
    console.log("Food cache hit:", term);
    return cached.products;
  }

  if (pendingSearches.has(key)) {
    return pendingSearches.get(key);
  }

  const promise = performSearch(term)
    .then(products => {
      searchCache.set(key, {
        products,
        expiresAt: Date.now() + CACHE_DURATION
      });

      console.log(
        `Food search completed: ${term} (${products.length} results)`
      );

      return products;
    })
    .finally(() => {
      pendingSearches.delete(key);
    });

  pendingSearches.set(key, promise);

  return promise;
}

module.exports = {
  getProductByBarcode,
  searchProducts
};
