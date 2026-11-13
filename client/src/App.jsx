
import { useEffect, useRef, useState } from "react";
import "./App.css";

const API = "http://localhost:4000/api";

const overlay = {
  position: "fixed",
  inset: 0,
  zIndex: 10000,
  background: "rgba(0,0,0,0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16
};

const modalBox = {
  background: "white",
  color: "#1f2937",
  borderRadius: 16,
  padding: 24,
  width: "100%",
  maxWidth: 900,
  maxHeight: "88vh",
  overflowY: "auto"
};

function showPrice(value, currency = "USD") {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "Price unavailable";
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "Price unavailable";
  }

  return `${currency || "USD"} ${number.toLocaleString(
    "en-US",
    { maximumFractionDigits: 2 }
  )}`;
}

function getSpecs(value) {
  if (!value) return {};

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }

  return typeof value === "object" &&
    !Array.isArray(value)
    ? value
    : {};
}

function display(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "-";
  }

  return typeof value === "object"
    ? JSON.stringify(value)
    : String(value);
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30000),
    ...options
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error || "Request failed"
    );
  }

  return data;
}

function Modal({ title, onClose, children }) {
  return (
    <div style={overlay}>
      <section
        style={modalBox}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center"
          }}
        >
          <h2>{title}</h2>

          <button type="button" onClick={onClose}>
            Close ✕
          </button>
        </div>

        {children}
      </section>
    </div>
  );
}

export default function App() {
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [category, setCategory] = useState("");
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState("");

  const [savedProducts, setSavedProducts] = useState({});
  const [tracked, setTracked] = useState({});

  const [stores, setStores] = useState(null);
  const [part, setPart] = useState(null);
  const [details, setDetails] = useState(null);

  const [picked, setPicked] = useState([]);
  const [comparison, setComparison] = useState(null);

  const searchVersion = useRef(0);
  const popupVersion = useRef(0);

  const electronicsCategory =
    category === "electronics" ||
    category === "computers-accessories";

  // =====================================
  // LOAD CATEGORIES
  // =====================================

  useEffect(() => {
    apiRequest(`${API}/categories`)
      .then(data => {
        setCategories(
          (data.categories || []).filter(
            item => item.parent_id === null
          )
        );
      })
      .catch(err => setError(err.message));
  }, []);

  // =====================================
  // LOAD SAVED PRODUCTS
  // =====================================

  useEffect(() => {
    if (submitted) return;

    let active = true;
    setLoading(true);

    const params = new URLSearchParams();

    if (category) {
      params.set("category", category);
    }

    apiRequest(`${API}/products?${params}`)
      .then(data => {
        if (active) {
          setProducts(data.products || []);
        }
      })
      .catch(err => {
        if (active) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [category, submitted]);

  // =====================================
  // SEARCH PRODUCTS
  // =====================================

  async function runSearch(event) {
    event.preventDefault();

    const term = search.trim();
    const version = ++searchVersion.current;

    ++popupVersion.current;

    setError("");
    setNotice("");
    setStores(null);
    setPart(null);
    setDetails(null);
    setPicked([]);
    setComparison(null);

    if (!term) {
      setSubmitted("");
      setProducts([]);
      return;
    }

    setSubmitted(term);
    setProducts([]);
    setLoading(true);

    const params = new URLSearchParams({
      search: term
    });

    if (category) {
      params.set("category", category);
    }

    const localUrl = `${API}/products?${params}`;
    let liveUrl = localUrl;

    if (category === "groceries-food") {
      liveUrl =
        `${API}/external/food/search?q=` +
        encodeURIComponent(term);
    } else if (category === "beauty-personal-care") {
      liveUrl =
        `${API}/external/beauty/search?q=` +
        encodeURIComponent(term);
    } else if (electronicsCategory) {
      liveUrl =
        `${API}/external/lebtech/search?q=` +
        encodeURIComponent(term);
    } else if (category === "automotive") {
      liveUrl =
        `${API}/external/automotive/search?q=` +
        encodeURIComponent(term);
    }

    try {
      let result;

      try {
        result = await apiRequest(liveUrl);
      } catch (liveError) {
        if (liveUrl === localUrl) {
          throw liveError;
        }

        result = await apiRequest(localUrl);

        if (version === searchVersion.current) {
          setNotice(
            "Live results are unavailable. " +
            "Showing products already saved in Knowly."
          );
        }
      }

      if (version === searchVersion.current) {
        setProducts(result.products || []);
      }
    } catch (err) {
      if (version === searchVersion.current) {
        setError(err.message);
      }
    } finally {
      if (version === searchVersion.current) {
        setLoading(false);
      }
    }
  }

  // =====================================
  // CHANGE CATEGORY
  // =====================================

  function chooseCategory(slug) {
    ++searchVersion.current;
    ++popupVersion.current;

    setCategory(slug);
    setSearch("");
    setSubmitted("");

    setProducts([]);
    setLoading(false);
    setError("");
    setNotice("");

    setStores(null);
    setPart(null);
    setDetails(null);

    setPicked([]);
    setComparison(null);
  }

  // =====================================
  // SAVE GROCERY OR BEAUTY
  // =====================================

  async function saveFactsProduct(product) {
    const type =
      product.source === "Open Beauty Facts"
        ? "beauty"
        : "food";

    const key = `${type}:${product.barcode}`;

    setSaving(key);
    setError("");

    try {
      const data = await apiRequest(
        `${API}/external/${type}/` +
        encodeURIComponent(product.barcode)
      );

      setSavedProducts(previous => ({
        ...previous,
        [key]: data.product
      }));

      setNotice(
        `${product.name} saved to Knowly.`
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving("");
    }
  }

  // =====================================
  // ELECTRONICS PRICE TRACKING
  // =====================================

  async function openStorePrices(product) {
    const version = ++popupVersion.current;

    setStores({
      product,
      loading: true,
      offers: [],
      history: [],
      stats: null,
      warning: "",
      error: ""
    });

    setError("");

    try {
      // Save offers and record price changes.
      const result = await apiRequest(
        `${API}/track/lebtech`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            product: {
              externalId: product.externalId,
              name: product.name,
              brand: product.brand,
              category: product.category,
              image: product.image,
              productUrl: product.productUrl
            },
            categorySlug: category
          })
        }
      );

      if (version !== popupVersion.current) {
        return;
      }

      setTracked(previous => ({
        ...previous,
        [product.externalId]: result.productId
      }));

      setStores({
        product,
        loading: false,
        offers: result.offers || [],
        history: result.history || [],
        stats: result.stats || null,
        warning: "",
        error: ""
      });
    } catch (trackingError) {
      // Display live prices even if saving fails.
      try {
        const reference =
          product.externalId || product.productUrl;

        if (!reference) {
          throw trackingError;
        }

        const live = await apiRequest(
          `${API}/external/lebtech/prices?product=` +
          encodeURIComponent(reference)
        );

        if (version !== popupVersion.current) {
          return;
        }

        setStores({
          product,
          loading: false,
          offers: live.offers || [],
          history: [],
          stats: null,
          error: "",
          warning:
            "Live prices loaded, but the database " +
            "could not save the price history. " +
            "Check your backend terminal."
        });
      } catch (err) {
        if (version !== popupVersion.current) {
          return;
        }

        setStores({
          product,
          loading: false,
          offers: [],
          history: [],
          stats: null,
          warning: "",
          error: err.message
        });
      }
    }
  }

  // =====================================
  // AUTOMOTIVE PART DETAILS
  // =====================================

  async function openPartDetails(product) {
    const version = ++popupVersion.current;

    setPart({
      product,
      loading: Boolean(product.oem),
      error: ""
    });

    if (!product.oem) return;

    try {
      const data = await apiRequest(
        `${API}/external/automotive/part/` +
        encodeURIComponent(product.oem)
      );

      if (version === popupVersion.current) {
        setPart({
          product: {
            ...product,
            ...data.product
          },
          loading: false,
          error: ""
        });
      }
    } catch {
      if (version === popupVersion.current) {
        setPart({
          product,
          loading: false,
          error:
            "Additional details are not available."
        });
      }
    }
  }

  // =====================================
  // SAVED PRODUCT DETAILS
  // =====================================

  async function openDetails(id) {
    try {
      const [product, offers] = await Promise.all([
        apiRequest(`${API}/products/${id}`),
        apiRequest(`${API}/products/${id}/offers`)
      ]);

      setDetails({
        ...product,
        offers: offers.offers || []
      });
    } catch (err) {
      setError(err.message);
    }
  }

  // =====================================
  // SELECT PRODUCTS FOR COMPARISON
  // =====================================

  function togglePick(id) {
    const key = String(id);

    if (picked.includes(key)) {
      setPicked(
        picked.filter(item => item !== key)
      );
    } else if (picked.length < 3) {
      setPicked([
        ...picked,
        key
      ]);
    } else {
      setError(
        "Choose up to 3 products for comparison."
      );
    }

    setComparison(null);
  }

  // =====================================
  // COMPARE SAVED PRODUCTS
  // =====================================

  async function showComparison() {
    try {
      const data = await apiRequest(
        `${API}/compare`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            ids: picked
          })
        }
      );

      setComparison(data.products || []);
    } catch (err) {
      setError(err.message);
    }
  }

  const specKeys = comparison
    ? [
        ...new Set(
          comparison.flatMap(item =>
            Object.keys(
              getSpecs(item.specifications)
            )
          )
        )
      ]
    : [];

  // =====================================
  // WEBSITE
  // =====================================

  return (
    <div className="page">

      <h1>Knowly</h1>

      <h2 className="tagline">
        Know More. Buy Smarter.
      </h2>

      <p className="steps">
        Discover · Compare · Decide
      </p>

      {/* SEARCH */}

      <form onSubmit={runSearch}>
        <input
          type="text"
          value={search}
          onChange={event =>
            setSearch(event.target.value)
          }
          placeholder="Search products, brands, models or part numbers..."
        />

        <button type="submit" disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {/* CATEGORIES */}

      <div className="categories">

        <button
          className={!category ? "active" : ""}
          onClick={() => chooseCategory("")}
        >
          All Categories
        </button>

        {categories.map(item => (
          <button
            key={item.id}
            className={
              category === item.slug
                ? "active"
                : ""
            }
            onClick={() =>
              chooseCategory(item.slug)
            }
          >
            {item.name}
          </button>
        ))}

      </div>

      {/* MESSAGES */}

      {error && (
        <p className="error-message">
          {error}
        </p>
      )}

      {notice && (
        <p className="steps">
          {notice}
        </p>
      )}

      {category === "automotive" && (
        <p className="steps">
          Automotive prices are in SAR for Saudi Arabia,
          not Lebanon. Confirm part compatibility before
          purchasing.
        </p>
      )}

      {/* PRODUCT RESULTS */}

      <div className="list">

        {loading && (
          <p>Searching products...</p>
        )}

        {!loading && products.length === 0 && (
          <p>
            No products found. Try another search.
          </p>
        )}

        {!loading && products.map((product, index) => {
          const electronics =
            product.source === "LebTech";

          const automotive =
            product.source === "Automotive";

          const externalFacts = [
            "Open Food Facts",
            "Open Beauty Facts"
          ].includes(product.source);

          const type =
            product.source === "Open Beauty Facts"
              ? "beauty"
              : "food";

          const factsKey =
            `${type}:${product.barcode}`;

          const saved =
            savedProducts[factsKey];

          const id = electronics
            ? tracked[product.externalId]
            : (saved?.id || product.id);

          const key = electronics
            ? product.externalId || index
            : automotive
              ? product.oem || index
              : externalFacts
                ? factsKey
                : product.id;

          return (
            <div className="card" key={key}>

              {(product.image || product.image_url) && (
                <img
                  className="product-image"
                  src={
                    product.image ||
                    product.image_url
                  }
                  alt={product.name}
                />
              )}

              <div className="product-info">

                <small>
                  {product.brand ||
                    product.brand_name ||
                    "Brand not specified"}
                </small>

                <h3>{product.name}</h3>

                {product.quantity && (
                  <p>{product.quantity}</p>
                )}

                <p className="category-name">
                  {product.category_name ||
                    product.category ||
                    ""}
                </p>

                {electronics && (
                  <>
                    <p className="price">
                      {product.minPrice != null
                        ? `From ${showPrice(product.minPrice)}`
                        : "Price unavailable"}
                    </p>

                    <small>
                      Compare prices from Lebanese stores
                    </small>
                  </>
                )}

                {automotive && (
                  <>
                    {product.oem && (
                      <p>
                        Part number: {product.oem}
                      </p>
                    )}

                    {product.grade && (
                      <p>
                        Type: {product.grade}
                      </p>
                    )}

                    <p className="price">
                      {showPrice(product.price, "SAR")}
                    </p>

                    <small>
                      Saudi Arabia listing
                    </small>
                  </>
                )}

              </div>

              {/* ACTIONS */}

              <div>

                {electronics ? (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        openStorePrices(product)
                      }
                    >
                      Compare Store Prices
                    </button>

                    {id && (
                      <p>
                        <label>
                          <input
                            type="checkbox"
                            checked={picked.includes(String(id))}
                            onChange={() =>
                              togglePick(id)
                            }
                          />
                          {" "}Compare product
                        </label>
                      </p>
                    )}

                    {product.productUrl && (
                      <p>
                        <a
                          href={product.productUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View Product Listing
                        </a>
                      </p>
                    )}
                  </>

                ) : automotive ? (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        openPartDetails(product)
                      }
                    >
                      View Part Details
                    </button>

                    {product.productUrl && (
                      <p>
                        <a
                          href={product.productUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View Product Listing
                        </a>
                      </p>
                    )}
                  </>

                ) : externalFacts && !saved ? (
                  <button
                    type="button"
                    disabled={saving === factsKey}
                    onClick={() =>
                      saveFactsProduct(product)
                    }
                  >
                    {saving === factsKey
                      ? "Saving..."
                      : "Save to Knowly"}
                  </button>

                ) : id ? (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={picked.includes(String(id))}
                        onChange={() =>
                          togglePick(id)
                        }
                      />
                      {" "}Compare
                    </label>

                    <button
                      type="button"
                      onClick={() =>
                        openDetails(id)
                      }
                    >
                      Details
                    </button>
                  </>

                ) : null}

              </div>

            </div>
          );
        })}

      </div>

      {/* COMPARE BUTTON */}

      {picked.length >= 2 && (
        <button
          className="compare-btn"
          onClick={showComparison}
        >
          Compare {picked.length} Products
        </button>
      )}

      {/* =====================================
          STORE PRICE COMPARISON + HISTORY
          ===================================== */}

      {stores && (
        <Modal
          title="Store Price Comparison"
          onClose={() => {
            ++popupVersion.current;
            setStores(null);
          }}
        >
          <h3>{stores.product.name}</h3>

          {stores.loading && (
            <p>
              Checking retailer offers
              and recording prices...
            </p>
          )}

          {stores.error && (
            <p className="error-message">
              {stores.error}
            </p>
          )}

          {stores.warning && (
            <p className="steps">
              {stores.warning}
            </p>
          )}

          {!stores.loading && !stores.error && (
            <>

              {stores.offers.length ? (
                <div style={{ overflowX: "auto" }}>

                  <table style={{ width: "100%" }}>
                    <thead>
                      <tr>
                        <th>Store</th>
                        <th>Price</th>
                        <th>Condition</th>
                        <th>Link</th>
                      </tr>
                    </thead>

                    <tbody>
                      {stores.offers.map((offer, i) => (
                        <tr key={i}>
                          <td>
                            {offer.storeName || "Store"}
                          </td>

                          <td>
                            {showPrice(
                              offer.price,
                              offer.currency || "USD"
                            )}
                          </td>

                          <td>
                            {offer.condition ||
                              "Not specified"}
                          </td>

                          <td>
                            {offer.url ? (
                              <a
                                href={offer.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Visit Store
                              </a>
                            ) : (
                              "-"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                </div>
              ) : (
                <p>
                  No store offers were returned
                  for this configuration.
                </p>
              )}

              {/* TRACKING STATISTICS */}

              {stores.stats && (
                <p className="steps">
                  {stores.stats.offersTracked} offers recorded
                  {" · "}
                  {stores.stats.newOffers} new
                  {" · "}
                  {stores.stats.priceChanges} changed prices
                </p>
              )}

              {/* PRICE HISTORY */}

              {stores.stats && (
                <>
                  <h3>Recorded Price History</h3>

                  {stores.history.length ? (
                    <div style={{ overflowX: "auto" }}>

                      <table style={{ width: "100%" }}>
                        <thead>
                          <tr>
                            <th>Recorded</th>
                            <th>Store</th>
                            <th>Price</th>
                            <th>Condition</th>
                          </tr>
                        </thead>

                        <tbody>
                          {stores.history.slice(0, 30).map(row => (
                            <tr key={row.id}>
                              <td>
                                {new Date(
                                  row.recorded_at
                                ).toLocaleString()}
                              </td>

                              <td>
                                {row.store_name || "Store"}
                              </td>

                              <td>
                                {showPrice(
                                  row.price,
                                  row.currency
                                )}
                              </td>

                              <td>
                                {row.condition || "-"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                    </div>
                  ) : (
                    <p>
                      No price observations
                      have been recorded yet.
                    </p>
                  )}
                </>
              )}

            </>
          )}

          <small>
            Prices and stock can change.
            Check details directly with the store.
          </small>

        </Modal>
      )}

      {/* AUTOMOTIVE DETAILS */}

      {part && (
        <Modal
          title="Automotive Part Details"
          onClose={() => {
            ++popupVersion.current;
            setPart(null);
          }}
        >
          <h3>{part.product.name}</h3>

          {part.loading && (
            <p>Loading additional information...</p>
          )}

          {part.error && (
            <p>{part.error}</p>
          )}

          <p>
            Part number:
            {" "}
            {part.product.oem || "Unavailable"}
          </p>

          <p>
            Type:
            {" "}
            {part.product.grade || "Not specified"}
          </p>

          <p>
            {showPrice(part.product.price, "SAR")}
          </p>

          <pre style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify(
              getSpecs(part.product.specifications),
              null,
              2
            )}
          </pre>

          <p>
            Saudi Arabian listing.
            Verify vehicle compatibility.
          </p>
        </Modal>
      )}

      {/* SAVED PRODUCT DETAILS */}

      {details && (
        <Modal
          title="Product Details"
          onClose={() =>
            setDetails(null)
          }
        >
          <h3>{details.name}</h3>

          <p>
            Brand: {details.brand_name || "Unknown"}
          </p>

          <p>
            {details.description ||
              "No description available"}
          </p>

          <h3>Specifications</h3>

          <pre style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify(
              getSpecs(details.specifications),
              null,
              2
            )}
          </pre>

          <h3>Saved Store Offers</h3>

          {details.offers.length ? (
            details.offers.map(offer => (
              <p key={offer.id}>
                {offer.store_name || "Store"}:
                {" "}
                {showPrice(
                  offer.price,
                  offer.currency
                )}
              </p>
            ))
          ) : (
            <p>No saved store offers.</p>
          )}
        </Modal>
      )}

      {/* SAVED PRODUCT COMPARISON */}

      {comparison && (
        <Modal
          title="Product Comparison"
          onClose={() =>
            setComparison(null)
          }
        >
          <div style={{ overflowX: "auto" }}>

            <table>
              <thead>
                <tr>
                  <th>Feature</th>

                  {comparison.map(p => (
                    <th key={p.id}>
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>

                <tr>
                  <td>Brand</td>

                  {comparison.map(p => (
                    <td key={p.id}>
                      {p.brand_name || "-"}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td>Category</td>

                  {comparison.map(p => (
                    <td key={p.id}>
                      {p.category_name || "-"}
                    </td>
                  ))}
                </tr>

                <tr>
                  <td>Best saved store price</td>

                  {comparison.map(p => (
                    <td key={p.id}>
                      {p.best_price != null
                        ? (
                            showPrice(
                              p.best_price,
                              p.best_currency
                            ) +
                            (
                              p.best_store
                                ? ` · ${p.best_store}`
                                : ""
                            )
                          )
                        : "No verified offer"}
                    </td>
                  ))}
                </tr>

                {specKeys.map(key => (
                  <tr key={key}>
                    <td>{key}</td>

                    {comparison.map(p => (
                      <td key={p.id}>
                        {display(
                          getSpecs(p.specifications)[key]
                        )}
                      </td>
                    ))}
                  </tr>
                ))}

              </tbody>
            </table>

          </div>

          <small>
            Prices from different markets or currencies
            should not be compared directly.
          </small>
        </Modal>
      )}

    </div>
  );
}
