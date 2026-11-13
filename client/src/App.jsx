import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const API = "http://localhost:4000/api";
const MAIN_CATEGORIES = [
  { slug: "", name: "All products", symbol: "✦" },
  { slug: "electronics", name: "Electronics", symbol: "◈" },
  { slug: "computers-accessories", name: "Computers", symbol: "▣" },
  { slug: "groceries-food", name: "Groceries", symbol: "◉" },
  { slug: "beauty-personal-care", name: "Beauty", symbol: "✿" },
  { slug: "automotive", name: "Automotive", symbol: "◇" },
];
const PRICED_CATEGORIES = new Set(["electronics", "computers-accessories", "automotive"]);

async function getJSON(url, options = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(35000),
    ...options,
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Server returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(result.error || `Request failed (HTTP ${response.status}).`);
  }
  return result;
}

function formatPrice(value, currency = "USD") {
  if (value === null || value === undefined || value === "") return "Not listed";
  const n = Number(value);
  if (!Number.isFinite(n)) return "Not listed";
  return `${currency || "USD"} ${n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

function numericPrice(product) {
  const value = product.minPrice ?? product.price ?? product.best_price;
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function productBrand(product) {
  return String(product.brand || product.brand_name || "Unspecified brand").trim();
}

function productSpecs(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return typeof value === "object" && !Array.isArray(value) ? value : {};
}

function displayValue(value) {
  if (value == null || value === "") return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function externalURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

function icon(name, size = 20) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  if (name === "search") return <svg {...common}><circle cx="10.8" cy="10.8" r="6.6"/><path d="m16 16 5 5"/></svg>;
  if (name === "filter") return <svg {...common}><path d="M4 6h16M7 12h10M10 18h4"/></svg>;
  if (name === "arrow") return <svg {...common}><path d="M5 12h14m-6-6 6 6-6 6"/></svg>;
  if (name === "close") return <svg {...common}><path d="M5 5l14 14M19 5 5 19"/></svg>;
  if (name === "compare") return <svg {...common}><path d="M5 4v16m14-16v16M9 8h7m-7 8h7m-3-3 3 3-3 3m0-14 3 3-3 3"/></svg>;
  if (name === "tag") return <svg {...common}><path d="M3 12V4h8l10 10-7 7L3 12Z"/><circle cx="7.7" cy="8" r="1"/></svg>;
  if (name === "history") return <svg {...common}><path d="M3 11a9 9 0 1 1 2.8 6.5M3 4v7h7m2-4v5l3.5 2"/></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/></svg>;
}

function ProductImage({ product, className = "" }) {
  const [failed, setFailed] = useState(false);
  const src = product.image || product.image_url;
  if (!src || failed) {
    return <div className={`kn-image kn-image-empty ${className}`}><span>KN</span><small>Product image</small></div>;
  }
  return <div className={`kn-image ${className}`}><img src={src} alt={product.name || "Product"} loading="lazy" onError={() => setFailed(true)} /></div>;
}

function Modal({ title, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="kn-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={`kn-modal ${wide ? "kn-modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="kn-modal-header"><h2>{title}</h2><button className="kn-icon-button" type="button" aria-label="Close" onClick={onClose}>{icon("close")}</button></header>
        <div className="kn-modal-body">{children}</div>
      </section>
    </div>
  );
}

function Specifications({ value }) {
  const entries = Object.entries(productSpecs(value));
  if (!entries.length) return <p className="kn-muted">No additional specifications available.</p>;
  return <div className="kn-spec-list">{entries.map(([key, val]) => <div key={key}><span>{key.replaceAll("_", " ")}</span><strong>{displayValue(val)}</strong></div>)}</div>;
}

export default function App() {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [brandFilter, setBrandFilter] = useState("all");
  const [sort, setSort] = useState("relevance");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [savedFacts, setSavedFacts] = useState({});
  const [tracked, setTracked] = useState({});
  const [savingKey, setSavingKey] = useState("");
  const [storeModal, setStoreModal] = useState(null);
  const [partModal, setPartModal] = useState(null);
  const [detailModal, setDetailModal] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [comparison, setComparison] = useState(null);
  const searchSerial = useRef(0);
  const modalSerial = useRef(0);

  const isElectronics = ["electronics", "computers-accessories"].includes(activeCategory);
  const isPriceCategory = PRICED_CATEGORIES.has(activeCategory);

  async function loadProducts(category, term = "") {
    const serial = ++searchSerial.current;
    setLoading(true);
    setError("");
    setNotice("");
    setProducts([]);
    const params = new URLSearchParams();
    if (term) params.set("search", term);
    if (category) params.set("category", category);
    const localURL = `${API}/products?${params.toString()}`;
    let liveURL = localURL;
    if (term && category === "groceries-food") liveURL = `${API}/external/food/search?q=${encodeURIComponent(term)}`;
    if (term && category === "beauty-personal-care") liveURL = `${API}/external/beauty/search?q=${encodeURIComponent(term)}`;
    if (term && ["electronics", "computers-accessories"].includes(category)) liveURL = `${API}/external/lebtech/search?q=${encodeURIComponent(term)}`;
    if (term && category === "automotive") liveURL = `${API}/external/automotive/search?q=${encodeURIComponent(term)}`;
    try {
      let response;
      try {
        response = await getJSON(liveURL);
      } catch (liveError) {
        if (liveURL === localURL) throw liveError;
        response = await getJSON(localURL);
        if (serial === searchSerial.current) setNotice("Live results are temporarily unavailable. These are products previously saved in Knowly.");
      }
      if (serial === searchSerial.current) setProducts(response.products || []);
    } catch (err) {
      if (serial === searchSerial.current) setError(err.message);
    } finally {
      if (serial === searchSerial.current) setLoading(false);
    }
  }

  useEffect(() => {
    getJSON(`${API}/categories`).then(data => setCategories(data.categories || [])).catch(() => {});
    loadProducts("", "");
    // Initial load only; subsequent searches run on submission or category selection.
  }, []);

  function changeCategory(slug) {
    ++modalSerial.current;
    setActiveCategory(slug);
    setQuery("");
    setSubmittedQuery("");
    setBrandFilter("all");
    setSort("relevance");
    setMinPrice("");
    setMaxPrice("");
    setSelectedIds([]);
    setComparison(null);
    setStoreModal(null);
    setPartModal(null);
    setDetailModal(null);
    loadProducts(slug, "");
  }

  function submitSearch(event) {
    event.preventDefault();
    const term = query.trim();
    setSubmittedQuery(term);
    setBrandFilter("all");
    setSort("relevance");
    setMinPrice("");
    setMaxPrice("");
    setSelectedIds([]);
    setComparison(null);
    loadProducts(activeCategory, term);
  }

  const brandOptions = useMemo(() => [...new Set(products.map(productBrand))].sort((a,b) => a.localeCompare(b)), [products]);
  const hasPrices = products.some(p => numericPrice(p) !== null);
  const currency = activeCategory === "automotive" ? "SAR" : "USD";

  const filteredProducts = useMemo(() => {
    const min = minPrice === "" ? null : Number(minPrice);
    const max = maxPrice === "" ? null : Number(maxPrice);
    const filtered = products.filter(p => {
      if (brandFilter !== "all" && productBrand(p) !== brandFilter) return false;
      if (isPriceCategory && (min !== null || max !== null)) {
        const pPrice = numericPrice(p);
        if (pPrice === null) return false;
        if (min !== null && Number.isFinite(min) && pPrice < min) return false;
        if (max !== null && Number.isFinite(max) && pPrice > max) return false;
      }
      return true;
    });
    if (sort === "name") return filtered.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (sort === "price-asc" || sort === "price-desc") {
      return filtered.sort((a,b) => {
        const pa = numericPrice(a), pb = numericPrice(b);
        if (pa === null) return 1;
        if (pb === null) return -1;
        return sort === "price-asc" ? pa - pb : pb - pa;
      });
    }
    return filtered;
  }, [products, brandFilter, sort, minPrice, maxPrice, isPriceCategory]);

  function clearFilters() {
    setBrandFilter("all");
    setMinPrice("");
    setMaxPrice("");
    setSort("relevance");
  }

  async function saveProduct(product) {
    if (!product.barcode) { setError("This product has no barcode and cannot be saved yet."); return; }
    const type = String(product.source).toLowerCase() === "open beauty facts" ? "beauty" : "food";
    const key = `${type}:${product.barcode}`;
    setSavingKey(key);
    setError("");
    try {
      const data = await getJSON(`${API}/external/${type}/${encodeURIComponent(product.barcode)}`);
      setSavedFacts(prev => ({ ...prev, [key]: data.product }));
      setNotice(`${product.name} was saved. You can now select it for comparison.`);
    } catch (err) { setError(err.message); }
    finally { setSavingKey(""); }
  }

  async function openStorePrices(product) {
    const serial = ++modalSerial.current;
    setStoreModal({ product, loading: true, offers: [], history: [], warning: "", error: "", stats: null });
    const body = {
      product: {
        externalId: product.externalId,
        name: product.name,
        brand: product.brand,
        category: product.category,
        image: product.image,
        productUrl: product.productUrl,
      },
      categorySlug: activeCategory,
    };
    try {
      const data = await getJSON(`${API}/track/lebtech`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (serial !== modalSerial.current) return;
      if (data.productId) setTracked(prev => ({ ...prev, [product.externalId]: data.productId }));
      setStoreModal({ product, loading: false, offers: data.offers || [], history: data.history || [], warning: data.warning || "", error: "", stats: data.stats || null });
    } catch (err) {
      if (serial !== modalSerial.current) return;
      // Deliberately do NOT immediately retry a rate-limited provider.
      setStoreModal({ product, loading: false, offers: [], history: [], warning: "", error: err.message, stats: null });
    }
  }

  async function openPart(product) {
    const serial = ++modalSerial.current;
    setPartModal({ product, loading: Boolean(product.oem), error: "" });
    if (!product.oem) return;
    try {
      const result = await getJSON(`${API}/external/automotive/part/${encodeURIComponent(product.oem)}`);
      if (serial === modalSerial.current) setPartModal({ product: { ...product, ...(result.product || {}) }, loading: false, error: "" });
    } catch {
      if (serial === modalSerial.current) setPartModal({ product, loading: false, error: "Additional part details are temporarily unavailable." });
    }
  }

  async function openDetails(id) {
    const serial = ++modalSerial.current;
    setDetailModal({ loading: true });
    try {
      const [product, response] = await Promise.all([
        getJSON(`${API}/products/${id}`),
        getJSON(`${API}/products/${id}/offers`),
      ]);
      if (serial === modalSerial.current) setDetailModal({ ...product, offers: response.offers || [], loading: false });
    } catch (err) {
      if (serial === modalSerial.current) setDetailModal({ loading: false, error: err.message });
    }
  }

  function toggleCompare(id) {
    const value = String(id);
    if (selectedIds.includes(value)) {
      setSelectedIds(prev => prev.filter(x => x !== value));
      setComparison(null);
    } else if (selectedIds.length < 3) {
      setSelectedIds(prev => [...prev, value]);
      setComparison(null);
    } else {
      setNotice("You can compare up to three products at a time.");
    }
  }

  async function compareProducts() {
    setError("");
    try {
      const result = await getJSON(`${API}/compare`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: selectedIds }),
      });
      setComparison(result.products || []);
    } catch (err) { setError(err.message); }
  }

  function closeStore() { ++modalSerial.current; setStoreModal(null); }
  function closePart() { ++modalSerial.current; setPartModal(null); }
  function closeDetails() { ++modalSerial.current; setDetailModal(null); }

  const currentCategoryName = MAIN_CATEGORIES.find(c => c.slug === activeCategory)?.name || "Products";
  const categoryCounts = categories.filter(c => c.parent_id === null).length;
  const specKeys = comparison ? [...new Set(comparison.flatMap(p => Object.keys(productSpecs(p.specifications))))] : [];
  const comparisonCurrencies = new Set((comparison || []).filter(p => p.best_price != null).map(p => p.best_currency || "USD"));

  return (
    <div className="kn-app">
      <header className="kn-header">
        <div className="kn-shell kn-header-inner">
          <a href="#top" className="kn-brand" aria-label="Knowly homepage"><span className="kn-brand-mark">K</span><span>knowly<span className="kn-brand-dot">.</span></span></a>
          <nav className="kn-nav" aria-label="Main navigation"><a href="#explore">Explore products</a><a href="#how-it-works">How it works</a></nav>
          <div className="kn-header-action"><span className="kn-live-dot" /> Product discovery <span className="kn-header-status">made simple</span></div>
        </div>
      </header>

      <main id="top">
        <section className="kn-hero">
          <div className="kn-shell kn-hero-inner">
            <div className="kn-hero-copy">
              <div className="kn-eyebrow"><span className="kn-eyebrow-star">✦</span> SMARTER PRODUCT DISCOVERY</div>
              <h1>Know more.<br /><span>Choose better.</span></h1>
              <p>Find products, explore their details, and compare real retailer offers—all in one easy place.</p>
              <div className="kn-hero-metrics"><span><b>5</b> product categories</span><span className="kn-metric-separator"/><span><b>1</b> smarter way to shop</span></div>
            </div>
            <div className="kn-hero-art" aria-hidden="true"><div className="kn-orbit kn-orbit-one"/><div className="kn-orbit kn-orbit-two"/><div className="kn-hero-art-card"><span className="kn-art-symbol">✦</span><span>discover</span><strong>compare.</strong><span>decide.</span></div><span className="kn-art-spark kn-art-spark-one">✧</span><span className="kn-art-spark kn-art-spark-two">✦</span></div>
          </div>
        </section>

        <section className="kn-search-area kn-shell" aria-label="Product search">
          <form className="kn-search-form" onSubmit={submitSearch}>
            <span className="kn-search-icon">{icon("search", 24)}</span>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search iPhone, CeraVe, Nutella, brake pads..." aria-label="Search products" />
            <button className="kn-primary-button kn-search-button" type="submit" disabled={loading}>{loading ? "Searching..." : <>Search {icon("arrow", 18)}</>}</button>
          </form>
          <div className="kn-category-pills" role="group" aria-label="Product categories">
            {MAIN_CATEGORIES.map(item => <button key={item.slug || "all"} className={`kn-category-pill ${activeCategory === item.slug ? "is-active" : ""}`} type="button" onClick={() => changeCategory(item.slug)}><span className="kn-pill-symbol">{item.symbol}</span>{item.name}</button>)}
          </div>
        </section>

        <section id="explore" className="kn-shell kn-catalog">
          <div className="kn-section-heading"><div><div className="kn-section-overline">THE CATALOG</div><h2>{submittedQuery ? `Results for “${submittedQuery}”` : currentCategoryName}</h2><p>{loading ? "Finding products..." : `${filteredProducts.length} product${filteredProducts.length === 1 ? "" : "s"} shown`}{categoryCounts ? " · Discover across our five categories" : ""}</p></div><span className="kn-section-badge">Browse & compare <span>✦</span></span></div>

          {error && <div className="kn-notice kn-notice-error" role="alert">{icon("info", 20)}<span>{error}</span><button type="button" aria-label="Dismiss error" onClick={() => setError("")}>{icon("close", 17)}</button></div>}
          {notice && <div className="kn-notice" role="status">{icon("info", 20)}<span>{notice}</span><button type="button" aria-label="Dismiss message" onClick={() => setNotice("")}>{icon("close", 17)}</button></div>}
          {activeCategory === "automotive" && <div className="kn-market-note">Automotive listings are from Saudi Arabia, priced in SAR. Confirm vehicle compatibility and availability before purchasing.</div>}

          <div className="kn-catalog-layout">
            <aside className="kn-filters" aria-label="Product filters">
              <div className="kn-filter-heading"><h3>{icon("filter", 19)} Filters</h3><button type="button" onClick={clearFilters}>Reset</button></div>
              <label className="kn-field-label" htmlFor="kn-brand-filter">Brand</label>
              <select id="kn-brand-filter" value={brandFilter} onChange={e => setBrandFilter(e.target.value)}><option value="all">All brands</option>{brandOptions.map(b => <option value={b} key={b}>{b}</option>)}</select>
              {isPriceCategory && <><div className="kn-filter-divider"/><div className="kn-filter-label-row"><label className="kn-field-label" htmlFor="kn-price-min">Price range</label><span>{currency}</span></div><div className="kn-price-inputs"><input id="kn-price-min" type="number" min="0" placeholder="Min" value={minPrice} onChange={e => setMinPrice(e.target.value)}/><span>–</span><input type="number" min="0" placeholder="Max" aria-label="Maximum price" value={maxPrice} onChange={e => setMaxPrice(e.target.value)}/></div><small className="kn-helper">Only products with listed prices match a price range.</small></>}
              <div className="kn-filter-divider"/><div className="kn-filter-tip"><span>✦</span><strong>Shop with clarity</strong><p>Compare products side by side, then visit the retailer to confirm the final price.</p></div>
            </aside>

            <div className="kn-results">
              <div className="kn-results-toolbar"><span>{loading ? "Loading results" : `${filteredProducts.length} matching products`}</span><div className="kn-sort-wrap"><label htmlFor="kn-sort">Sort by</label><select id="kn-sort" value={sort} onChange={e => setSort(e.target.value)}><option value="relevance">Relevance</option><option value="name">Name A–Z</option>{isPriceCategory && hasPrices && <><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></>}</select></div></div>
              {loading ? <div className="kn-product-grid" aria-label="Loading products">{[1,2,3,4,5,6].map(i => <div className="kn-skeleton" key={i}><div/><span/><span/><span/></div>)}</div> : !filteredProducts.length ? <div className="kn-empty"><div className="kn-empty-symbol">⌕</div><h3>No matching products</h3><p>Try a different search, change the category, or reset your filters.</p><button type="button" className="kn-secondary-button" onClick={clearFilters}>Clear filters</button></div> : <div className="kn-product-grid">
                {filteredProducts.map((product, index) => {
                  const source = String(product.source || "").toLowerCase();
                  const isLiveElectronics = source === "lebtech";
                  const isAuto = source === "automotive";
                  const isFacts = source === "open food facts" || source === "open beauty facts";
                  const factsType = source === "open beauty facts" ? "beauty" : "food";
                  const factKey = `${factsType}:${product.barcode}`;
                  const saved = savedFacts[factKey];
                  const savedId = isLiveElectronics ? tracked[product.externalId] : saved?.id || product.id;
                  const selected = savedId && selectedIds.includes(String(savedId));
                  const pPrice = numericPrice(product);
                  const pCurrency = isAuto ? "SAR" : "USD";
                  const productKey = isLiveElectronics ? `el:${product.externalId || index}` : isAuto ? `au:${product.oem || index}:${index}` : isFacts ? `fact:${factKey}:${index}` : `db:${product.id || index}`;
                  return <article className="kn-product-card" key={productKey}>
                    <div className="kn-product-media"><ProductImage product={product}/><span className="kn-product-type">{isAuto ? "Auto part" : isLiveElectronics ? "Store offers" : "Product"}</span></div>
                    <div className="kn-product-content"><p className="kn-product-brand">{productBrand(product)}</p><h3 title={product.name}>{product.name}</h3>{product.quantity && <p className="kn-product-meta">{product.quantity}</p>}{isAuto && product.oem && <p className="kn-product-meta">Part no. {product.oem}</p>}{isAuto && product.grade && <p className="kn-product-meta">{product.grade}</p>}<div className="kn-product-price">{pPrice !== null ? formatPrice(pPrice, pCurrency) : <span className="kn-price-unknown">Product details available</span>}</div>{isLiveElectronics && <p className="kn-product-caption">{pPrice !== null ? "Starting listed price" : "Check available store prices"}</p>}{isAuto && <p className="kn-product-caption">Saudi Arabian listing</p>}</div>
                    <div className="kn-product-actions">
                      {isLiveElectronics ? <button className="kn-card-button" type="button" onClick={() => openStorePrices(product)}>{icon("tag", 17)} Compare store prices {icon("arrow", 16)}</button> : isAuto ? <button className="kn-card-button" type="button" onClick={() => openPart(product)}>View part details {icon("arrow", 16)}</button> : isFacts && !saved ? <button className="kn-card-button" type="button" disabled={savingKey === factKey} onClick={() => saveProduct(product)}>{savingKey === factKey ? "Saving..." : "Save for comparison"} {icon("arrow", 16)}</button> : <button className="kn-card-button" type="button" onClick={() => openDetails(savedId)}>Product details {icon("arrow", 16)}</button>}
                      {savedId && !isAuto && <label className="kn-compare-checkbox"><input type="checkbox" checked={Boolean(selected)} onChange={() => toggleCompare(savedId)} /><span>{selected ? "Added to comparison" : "Add to comparison"}</span></label>}
                      {!savedId && isLiveElectronics && <p className="kn-save-hint">View store prices first to enable comparison.</p>}
                      {isFacts && saved && <p className="kn-saved-label">✓ Saved to Knowly</p>}
                    </div>
                  </article>;
                })}
              </div>}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="kn-bottom-band"><div className="kn-shell kn-bottom-inner"><div><span className="kn-section-overline">THE KNOWLY WAY</span><h2>Less searching.<br/>More knowing.</h2></div><div className="kn-bottom-steps"><div><span>01</span><strong>Discover</strong><p>Search across product categories.</p></div><div><span>02</span><strong>Compare</strong><p>Explore specs and available store prices.</p></div><div><span>03</span><strong>Decide</strong><p>Visit the seller with more confidence.</p></div></div></div></section>
      </main>
      <footer className="kn-footer"><div className="kn-shell"><span className="kn-brand-footer">knowly<span>.</span></span><p>Know more. Choose better.</p><small>Product information and prices may change. Verify details with the retailer before purchasing.</small></div></footer>

      {selectedIds.length > 0 && <div className="kn-compare-bar"><div className="kn-compare-bar-left">{icon("compare", 23)}<span><b>{selectedIds.length} of 3 products</b><small>{selectedIds.length < 2 ? "Choose one more product to compare" : "Ready to compare side by side"}</small></span></div><div className="kn-compare-bar-actions"><button type="button" className="kn-text-button" onClick={() => {setSelectedIds([]); setComparison(null);}}>Clear</button><button type="button" className="kn-primary-button" disabled={selectedIds.length < 2} onClick={compareProducts}>Compare products {icon("arrow", 17)}</button></div></div>}

      {storeModal && <Modal title="Store price comparison" wide onClose={closeStore}>
        <div className="kn-modal-product"><ProductImage product={storeModal.product}/><div><span className="kn-modal-kicker">LEBANESE RETAILER OFFERS</span><h3>{storeModal.product.name}</h3><p>Compare current listings and recorded observations.</p></div></div>
        {storeModal.loading ? <div className="kn-modal-loading">Checking store prices and saved observations...</div> : <>
          {storeModal.warning && <div className="kn-notice">{icon("info",18)}<span>{storeModal.warning}</span></div>}
          {storeModal.error && <div className="kn-notice kn-notice-error">{icon("info",18)}<span>{storeModal.error}</span></div>}
          {storeModal.offers.length ? <div className="kn-table-wrap"><table className="kn-table"><thead><tr><th>Store</th><th>Listed price</th><th>Condition</th><th>Product</th></tr></thead><tbody>{storeModal.offers.map((offer, i) => <tr key={`${offer.storeName}-${offer.url || i}`}><td><strong>{offer.storeName || "Store"}</strong></td><td className="kn-price-table">{formatPrice(offer.price, offer.currency || "USD")}</td><td>{offer.condition || "Not specified"}</td><td>{externalURL(offer.url) ? <a href={externalURL(offer.url)} target="_blank" rel="noopener noreferrer">View listing ↗</a> : "—"}</td></tr>)}</tbody></table></div> : !storeModal.error && <div className="kn-empty-small">No live or saved store offers are available for this product.</div>}
          {storeModal.stats && <div className="kn-stat-row"><div><strong>{storeModal.stats.offersTracked ?? 0}</strong><span>Store offers tracked</span></div><div><strong>{storeModal.stats.newOffers ?? 0}</strong><span>New offers</span></div><div><strong>{storeModal.stats.priceChanges ?? 0}</strong><span>Price changes</span></div></div>}
          {storeModal.history.length > 0 && <div className="kn-modal-section"><h3>{icon("history",20)} Recorded price history</h3><p className="kn-muted">New records are saved only for a first observation or a price change.</p><div className="kn-table-wrap"><table className="kn-table"><thead><tr><th>Observed on</th><th>Store</th><th>Recorded price</th><th>Condition</th></tr></thead><tbody>{storeModal.history.slice(0, 30).map(row => <tr key={row.id}><td>{new Date(row.recorded_at).toLocaleString()}</td><td>{row.store_name || "Store"}</td><td className="kn-price-table">{formatPrice(row.price, row.currency)}</td><td>{row.condition || "—"}</td></tr>)}</tbody></table></div></div>}
          <p className="kn-disclaimer">Store listings can include different colors, storage sizes, or conditions. Knowly currently records one tracked price per store and condition for each product entry. Always verify the exact configuration and stock with the retailer.</p>
        </>}
      </Modal>}

      {partModal && <Modal title="Automotive part details" onClose={closePart}><div className="kn-modal-product"><ProductImage product={partModal.product}/><div><span className="kn-modal-kicker">SAUDI ARABIA · SAR</span><h3>{partModal.product.name}</h3><p>{formatPrice(partModal.product.price, "SAR")}</p></div></div>{partModal.loading && <p className="kn-muted">Loading additional part details...</p>}{partModal.error && <div className="kn-notice">{partModal.error}</div>}<div className="kn-spec-list"><div><span>OEM / part number</span><strong>{partModal.product.oem || "—"}</strong></div><div><span>Brand</span><strong>{productBrand(partModal.product)}</strong></div><div><span>Classification</span><strong>{partModal.product.grade || "—"}</strong></div></div><h3 className="kn-subheading">Specifications</h3><Specifications value={partModal.product.specifications}/>{externalURL(partModal.product.productUrl) && <a className="kn-modal-link" href={externalURL(partModal.product.productUrl)} target="_blank" rel="noopener noreferrer">View original listing ↗</a>}<p className="kn-disclaimer">Verify compatibility, availability, and final price before purchasing.</p></Modal>}

      {detailModal && <Modal title="Product details" onClose={closeDetails}>{detailModal.loading ? <p className="kn-muted">Loading product information...</p> : detailModal.error ? <div className="kn-notice kn-notice-error">{detailModal.error}</div> : <><div className="kn-modal-product"><ProductImage product={detailModal}/><div><span className="kn-modal-kicker">SAVED PRODUCT</span><h3>{detailModal.name}</h3><p>{productBrand(detailModal)}</p></div></div>{detailModal.description && <p>{detailModal.description}</p>}<h3 className="kn-subheading">Specifications</h3><Specifications value={detailModal.specifications}/><h3 className="kn-subheading">Saved retailer offers</h3>{detailModal.offers?.length ? <div className="kn-table-wrap"><table className="kn-table"><thead><tr><th>Store</th><th>Price</th><th>Condition</th></tr></thead><tbody>{detailModal.offers.map(o => <tr key={o.id}><td>{o.store_name || "Store"}</td><td>{formatPrice(o.price,o.currency)}</td><td>{o.condition || "—"}</td></tr>)}</tbody></table></div> : <p className="kn-muted">No retailer offers saved for this product.</p>}</>}</Modal>}

      {comparison && <Modal title="Side-by-side product comparison" wide onClose={() => setComparison(null)}><p className="kn-muted">Compare product details and available saved store prices. A missing price is not an estimate.</p><div className="kn-table-wrap"><table className="kn-table kn-comparison-table"><thead><tr><th>Feature</th>{comparison.map(p => <th key={p.id}>{p.name}</th>)}</tr></thead><tbody><tr><td>Brand</td>{comparison.map(p => <td key={p.id}>{productBrand(p)}</td>)}</tr><tr><td>Category</td>{comparison.map(p => <td key={p.id}>{p.category_name || "—"}</td>)}</tr><tr><td>Lowest saved offer</td>{comparison.map(p => <td key={p.id}>{p.best_price != null ? <><strong>{formatPrice(p.best_price,p.best_currency)}</strong>{p.best_store && <small className="kn-table-caption">{p.best_store}</small>}</> : "No saved offer"}</td>)}</tr>{specKeys.map(key => <tr key={key}><td>{key.replaceAll("_", " ")}</td>{comparison.map(p => <td key={p.id}>{displayValue(productSpecs(p.specifications)[key])}</td>)}</tr>)}</tbody></table></div>{comparisonCurrencies.size > 1 && <div className="kn-notice">Products have different currencies. Do not directly compare their numerical prices without converting them.</div>}</Modal>}
    </div>
  );
}
