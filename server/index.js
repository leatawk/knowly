
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const db = require("./db");
const food = require("./services/openFoodFacts");
const beauty = require("./services/openBeautyFacts");
const electronics = require("./services/lebtech");
const automotive = require("./services/automotive");
const repository = require("./services/productRepository");
const tracker = require("./services/priceTracker");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin:
    process.env.CLIENT_ORIGIN ||
    "http://localhost:5173"
}));

app.use(express.json({
  limit: "100kb"
}));

const route = fn => (req, res, next) => {
  Promise.resolve(fn(req, res)).catch(next);
};

// =====================================
// HOME
// =====================================

app.get("/", (req, res) => {
  res.json({
    application: "Knowly",
    version: "1.0.0"
  });
});

// =====================================
// DATABASE HEALTH
// =====================================

app.get("/api/health", route(async (req, res) => {
  const value = await db.testConnection();

  res.json({
    status: "ok",
    database: "connected",
    time: value.current_time
  });
}));

// =====================================
// FIVE MAIN CATEGORIES
// =====================================

app.get("/api/categories", route(async (req, res) => {
  const result = await db.pool.query(`
    SELECT id, name, slug, description, parent_id
    FROM public.categories
    WHERE slug IN (
      'electronics',
      'computers-accessories',
      'groceries-food',
      'beauty-personal-care',
      'automotive'
    )
    OR parent_id IN (
      SELECT id
      FROM public.categories
      WHERE slug IN (
        'electronics',
        'computers-accessories',
        'groceries-food',
        'beauty-personal-care',
        'automotive'
      )
    )
    ORDER BY parent_id NULLS FIRST, name ASC
  `);

  res.json({
    count: result.rows.length,
    categories: result.rows
  });
}));

// =====================================
// SAVED DATABASE PRODUCTS
// =====================================

app.get("/api/products", route(async (req, res) => {
  const search = String(req.query.search || "").trim();
  const category = String(req.query.category || "").trim();

  const page = Math.max(
    1,
    Math.floor(Number(req.query.page) || 1)
  );

  const limit = Math.min(
    100,
    Math.max(
      1,
      Math.floor(Number(req.query.limit) || 20)
    )
  );

  const values = [];
  const conditions = [];

  if (search) {
    values.push(`%${search}%`);

    conditions.push(`
      (
        p.name ILIKE $${values.length}
        OR p.description ILIKE $${values.length}
      )
    `);
  }

  if (category) {
    values.push(category);

    conditions.push(`
      p.category_id IN (
        SELECT id
        FROM public.categories
        WHERE slug = $${values.length}

        UNION

        SELECT id
        FROM public.categories
        WHERE parent_id IN (
          SELECT id
          FROM public.categories
          WHERE slug = $${values.length}
        )
      )
    `);
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const count = await db.pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM public.products p
    ${where}
    `,
    values
  );

  const results = await db.pool.query(
    `
    SELECT
      p.*,
      b.name AS brand_name,
      c.name AS category_name,
      c.slug AS category_slug
    FROM public.products p
    LEFT JOIN public.brands b
      ON b.id = p.brand_id
    LEFT JOIN public.categories c
      ON c.id = p.category_id
    ${where}
    ORDER BY p.created_at DESC
    LIMIT $${values.length + 1}
    OFFSET $${values.length + 2}
    `,
    [
      ...values,
      limit,
      (page - 1) * limit
    ]
  );

  res.json({
    total: count.rows[0].total,
    page,
    limit,
    products: results.rows
  });
}));

// =====================================
// PRODUCT PRICE HISTORY
// =====================================

app.get(
  "/api/products/:id/price-history",
  route(async (req, res) => {
    const history = await tracker.getProductHistory(
      req.params.id
    );

    res.json({
      count: history.length,
      history
    });
  })
);

// =====================================
// SAVED STORE OFFERS
// =====================================

app.get(
  "/api/products/:id/offers",
  route(async (req, res) => {
    const result = await db.pool.query(
      `
      SELECT
        o.*,
        s.name AS store_name,
        s.website_url
      FROM public.offers o
      LEFT JOIN public.stores s
        ON s.id = o.store_id
      WHERE o.product_id = $1
      ORDER BY o.price ASC NULLS LAST
      `,
      [req.params.id]
    );

    res.json({
      count: result.rows.length,
      offers: result.rows
    });
  })
);

// =====================================
// PRODUCT DETAILS
// =====================================

app.get(
  "/api/products/:id",
  route(async (req, res) => {
    const result = await db.pool.query(
      `
      SELECT
        p.*,
        b.name AS brand_name,
        c.name AS category_name
      FROM public.products p
      LEFT JOIN public.brands b
        ON b.id = p.brand_id
      LEFT JOIN public.categories c
        ON c.id = p.category_id
      WHERE p.id = $1
      `,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Product not found"
      });
    }

    res.json(result.rows[0]);
  })
);

// =====================================
// COMPARE SAVED PRODUCTS
// =====================================

app.post(
  "/api/compare",
  route(async (req, res) => {
    const ids = req.body?.ids;

    if (
      !Array.isArray(ids) ||
      ids.length < 2 ||
      ids.length > 5 ||
      ids.some(id =>
        !Number.isSafeInteger(Number(id)) ||
        Number(id) <= 0
      ) ||
      new Set(ids.map(String)).size !== ids.length
    ) {
      return res.status(400).json({
        error:
          "Select 2-5 different, valid products"
      });
    }

    const result = await db.pool.query(
      `
      SELECT
        p.*,
        b.name AS brand_name,
        c.name AS category_name,
        best.price AS best_price,
        best.currency AS best_currency,
        best.store_name AS best_store
      FROM public.products p
      LEFT JOIN public.brands b
        ON b.id = p.brand_id
      LEFT JOIN public.categories c
        ON c.id = p.category_id

      LEFT JOIN LATERAL (
        SELECT
          o.price,
          o.currency,
          s.name AS store_name
        FROM public.offers o
        LEFT JOIN public.stores s
          ON s.id = o.store_id
        WHERE o.product_id = p.id
          AND o.price IS NOT NULL
        ORDER BY o.price ASC
        LIMIT 1
      ) best ON TRUE

      WHERE p.id = ANY($1::bigint[])
      `,
      [ids.map(Number)]
    );

    if (result.rows.length !== ids.length) {
      return res.status(404).json({
        error:
          "One or more selected products are missing"
      });
    }

    res.json({
      count: result.rows.length,
      products: result.rows
    });
  })
);

// =====================================
// GROCERY SEARCH
// =====================================

app.get(
  "/api/external/food/search",
  route(async (req, res) => {
    const term = String(req.query.q || "").trim();

    if (!term) {
      return res.status(400).json({
        error: "Enter a grocery product name"
      });
    }

    const products = await food.searchProducts(term);

    res.json({
      success: true,
      count: products.length,
      products
    });
  })
);

// =====================================
// BEAUTY SEARCH
// =====================================

app.get(
  "/api/external/beauty/search",
  route(async (req, res) => {
    const term = String(req.query.q || "").trim();

    if (!term) {
      return res.status(400).json({
        error: "Enter a beauty product name"
      });
    }

    const products = await beauty.searchProducts(term);

    res.json({
      success: true,
      count: products.length,
      products
    });
  })
);

// =====================================
// ELECTRONICS SEARCH
// =====================================

app.get(
  "/api/external/lebtech/search",
  route(async (req, res) => {
    const term = String(req.query.q || "").trim();

    if (term.length < 2 || term.length > 100) {
      return res.status(400).json({
        error: "Enter 2-100 characters"
      });
    }

    const products =
      await electronics.searchProducts(term);

    res.json({
      success: true,
      market: "Lebanon",
      currency: "USD",
      count: products.length,
      products
    });
  })
);

// =====================================
// LIVE ELECTRONICS STORE PRICES
// READ-ONLY ENDPOINT
// =====================================

app.get(
  "/api/external/lebtech/prices",
  route(async (req, res) => {
    const product = String(
      req.query.product || ""
    ).trim();

    if (!product || product.length > 500) {
      return res.status(400).json({
        error: "Product reference required"
      });
    }

    const offers =
      await electronics.getProductPrices(product);

    res.json({
      success: true,
      market: "Lebanon",
      currency: "USD",
      count: offers.length,
      offers
    });
  })
);

// =====================================
// RECORD NEW OR CHANGED RETAILER PRICES
// =====================================

app.post(
  "/api/track/lebtech",
  route(async (req, res) => {
    const result = await tracker.trackProduct(
      req.body?.product,
      req.body?.categorySlug
    );

    res.json({
      success: true,
      ...result
    });
  })
);

// =====================================
// AUTOMOTIVE SEARCH
// =====================================

app.get(
  "/api/external/automotive/search",
  route(async (req, res) => {
    const term = String(req.query.q || "").trim();

    if (term.length < 2 || term.length > 100) {
      return res.status(400).json({
        error: "Enter 2-100 characters"
      });
    }

    const products =
      await automotive.searchProducts(term);

    res.json({
      success: true,
      market: "Saudi Arabia",
      currency: "SAR",
      count: products.length,
      products
    });
  })
);

// =====================================
// AUTOMOTIVE PART DETAILS
// =====================================

app.get(
  "/api/external/automotive/part/:oem",
  route(async (req, res) => {
    const product =
      await automotive.getPartByOEM(req.params.oem);

    if (!product) {
      return res.status(404).json({
        error: "Part not found"
      });
    }

    res.json({
      success: true,
      market: "Saudi Arabia",
      currency: "SAR",
      product
    });
  })
);

// =====================================
// GET AND SAVE GROCERY BY BARCODE
// =====================================

app.get(
  "/api/external/food/:barcode",
  route(async (req, res) => {
    const product = await food.getProductByBarcode(
      req.params.barcode
    );

    if (!product) {
      return res.status(404).json({
        error: "Product not found"
      });
    }

    const saved =
      await repository.saveExternalProduct(
        product,
        "groceries-food"
      );

    res.json({
      success: true,
      product: saved,
      message: "Product saved"
    });
  })
);

// =====================================
// GET AND SAVE BEAUTY BY BARCODE
// =====================================

app.get(
  "/api/external/beauty/:barcode",
  route(async (req, res) => {
    const product = await beauty.getProductByBarcode(
      req.params.barcode
    );

    if (!product) {
      return res.status(404).json({
        error: "Product not found"
      });
    }

    const saved =
      await repository.saveExternalProduct(
        product,
        "beauty-personal-care"
      );

    res.json({
      success: true,
      product: saved,
      message: "Product saved"
    });
  })
);

// =====================================
// ERROR HANDLING
// =====================================

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found"
  });
});

app.use((error, req, res, next) => {
  console.error("Knowly API error:", error);

  const status =
    error.status ||
    (error.code === "22P02" ? 400 : 502);

  res.status(status).json({
    success: false,
    error: status === 400
      ? error.message
      : "Request failed; see backend terminal for details"
  });
});

// =====================================
// START SERVER
// =====================================

app.listen(PORT, () => {
  console.log(
    `Knowly backend running at http://localhost:${PORT}`
  );
});
