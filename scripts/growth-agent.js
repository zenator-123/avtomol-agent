const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { analyzeHtml, buildContentPlan, buildCompetitiveStrategy, summarizeLeads } = require("../lib/growth-agent");

const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "data", "growth-agent-config.json");
const outputRoot = path.join(root, "growth-output");
const latestJson = path.join(outputRoot, "latest-report.json");
const latestText = path.join(outputRoot, "ПОСЛЕДЕН-ОТЧЕТ.txt");
const latestHtml = path.join(outputRoot, "ПОСЛЕДЕН-ОТЧЕТ.html");

function dateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9а-я_-]+/gi, "-").replace(/^-+|-+$/g, "");
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

async function fetchText(url, timeoutMs = 25000) {
  const started = Date.now();
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "AvtoMol-Growth-Agent/1.0 (+https://avtomol.com)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    ok: response.ok,
    status: response.status,
    finalUrl: response.url,
    milliseconds: Date.now() - started,
    text: await response.text(),
  };
}

async function auditSite(site) {
  const result = {
    slug: site.slug,
    name: site.name,
    url: site.url,
    checkedAt: new Date().toISOString(),
    online: false,
    status: 0,
    milliseconds: null,
    seo: null,
    robots: null,
    sitemap: null,
    errors: [],
  };
  try {
    const home = await fetchText(site.url);
    result.online = home.ok;
    result.status = home.status;
    result.milliseconds = home.milliseconds;
    result.seo = analyzeHtml(home.text, home.finalUrl);
    if (!home.ok) result.errors.push("Началната страница върна HTTP " + home.status + ".");
  } catch (error) {
    result.errors.push("Сайтът не отговори: " + error.message);
    return result;
  }

  const base = new URL(site.url);
  try {
    const robots = await fetchText(new URL("/robots.txt", base).toString(), 15000);
    result.robots = { status: robots.status, available: robots.ok, blocksAll: /disallow:\s*\/\s*$/im.test(robots.text) };
    if (result.robots.blocksAll) result.errors.push("robots.txt блокира целия сайт.");
  } catch (error) {
    result.robots = { available: false, error: error.message };
  }

  try {
    const sitemap = await fetchText(new URL("/sitemap.xml", base).toString(), 20000);
    const urls = [...sitemap.text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((item) => item[1].trim());
    result.sitemap = { status: sitemap.status, available: sitemap.ok, urls: urls.length, sample: urls.slice(0, 10) };
    if (!sitemap.ok) result.errors.push("Липсва достъпен sitemap.xml.");
  } catch (error) {
    result.sitemap = { available: false, urls: 0, error: error.message };
  }
  return result;
}

function articleBody(site, topic) {
  const intro = {
    avtomol: "Правилният избор на автомобилни части започва с точните данни за автомобила. Марка, модел и година помагат, но VIN номерът е най-сигурният начин да се избегне неподходяща част.",
    megamoll: "Добрата покупка съчетава удобство, подходящ размер, практичност и цена. Преди поръчка проверете описанието, таблицата с размери и условията за доставка.",
    posejdon: "Подготовката преди сондаж спестява време и ненужни разходи. Местоположението, предназначението на водата и особеностите на терена трябва да се оценят предварително.",
    waterbg: "Търсенето на подземна вода изисква предварително проучване на терена. Геофизичните методи помагат да се определи подходящата зона за последващ сондаж.",
  }[site.slug] || "Практичната информация помага на клиента да вземе по-добро решение.";

  return [
    "# " + topic.charAt(0).toUpperCase() + topic.slice(1) + " – практично ръководство",
    "",
    intro,
    "",
    "## Какво да проверите предварително",
    "",
    "Определете точната си цел, бюджета и най-важните изисквания. Сравнявайте реалните характеристики, условията за доставка и възможностите за консултация. При съмнение изпратете конкретно запитване с всички налични данни.",
    "",
    "## Как да избегнете ненужни разходи",
    "",
    "Не избирайте само по най-ниската цена. Проверете съвместимостта, произхода, описанието и условията на услугата или продукта. Добрата предварителна проверка намалява риска от повторна покупка или допълнителна работа.",
    "",
    "## Следваща стъпка",
    "",
    "Разгледайте актуалната информация в " + site.name + " и изпратете запитване за индивидуална помощ.",
    "",
    "Източник и повече информация: " + site.url,
    "",
  ].join("\n");
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

async function buildCatalogFeeds(dayDir, config) {
  const products = await readJson(path.join(root, "data", "products.json"), []);
  const rows = (Array.isArray(products) ? products : []).map((product, index) => ({
    id: product.id || product.handle || "product-" + (index + 1),
    title: product.name || product.title || "Продукт",
    description: product.summary || product.description || product.name || product.title || "",
    availability: product.inStock === false || Number(product.inventory ?? product.quantity ?? 1) <= 0 ? "out_of_stock" : "in_stock",
    condition: "new",
    price: product.price ? String(product.price).replace(/[^0-9.,]/g, "").replace(",", ".") + " " + (product.currency || "EUR") : "",
    link: product.url || product.link || "https://avtomol.com/",
    image_link: product.image || product.imageUrl || "",
    brand: product.vendor || product.brand || "",
  }));

  function csvFor(items) {
    if (!items.length) return "";
    const header = Object.keys(items[0]);
    return [header.join(","), ...items.map((row) => header.map((key) => csvEscape(row[key])).join(","))].join("\r\n") + "\r\n";
  }

  const files = [];
  if (rows.length) {
    const csv = csvFor(rows);
    for (const channel of ["google-merchant", "meta-catalog", "tiktok-catalog"]) {
      const file = path.join(dayDir, channel + ".csv");
      await fs.writeFile(file, "\uFEFF" + csv, "utf8");
      files.push(file);
    }
  }

  const inventory = await readJson(path.join(root, "data", "vehicle-inventory.json"), { vehicles: [] });
  const uniqueVehicles = [];
  const seen = new Set();
  for (const vehicle of inventory?.vehicles || []) {
    const id = String(vehicle.external_id || vehicle.incomingNumber || vehicle.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let description = String(vehicle.description || vehicle.title || "")
      .replace(/Установени щети и забележки[\s\S]*?(?=Оборудване|Цена и доставка|$)/i, "")
      .replace(/Карта на щетите[\s\S]*?(?=Оборудване|Цена и доставка|$)/i, "")
      .replace(/(?:печалба|ддс)[^\n]*/gi, "")
      .replace(/употребяван автомобил с възможност за незабавна покупка\.?/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    uniqueVehicles.push({
      vehicle_id: id,
      title: vehicle.title || [vehicle.brand, vehicle.model, vehicle.year].filter(Boolean).join(" "),
      description,
      availability: vehicle.status === "available" ? "in_stock" : "out_of_stock",
      condition: "used",
      price: Number(vehicle.price || 0).toFixed(2) + " EUR",
      url: vehicle.url || ("https://avtomol.com/products/" + (vehicle.handle || id)),
      image: Array.isArray(vehicle.images) ? (vehicle.images[0] || "") : (vehicle.image || ""),
      make: vehicle.brand || "",
      model: vehicle.model || "",
      year: vehicle.year || "",
      mileage_value: String(vehicle.mileage || "").replace(/[^0-9]/g, ""),
      mileage_unit: "KM",
      fuel_type: vehicle.fuel || "",
      transmission: vehicle.transmission || "",
    });
  }
  if (uniqueVehicles.length) {
    const vehicleFile = path.join(dayDir, "meta-vehicles.csv");
    await fs.writeFile(vehicleFile, "\uFEFF" + csvFor(uniqueVehicles), "utf8");
    files.push(vehicleFile);
  }

  return {
    products: rows.length,
    vehicles: uniqueVehicles.length,
    files,
    verticals: {
      vehicles: { status: uniqueVehicles.length ? "feed_ready" : "needs_inventory", count: uniqueVehicles.length, mode: "official_meta_catalog_only" },
      fashion: { status: process.env.SHOPIFY_MEGAMOLL_ACCESS_TOKEN ? "shopify_connected" : "needs_shopify_credentials", count: 0, mode: "official_meta_catalog_only" },
      water_drilling: { status: "organic_service_promotion", count: 0, mode: "seo_and_owned_social" }
    }
  };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function googleToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(header + "." + body);
  const assertion = header + "." + body + "." + signer.sign(serviceAccount.private_key, "base64url");
  const response = await fetch(serviceAccount.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error("Google OAuth: HTTP " + response.status);
  return (await response.json()).access_token;
}

async function inspectSearchConsole(config, audits) {
  if (!config.searchConsole?.enabled) return { status: "disabled", sites: [] };
  const raw = process.env[config.searchConsole.serviceAccountEnv || "GOOGLE_SERVICE_ACCOUNT_JSON"];
  if (!raw) return { status: "needs_credentials", message: "Липсва GOOGLE_SERVICE_ACCOUNT_JSON.", sites: [] };
  const account = JSON.parse(raw);
  const token = await googleToken(account);
  const sites = [];
  for (const audit of audits) {
    const candidates = [audit.url, ...(audit.sitemap?.sample || [])].slice(0, config.searchConsole.inspectDailyLimitPerSite || 20);
    const inspected = [];
    for (const inspectionUrl of candidates) {
      const response = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionUrl, siteUrl: new URL(audit.url).origin + "/" }),
      });
      if (!response.ok) {
        inspected.push({ url: inspectionUrl, verdict: "API_ERROR_" + response.status });
        continue;
      }
      const data = await response.json();
      const index = data.inspectionResult?.indexStatusResult || {};
      inspected.push({
        url: inspectionUrl,
        verdict: index.verdict || "UNKNOWN",
        coverageState: index.coverageState || "",
        robotsTxtState: index.robotsTxtState || "",
        indexingState: index.indexingState || "",
        lastCrawlTime: index.lastCrawlTime || "",
      });
    }
    sites.push({ site: audit.slug, inspected, notIndexed: inspected.filter((item) => item.verdict !== "PASS").length });
  }
  return { status: "ok", sites };
}




async function shopifyGraphql(store, query, variables = {}) {
  const domain = String(process.env[store.domainEnv] || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  let token = process.env[store.tokenEnv];
  if (!domain) return { missingCredentials: true };
  if (!token) {
    const clientId = process.env[store.clientIdEnv || ""];
    const clientSecret = process.env[store.clientSecretEnv || ""];
    if (!clientId || !clientSecret) return { missingCredentials: true };
    const oauth = await fetch("https://" + domain + "/admin/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
    });
    const credentials = await oauth.json().catch(() => ({}));
    if (!oauth.ok || !credentials.access_token) {
      throw new Error("Shopify " + store.name + " authentication failed: " + (credentials.error_description || credentials.error || "HTTP " + oauth.status));
    }
    token = credentials.access_token;
  }
  const response = await fetch("https://" + domain + "/admin/api/" + (store.apiVersion || "2026-07") + "/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.errors) throw new Error("Shopify " + store.name + ": " + (data.errors?.[0]?.message || "HTTP " + response.status));
  return data.data;
}

async function monitorCommerce(config) {
  const stores = [];
  const commerceQuery = [
    "query NIKOLAYCommerce($ordersQuery: String!) {",
    "orders(first: 100, query: $ordersQuery, sortKey: CREATED_AT, reverse: true) {",
    "nodes { id createdAt currentTotalPriceSet { shopMoney { amount currencyCode } } } }",
    "products(first: 100, query: \"status:active\", sortKey: UPDATED_AT, reverse: true) {",
    "nodes { id title handle description seo { title description } featuredMedia { preview { image { url altText } } } variants(first: 10) { nodes { price availableForSale } } } }",
    "}",
  ].join(" ");
  const seoMutation = [
    "mutation NIKOLAYSeoFix($product: ProductUpdateInput!) {",
    "productUpdate(product: $product) { product { id } userErrors { field message } }",
    "}",
  ].join(" ");

  for (const store of config.commerceStores || []) {
    try {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const data = await shopifyGraphql(store, commerceQuery, { ordersQuery: "created_at:>=" + since });
      if (data?.missingCredentials) {
        stores.push({ site: store.site, name: store.name, status: "needs_credentials" });
        continue;
      }
      const orders = data.orders?.nodes || [];
      const products = data.products?.nodes || [];
      const currency = orders[0]?.currentTotalPriceSet?.shopMoney?.currencyCode || "EUR";
      const revenue30Days = orders.reduce((sum, order) => sum + Number(order.currentTotalPriceSet?.shopMoney?.amount || 0), 0);
      const missingSeo = products.filter((product) => !product.seo?.title || !product.seo?.description);
      const availableProducts = products.filter((product) => product.variants?.nodes?.some((variant) => variant.availableForSale));
      const rotationIndex = availableProducts.length ? Math.floor(Date.now() / 86400000) % availableProducts.length : -1;
      const featured = rotationIndex >= 0 ? availableProducts[rotationIndex] : null;
      const featuredVariant = featured?.variants?.nodes?.find((variant) => variant.availableForSale);
      const domain = String(process.env[store.domainEnv] || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
      const featuredProduct = featured ? {
        id: featured.id,
        title: featured.title,
        price: featuredVariant?.price || "",
        currency,
        url: "https://" + domain + "/products/" + featured.handle,
        imageUrl: featured.featuredMedia?.preview?.image?.url || "",
      } : null;
      const fixes = [];
      const apply = String(process.env.GROWTH_APPLY_SAFE_FIXES || "").toLowerCase() === "true";
      if (apply && store.safeSeoFixes) {
        for (const product of missingSeo.slice(0, 20)) {
          const seo = {
            title: (product.seo?.title || product.title || "").slice(0, 65),
            description: (product.seo?.description || product.description || ("Разгледайте " + product.title + " и актуалните предложения в " + store.name + ".")).replace(/\s+/g, " ").trim().slice(0, 160),
          };
          const mutation = await shopifyGraphql(store, seoMutation, { product: { id: product.id, seo } });
          const errors = mutation.productUpdate?.userErrors || [];
          fixes.push({ productId: product.id, title: product.title, status: errors.length ? "failed" : "updated", errors });
        }
      }
      stores.push({
        site: store.site,
        name: store.name,
        status: "ok",
        orders30Days: orders.length,
        revenue30Days: Number(revenue30Days.toFixed(2)),
        currency,
        activeProductsChecked: products.length,
        productsMissingSeo: missingSeo.length,
        featuredProduct,
        fixes,
      });
    } catch (error) {
      stores.push({ site: store.site, name: store.name, status: "failed", error: error.message });
    }
  }
  return {
    status: stores.some((item) => item.status === "ok") ? "ok" : "needs_credentials",
    stores,
    orders30Days: stores.reduce((sum, item) => sum + Number(item.orders30Days || 0), 0),
    revenue30Days: stores.reduce((sum, item) => sum + Number(item.revenue30Days || 0), 0),
    seoFixes: stores.reduce((sum, item) => sum + (item.fixes || []).filter((fix) => fix.status === "updated").length, 0),
  };
}

async function monitorGoogleAds(config) {
  const settings = config.googleAds;
  if (!settings?.enabled) return { status: "disabled", campaigns: [] };
  const developerToken = process.env[settings.developerTokenEnv];
  const clientId = process.env[settings.clientIdEnv];
  const clientSecret = process.env[settings.clientSecretEnv];
  const refreshToken = process.env[settings.refreshTokenEnv];
  const customerId = String(process.env[settings.customerIdEnv] || "").replace(/\D/g, "");
  const loginCustomerId = String(process.env[settings.loginCustomerIdEnv] || "").replace(/\D/g, "");
  if (!developerToken || !clientId || !clientSecret || !refreshToken || !customerId) {
    return { status: "needs_credentials", message: "Липсват данни за Google Ads API.", campaigns: [] };
  }
  const oauth = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!oauth.ok) return { status: "oauth_failed", http: oauth.status, campaigns: [] };
  const accessToken = (await oauth.json()).access_token;
  const headers = {
    Authorization: "Bearer " + accessToken,
    "developer-token": developerToken,
    "Content-Type": "application/json",
  };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
  const query = [
    "SELECT campaign.id, campaign.name, campaign.status,",
    "metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros",
    "FROM campaign WHERE segments.date DURING LAST_7_DAYS",
  ].join(" ");
  const endpoint = "https://googleads.googleapis.com/" + (settings.apiVersion || "v21") + "/customers/" + customerId + "/googleAds:searchStream";
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ query }) });
  if (!response.ok) return { status: "api_failed", http: response.status, campaigns: [] };
  const chunks = await response.json();
  const rows = chunks.flatMap((chunk) => chunk.results || []);
  const campaigns = rows.map((row) => ({
    id: row.campaign?.id,
    name: row.campaign?.name,
    status: row.campaign?.status,
    impressions: Number(row.metrics?.impressions || 0),
    clicks: Number(row.metrics?.clicks || 0),
    conversions: Number(row.metrics?.conversions || 0),
    cost: Number(row.metrics?.costMicros || 0) / 1000000,
  }));
  return {
    status: "ok",
    currencyNote: "Стойностите са в валутата на Google Ads профила.",
    campaigns,
    totals: campaigns.reduce((sum, item) => ({
      impressions: sum.impressions + item.impressions,
      clicks: sum.clicks + item.clicks,
      conversions: sum.conversions + item.conversions,
      cost: sum.cost + item.cost,
    }), { impressions: 0, clicks: 0, conversions: 0, cost: 0 }),
    mutationsAllowed: false,
  };
}

async function superviseWorkers(config) {
  const settings = config.supervisor;
  if (!settings?.workers?.length) return { status: "disabled", workers: [] };
  const token = process.env[settings.githubTokenEnv || "GITHUB_TOKEN"];
  if (!token) return { status: "needs_credentials", message: "Липсва GITHUB_TOKEN.", workers: [] };
  const headers = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const workers = [];
  for (const worker of settings.workers) {
    try {
      const url = "https://api.github.com/repos/" + settings.repository + "/actions/workflows/" + encodeURIComponent(worker.workflow) + "/runs?per_page=1";
      const response = await fetch(url, { headers });
      if (!response.ok) {
        workers.push({ ...worker, status: "api_error", http: response.status });
        continue;
      }
      const run = (await response.json()).workflow_runs?.[0];
      if (!run) {
        workers.push({ ...worker, status: "never_run" });
        continue;
      }
      workers.push({
        ...worker,
        status: run.status,
        conclusion: run.conclusion,
        runId: run.id,
        startedAt: run.run_started_at,
        updatedAt: run.updated_at,
        url: run.html_url,
        needsAttention: run.status === "completed" && run.conclusion !== "success" && run.conclusion !== "skipped",
      });
    } catch (error) {
      workers.push({ ...worker, status: "failed", error: error.message, needsAttention: true });
    }
  }
  return {
    status: "ok",
    workers,
    healthy: workers.filter((item) => item.conclusion === "success").length,
    attention: workers.filter((item) => item.needsAttention).length,
  };
}

async function publishFacebook(site, post) {
  const enabled = String(process.env.GROWTH_PUBLISH_ENABLED || "").toLowerCase() === "true";
  if (!enabled) return { status: "preview" };
  const pageId = process.env[site.facebookPageIdEnv || ""];
  const token = process.env[site.facebookTokenEnv || ""];
  if (!pageId || !token) return { status: "needs_credentials" };
  const hasImage = Boolean(post.imageUrl);
  const endpoint = hasImage ? "/photos" : "/feed";
  const body = hasImage
    ? new URLSearchParams({ url: post.imageUrl, caption: post.text, access_token: token })
    : new URLSearchParams({ message: post.text, link: post.trackedUrl, access_token: token });
  const response = await fetch("https://graph.facebook.com/v25.0/" + encodeURIComponent(pageId) + endpoint, {
    method: "POST",
    body,
  });
  const data = await response.json();
  if (!response.ok) return { status: "failed", error: data.error?.message || "HTTP " + response.status };
  return { status: "published", id: data.id };
}

function reportText(report) {
  const lines = [
    "НИКОЛАЙ – ЕЖЕДНЕВЕН ОТЧЕТ",
    "Дата: " + report.date,
    "Режим: " + report.mode,
    "",
    "САЙТОВЕ",
  ];
  for (const site of report.sites) {
    lines.push("- " + site.name + ": " + (site.online ? "РАБОТИ" : "ПРОБЛЕМ") + ", HTTP " + site.status + ", " + (site.milliseconds ?? "-") + " ms");
    for (const issue of site.seo?.issues || []) lines.push("  * " + issue.severity.toUpperCase() + ": " + issue.message);
    for (const error of site.errors || []) lines.push("  * ГРЕШКА: " + error);
  }
  lines.push("", "ПРОДАЖБИ И МАГАЗИНИ", "Статус: " + report.commerce.status, "- Поръчки за 30 дни: " + report.commerce.orders30Days, "- Приход за 30 дни: " + report.commerce.revenue30Days.toFixed(2), "- Безопасни SEO поправки: " + report.commerce.seoFixes);
  for (const store of report.commerce.stores || []) lines.push("- " + store.name + ": " + store.status + (store.productsMissingSeo != null ? ", липсващо SEO: " + store.productsMissingSeo : ""));
  lines.push("", "GOOGLE ADS", "Статус: " + report.googleAds.status);
  if (report.googleAds.totals) lines.push("- Разход за 7 дни: " + report.googleAds.totals.cost.toFixed(2), "- Кликове: " + report.googleAds.totals.clicks, "- Реализации: " + report.googleAds.totals.conversions);
  lines.push("", "ГЛАВЕН КОНТРОЛ НА АГЕНТИТЕ", "Статус: " + report.supervisor.status);
  for (const worker of report.supervisor.workers || []) lines.push("- " + worker.name + ": " + (worker.conclusion || worker.status) + (worker.needsAttention ? " — ИСКА ПРОВЕРКА" : ""));
  lines.push("", "GOOGLE SEARCH CONSOLE", "Статус: " + report.searchConsole.status);
  for (const site of report.searchConsole.sites || []) lines.push("- " + site.site + ": " + site.notIndexed + " неприети от " + site.inspected.length + " проверени");
  lines.push("", "СТРАТЕГИЯ ЗА КОНКУРЕНЦИЯТА");
  for (const item of report.strategy || []) {
    lines.push("- " + item.name + ": " + item.nextAction);
    lines.push("  Доказателство: " + item.evidence);
    lines.push("  Очакван резултат: " + item.expectedResult);
    lines.push("  Риск: " + item.risk);
  }
  lines.push("", "СЪДЪРЖАНИЕ И КАНАЛИ");
  lines.push("Подготвени статии: " + report.content.articles);
  lines.push("Подготвени публикации: " + report.content.socialPosts);
  lines.push("Публикувани във Facebook: " + report.content.facebookPublished);
  lines.push("Продукти в каталожните емисии: " + report.catalog.products);
  lines.push("Автомобили в Meta каталога: " + (report.catalog.vehicles || 0));
  for (const [name, item] of Object.entries(report.catalog.verticals || {})) lines.push("- " + name + ": " + item.status);
  lines.push("", "ЗАПИТВАНИЯ", "Последни 7 дни: " + report.leads.last7Days, "Последни 30 дни: " + report.leads.last30Days, "Общо: " + report.leads.total);
  lines.push("", "ЗАЩИТИ", "- Без платени реклами", "- Без изтриване на страници или продукти", "- Без нежелани съобщения");
  return lines.join("\r\n") + "\r\n";
}

function reportHtml(report, text) {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const ok = report.sites.filter((item) => item.online).length;
  return "<!doctype html><html lang=\"bg\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>НИКОЛАЙ – отчет</title><style>body{font:16px system-ui;margin:0;background:#eef2f7;color:#10233d}.wrap{max-width:1050px;margin:30px auto;padding:24px}.hero{background:#0d2d50;color:white;border-radius:18px;padding:24px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:18px 0}.card{background:white;border-radius:14px;padding:18px;box-shadow:0 4px 18px #18324d18}.n{font-size:32px;font-weight:800}.ok{color:#138a52}.bad{color:#c73535}pre{white-space:pre-wrap;background:white;padding:22px;border-radius:14px}</style><body><div class=\"wrap\"><div class=\"hero\"><h1>НИКОЛАЙ – ежедневен отчет</h1><p>" + report.date + "</p></div><div class=\"grid\"><div class=\"card\"><div class=\"n " + (ok === report.sites.length ? "ok" : "bad") + "\">" + ok + "/" + report.sites.length + "</div><div>работещи сайтове</div></div><div class=\"card\"><div class=\"n\">" + report.content.articles + "</div><div>нови статии</div></div><div class=\"card\"><div class=\"n\">" + report.content.socialPosts + "</div><div>публикации</div></div><div class=\"card\"><div class=\"n\">" + report.leads.last30Days + "</div><div>запитвания за 30 дни</div></div></div><pre>" + escaped + "</pre></div></body></html>";
}

async function main() {
  const config = await readJson(configPath);
  if (!config) throw new Error("Липсва growth-agent-config.json");
  const day = dateKey();
  const dayDir = path.join(outputRoot, day);
  const articleDir = path.join(dayDir, "articles");
  await fs.mkdir(articleDir, { recursive: true });

  const audits = await Promise.all(config.sites.filter((site) => site.enabled !== false).map(auditSite));
  const plan = buildContentPlan(config, new Date());
  const articles = plan.filter((item) => item.type === "article");
  for (const item of articles) {
    const site = config.sites.find((entry) => entry.slug === item.site);
    await fs.writeFile(path.join(articleDir, safeName(item.site + "-" + item.topic) + ".md"), articleBody(site, item.topic), "utf8");
  }

  const commerce = await monitorCommerce(config);
  const megamoll = commerce.stores.find((store) => store.site === "megamoll" && store.featuredProduct);
  const megamollPost = plan.find((item) => item.type === "social" && item.channel === "facebook" && item.site === "megamoll");
  if (megamoll && megamollPost) {
    const product = megamoll.featuredProduct;
    megamollPost.topic = product.title;
    megamollPost.trackedUrl = product.url + (product.url.includes("?") ? "&" : "?") + "utm_source=facebook&utm_medium=organic&utm_campaign=megamoll-product-" + day.replaceAll("-", "");
    megamollPost.imageUrl = product.imageUrl;
    megamollPost.productId = product.id;
    megamollPost.text = [
      product.title,
      "",
      product.price ? "Цена: " + product.price + " " + product.currency : "",
      "Разгледайте продукта: " + megamollPost.trackedUrl,
      "Телефон: 0876778357",
    ].filter(Boolean).join("\n");
  }

  let facebookPublished = 0;
  for (const item of plan.filter((entry) => entry.type === "social" && entry.channel === "facebook")) {
    const site = config.sites.find((entry) => entry.slug === item.site);
    item.publishResult = await publishFacebook(site, item);
    if (item.publishResult.status === "published") facebookPublished += 1;
  }

  const catalog = await buildCatalogFeeds(dayDir, config);
  let searchConsole;
  try { searchConsole = await inspectSearchConsole(config, audits); }
  catch (error) { searchConsole = { status: "failed", message: error.message, sites: [] }; }

  const googleAds = await monitorGoogleAds(config);
  const supervisor = await superviseWorkers(config);
  const strategy = buildCompetitiveStrategy(config, audits, commerce);

  const leadFile = path.join(root, "work", "leads.jsonl");
  let leadLines = [];
  try { leadLines = (await fs.readFile(leadFile, "utf8")).split(/\r?\n/); } catch {}
  const leads = summarizeLeads(leadLines);
  const report = {
    date: day,
    generatedAt: new Date().toISOString(),
    mode: String(process.env.GROWTH_PUBLISH_ENABLED || "").toLowerCase() === "true" ? "публикуване" : "преглед",
    sites: audits,
    searchConsole,
    googleAds,
    commerce,
    supervisor,
    strategy,
    content: {
      articles: articles.length,
      socialPosts: plan.filter((item) => item.type === "social").length,
      facebookPublished,
      plan,
    },
    catalog,
    leads,
  };

  const text = reportText(report);
  const html = reportHtml(report, text);
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(dayDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(path.join(dayDir, "ОТЧЕТ.txt"), "\uFEFF" + text, "utf8");
  await fs.writeFile(path.join(dayDir, "ОТЧЕТ.html"), html, "utf8");
  await fs.writeFile(latestJson, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestText, "\uFEFF" + text, "utf8");
  await fs.writeFile(latestHtml, html, "utf8");

  const desktopDir = process.env.GROWTH_DESKTOP_DIR || config.reporting?.desktopDirectory;
  if (desktopDir) {
    try {
      await fs.mkdir(desktopDir, { recursive: true });
      await fs.writeFile(path.join(desktopDir, "ПОСЛЕДЕН-ОТЧЕТ.txt"), "\uFEFF" + text, "utf8");
      await fs.writeFile(path.join(desktopDir, "ПОСЛЕДЕН-ОТЧЕТ.html"), html, "utf8");
      await fs.writeFile(path.join(desktopDir, "ПОСЛЕДЕН-ОТЧЕТ.json"), JSON.stringify(report, null, 2), "utf8");
    } catch (error) {
      console.error("Desktop report: " + error.message);
    }
  }
  console.log(JSON.stringify({ date: day, sitesOnline: audits.filter((item) => item.online).length, sites: audits.length, articles: articles.length, socialPosts: report.content.socialPosts, facebookPublished, searchConsole: searchConsole.status, report: latestHtml }));
  const publishingEnabled = String(process.env.GROWTH_PUBLISH_ENABLED || '').toLowerCase() === 'true';
  const plannedFacebook = plan.filter((item) => item.type === 'social' && item.channel === 'facebook').length;
  if (publishingEnabled && plannedFacebook > 0 && facebookPublished === 0) {
    throw new Error(`Publishing verification failed: 0 of ${plannedFacebook} planned Facebook posts returned a public URL.`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
