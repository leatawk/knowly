// =====================================================
// SHOPPER-REPORTED SHELF PRICES IN LEBANON (Open Prices)
//
// Open Prices is the open price database run by Open Food
// Facts (licence: ODbL). Every price is tied to a real
// shop and a date, and is identified by product barcode.
//
// Knowly reads ONLY prices recorded at shops located in
// Lebanon. Coverage depends on what shoppers have
// contributed, so many products have no price yet.
// This file never estimates or converts a price.
// =====================================================

const BASE_URL =
  process.env.OPEN_PRICES_URL || "https://prices.openfoodfacts.org";

const CACHE_MS = 30 * 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;

// Centre of Lebanon; the radius covers the whole country.
// Results are then filtered by country code "LB".
const LEBANON = { lat: "33.87", lon: "35.86", radius_km: "140" };

const HEADERS = {
  "User-Agent": "Knowly/1.0 (academic price comparison project)",
  "Accept": "application/json"
};

const cache = new Map();
const pending = new Map();

let unavailableUntil = 0;

async function fetchJSON(path, params) {
  const response = await fetch(
    `${BASE_URL}${path}?${new URLSearchParams(params)}`,
    {
      headers: HEADERS,
      signal: AbortSignal.timeout(12000)
    }
  );

  if (!response.ok) {
    const error = new Error(`Open Prices HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function isLebanese(location) {
  return (
    String(location?.osm_address_country_code || "").toUpperCase() === "LB"
  );
}

// Prices of one barcode near Lebanon (one request).
async function pricesByArea(barcode) {
  const data = await fetchJSON("/api/v1/prices", {
    product_code: barcode,
    ...LEBANON,
    order_by: "-date",
    size: "100"
  });

  return data.items || [];
}

// Fallback: list the Lebanese shops first, then ask for
// their prices of this barcode.
async function pricesByShops(barcode) {
  const shops = new Map();

  for (const country of ["Lebanon", "لبنان"]) {
    const data = await fetchJSON("/api/v1/locations", {
      osm_address_country__like: country,
      size: "100"
    });

    for (const location of data.items || []) {
      if (isLebanese(location)) shops.set(location.id, location);
    }
  }

  if (!shops.size) return [];

  const data = await fetchJSON("/api/v1/prices", {
    product_code: barcode,
    location_id__in: [...shops.keys()].join(","),
    order_by: "-date",
    size: "100"
  });

  return (data.items || []).map(item => ({
    ...item,
    location: item.location || shops.get(item.location_id)
  }));
}

function toObservation(item, barcode) {
  const location = item.location || {};
  const price = Number(item.price);
  const date = Date.parse(item.date || "");

  if (
    !isLebanese(location) ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(date) ||
    !item.currency ||
    item.price_per ||
    String(item.product_code || barcode) !== barcode
  ) {
    return null;
  }

  const shop = String(
    location.osm_name || location.osm_brand || ""
  ).trim();

  if (!shop) return null;

  const city = String(location.osm_address_city || "").trim();

  let website = null;
  try {
    website = new URL(location.website_url).origin;
  } catch {
    website = null;
  }

  return {
    locationId: location.id ?? item.location_id,
    storeName: (city ? `${shop} (${city})` : shop).slice(0, 255),
    website,
    price,
    currency: String(item.currency).toUpperCase().slice(0, 10),
    date: new Date(date).toISOString(),
    // The public record of this price.
    recordUrl: `${BASE_URL}/products/${barcode}`
  };
}

async function load(barcode) {
  let items;

  try {
    items = await pricesByArea(barcode);
  } catch (error) {
    // 400/404/422: the area filter was not accepted.
    if (![400, 404, 422].includes(error.status)) throw error;
    items = await pricesByShops(barcode);
  }

  // Newest price per shop.
  const latest = new Map();

  for (const item of items) {
    const observation = toObservation(item, barcode);
    if (!observation) continue;

    const current = latest.get(observation.locationId);

    if (!current || observation.date > current.date) {
      latest.set(observation.locationId, observation);
    }
  }

  return [...latest.values()];
}

// =====================================
// PUBLIC: Lebanese prices of one barcode
// =====================================

async function getLebanesePrices(code) {
  const barcode = String(code || "");

  if (!/^[0-9]{8,14}$/.test(barcode)) return [];

  const saved = cache.get(barcode);

  if (saved && Date.now() < saved.expiresAt) {
    return saved.prices;
  }

  if (Date.now() < unavailableUntil) {
    throw new Error("Shopper-reported prices are temporarily unavailable");
  }

  if (pending.has(barcode)) return pending.get(barcode);

  const task = load(barcode)
    .then(prices => {
      cache.set(barcode, {
        prices,
        expiresAt: Date.now() + CACHE_MS
      });

      return prices;
    })
    .catch(error => {
      unavailableUntil = Date.now() + COOLDOWN_MS;
      throw error;
    })
    .finally(() => {
      pending.delete(barcode);
    });

  pending.set(barcode, task);

  return task;
}

module.exports = {
  getLebanesePrices
};
