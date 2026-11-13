
const ENDPOINT = "https://lebtechlb.com/api/mcp";

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

async function callTool(name, args) {
  const { Client } = await import(
    "@modelcontextprotocol/sdk/client/index.js"
  );
  const { StreamableHTTPClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/streamableHttp.js"
  );

  const client = new Client({
    name: "knowly",
    version: "1.0.0"
  });

  try {
    const transport = new StreamableHTTPClientTransport(
      new URL(ENDPOINT)
    );

    await client.connect(transport);

    const response = await client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 20000 }
    );

    if (response.isError) {
      throw new Error("LebTech returned a tool error");
    }

    if (response.structuredContent) {
      return response.structuredContent;
    }

    const text = (response.content || [])
      .filter(item => item.type === "text")
      .map(item => item.text)
      .join("\n");

    try {
      return JSON.parse(text);
    } catch {
      const block = text.match(
        /```(?:json)?\s*([\s\S]*?)```/
      );

      if (block) {
        return JSON.parse(block[1]);
      }

      console.error(
        "Unexpected LebTech response:",
        text.slice(0, 500)
      );

      throw new Error(
        "LebTech returned an unexpected response format"
      );
    }
  } finally {
    await client.close().catch(() => {});
  }
}

function findArray(data, keys) {
  const queue = [data];
  const visited = new Set();

  while (queue.length) {
    const current = queue.shift();

    if (!current || typeof current !== "object") {
      continue;
    }

    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      return current;
    }

    for (const key of keys) {
      if (Array.isArray(current[key])) {
        return current[key];
      }
    }

    for (const key of ["data", "result", "payload"]) {
      if (current[key]) {
        queue.push(current[key]);
      }
    }
  }

  return [];
}

function money(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return money(value[0]);
  }

  if (typeof value === "object") {
    return money(
      value.amount ??
      value.min ??
      value.low ??
      value.value
    );
  }

  if (typeof value === "string") {
    const cleaned = value.replace(/[$,]/g, "").trim();
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    value = cleaned;
  }

  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function normalizeProduct(item) {
  const p = item.product || item;

  const externalId =
    p.product_id ??
    p.id ??
    p.slug ??
    p.product_url ??
    p.url ??
    null;

  const shopCount =
    p.shop_count ??
    p.shops_count ??
    p.store_count ??
    (Array.isArray(p.shops) ? p.shops.length : null);

  return {
    externalId:
      externalId == null ? null : String(externalId),
    name:
      p.name ||
      p.title ||
      p.product_name ||
      p.model ||
      "Unnamed product",
    brand: p.brand || p.brand_name || null,
    category: p.category || null,
    image: p.image_url || p.image || p.thumbnail || null,
    minPrice: money(
      p.lowest_price_usd ??
      p.min_price_usd ??
      p.best_price_usd ??
      p.cheapest_price_usd ??
      p.lowest_price ??
      p.min_price ??
      p.best_price ??
      p.price_range ??
      p.price
    ),
    currency: "USD",
    shopCount,
    productUrl:
      p.product_url ||
      p.url ||
      p.page ||
      p.lebtech_url ||
      null,
    source: "LebTech"
  };
}

function normalizeOffer(item) {
  const store = item.shop || item.store || {};

  return {
    storeName:
      item.shop_name ||
      item.store_name ||
      (typeof store === "string" ? store : store.name) ||
      "Unknown store",
    price: money(
      item.price_usd ??
      item.final_price_usd ??
      item.price ??
      item.amount
    ),
    currency: item.currency || "USD",
    availability:
      item.availability ??
      item.in_stock ??
      null,
    condition: item.condition || null,
    url:
      item.shop_url ||
      item.product_url ||
      item.offer_url ||
      item.url ||
      item.link ||
      (typeof store === "object" ? store.url : null) ||
      null,
    checkedAt:
      item.checked_at ||
      item.updated_at ||
      null
  };
}

async function cachedCall(key, action) {
  const saved = cache.get(key);

  if (saved && Date.now() < saved.expiresAt) {
    return saved.data;
  }

  const data = await action();

  cache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_MS
  });

  return data;
}

async function searchProducts(query) {
  const term = String(query || "").trim();

  if (term.length < 2 || term.length > 100) {
    throw new Error("Enter a search term of 2-100 characters");
  }

  return cachedCall(`search:${term.toLowerCase()}`, async () => {
    const data = await callTool("search_products", {
      query: term,
      market: "LB",
      limit: 10
    });

    const raw = findArray(data, [
      "products",
      "results",
      "items",
      "matches"
    ]);

    return raw.map(normalizeProduct);
  });
}

async function getProductPrices(product) {
  const reference = String(product || "").trim();

  if (!reference || reference.length > 500) {
    throw new Error("Invalid LebTech product reference");
  }

  return cachedCall(`prices:${reference}`, async () => {
    const data = await callTool("get_product_prices", {
      product: reference,
      market: "LB"
    });

    const raw = findArray(data, [
      "offers",
      "shops",
      "prices",
      "stores",
      "listings"
    ]);

    return raw
      .map(normalizeOffer)
      .filter(item => item.price !== null)
      .sort((a, b) => a.price - b.price);
  });
}

module.exports = {
  searchProducts,
  getProductPrices
};
