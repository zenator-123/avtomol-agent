const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");
const { ensureDir, loadEnvFile, readJson } = require("./lib/config");
const { buildOutfitSuggestions, pickFocusSuggestion, searchProducts } = require("./lib/catalog");
const { buildCatalogOptions, buildVehicleTree, searchCatalog } = require("./lib/catalog-api");
const { callOpenAI, detectLanguage, extractLead, findFaqAnswer, generateFallbackReply } = require("./lib/assistant");

const projectRoot = __dirname;
loadEnvFile(path.join(projectRoot, ".env"));

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const SHOP_BASE_URL = process.env.SHOP_BASE_URL || "https://avtomol.com";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const publicDir = path.join(projectRoot, "public");
const dataDir = path.join(projectRoot, "data");
const workDir = path.join(projectRoot, "work");
const leadsFile = path.join(workDir, "leads.jsonl");
const sessions = new Map();
let profileCache = null;
let productsCache = null;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function getCorsOrigin(origin) {
  if (!origin || ALLOWED_ORIGINS.includes("*")) {
    return "*";
  }

  return ALLOWED_ORIGINS.includes(origin) ? origin : "";
}

function buildCorsHeaders(origin) {
  const allowOrigin = getCorsOrigin(origin);
  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": allowOrigin || "null",
    Vary: "Origin",
  };
}

function sendJson(response, statusCode, payload, origin) {
  response.writeHead(statusCode, {
    ...buildCorsHeaders(origin),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, text, contentType, origin) {
  response.writeHead(statusCode, {
    ...buildCorsHeaders(origin),
    "Content-Type": contentType,
  });
  response.end(text);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sanitizeMessage(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function createSessionId() {
  return crypto.randomUUID();
}

function buildFocusAction(suggestion, language) {
  if (!suggestion?.url) {
    return null;
  }

  const url =
    suggestion.source === "avtomol-tyres"
      ? `${SHOP_BASE_URL}/search?q=${encodeURIComponent(
          [
            suggestion.vendor,
            ...(suggestion.tireSizes || []),
            suggestion.season === "winter" ? "зимни гуми" : "",
            suggestion.season === "summer" ? "летни гуми" : "",
            suggestion.season === "all-season" ? "всесезонни гуми" : "",
          ]
            .filter(Boolean)
            .join(" ") || "гуми"
        )}`
      : suggestion.url;

  const labels = {
    bg: `Отвори ${suggestion.name}`,
    en: `Open ${suggestion.name}`,
    de: `${suggestion.name} öffnen`,
  };

  return {
    url,
    label: labels[language] || labels.bg,
  };
}

function displayUrlForSuggestion(suggestion) {
  if (suggestion?.source === "avtomol-tyres") {
    const query = [
      suggestion.vendor,
      ...(suggestion.tireSizes || []),
      suggestion.season === "winter" ? "зимни гуми" : "",
      suggestion.season === "summer" ? "летни гуми" : "",
      suggestion.season === "all-season" ? "всесезонни гуми" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return `${SHOP_BASE_URL}/search?q=${encodeURIComponent(query || "гуми")}`;
  }

  return suggestion?.url || SHOP_BASE_URL;
}

function toPublicSuggestion(suggestion) {
  return {
    ...suggestion,
    url: displayUrlForSuggestion(suggestion),
  };
}

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      previousResponseId: null,
      updatedAt: Date.now(),
    });
  }

  const session = sessions.get(sessionId);
  session.updatedAt = Date.now();
  return session;
}

async function saveLead({ contact, message, pageContext, sessionId }) {
  if (!contact) {
    return;
  }

  await ensureDir(workDir);
  await fs.appendFile(
    leadsFile,
    `${JSON.stringify({
      capturedAt: new Date().toISOString(),
      contact,
      message,
      pageContext,
      sessionId,
    })}\n`,
    "utf8"
  );
}

async function getProfile() {
  if (!profileCache) {
    profileCache = await readJson(path.join(dataDir, "store-profile.json"));
  }

  return profileCache;
}

async function getProducts() {
  if (!productsCache) {
    productsCache = await readJson(path.join(dataDir, "products.json"));
  }

  return productsCache;
}

async function serveStaticFile(response, pathname, origin) {
  const relativePath = pathname === "/" ? "/index.html" : pathname;
  const resolvedPath = path.normalize(path.join(publicDir, relativePath));

  if (!resolvedPath.startsWith(publicDir)) {
    sendText(response, 403, "Forbidden", "text/plain; charset=utf-8", origin);
    return;
  }

  try {
    const data = await fs.readFile(resolvedPath);
    const extension = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    response.writeHead(200, {
      ...buildCorsHeaders(origin),
      "Content-Type": contentType,
    });
    response.end(data);
  } catch {
    sendText(response, 404, "Not found", "text/plain; charset=utf-8", origin);
  }
}

async function handleChat(request, response, origin) {
  const rawBody = await readBody(request);
  let payload;

  try {
    payload = JSON.parse(rawBody || "{}");
  } catch {
    sendJson(response, 400, { error: "Невалидно JSON тяло." }, origin);
    return;
  }

  const message = sanitizeMessage(payload.message);
  if (!message) {
    sendJson(response, 400, { error: "Липсва съобщение." }, origin);
    return;
  }

  const sessionId = String(payload.sessionId || createSessionId()).slice(0, 120);
  const pageContext = {
    currentUrl: String(payload.currentUrl || "").slice(0, 500),
    pageTitle: String(payload.pageTitle || "").slice(0, 200),
  };

  const [profile, products] = await Promise.all([getProfile(), getProducts()]);

  const faqHit = findFaqAnswer(profile, message);
  const outfitSuggestions = faqHit ? [] : buildOutfitSuggestions(products, message, 4);
  const suggestions = faqHit ? [] : outfitSuggestions.length ? outfitSuggestions : searchProducts(products, message, 4);
  const publicSuggestions = suggestions.map(toPublicSuggestion);
  const language = detectLanguage(message);
  const focusSuggestion = outfitSuggestions.length > 1 ? null : pickFocusSuggestion(message, publicSuggestions);
  const session = getSession(sessionId);
  const capturedLead = extractLead(message);

  let reply = "";
  let mode = "demo";
  try {
    if (OPENAI_API_KEY) {
      const aiResult = await callOpenAI({
        apiKey: OPENAI_API_KEY,
        model: OPENAI_MODEL,
        matches: suggestions,
        message,
        pageContext,
        previousResponseId: session.previousResponseId,
        profile,
        sessionId,
      });
      reply = aiResult.reply || generateFallbackReply({ matches: suggestions, message, profile });
      session.previousResponseId = aiResult.responseId || session.previousResponseId;
      mode = "openai";
    } else {
      reply = generateFallbackReply({ matches: suggestions, message, profile });
    }
  } catch (error) {
    reply = generateFallbackReply({ matches: suggestions, message, profile });
    mode = "fallback";
    console.error("OpenAI request failed:", error.message);
  }

  if (capturedLead) {
    await saveLead({
      contact: capturedLead,
      message,
      pageContext,
      sessionId,
    });
  }

  sendJson(
    response,
    200,
    {
      leadCaptured: Boolean(capturedLead),
      focusAction: buildFocusAction(focusSuggestion, language),
      mode,
      reply,
      sessionId,
      suggestions: publicSuggestions,
    },
    origin
  );
}

async function handleCatalogOptions(response, origin) {
  const products = await getProducts();
  sendJson(response, 200, buildCatalogOptions(products), origin);
}

async function handleCatalogSearch(url, response, origin) {
  const products = await getProducts();
  sendJson(response, 200, searchCatalog(products, url.searchParams), origin);
}

async function handleVehicleTree(response, origin) {
  const products = await getProducts();
  sendJson(response, 200, buildVehicleTree(products), origin);
}

async function bootstrap() {
  await ensureDir(workDir);
  const [, products] = await Promise.all([getProfile(), getProducts()]);
  searchProducts(products, "205/55R16", 1);

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin || "";
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, buildCorsHeaders(origin));
      response.end();
      return;
    }

    if (url.pathname === "/health") {
      sendJson(
        response,
        200,
        {
          openaiConfigured: Boolean(OPENAI_API_KEY),
          status: "ok",
        },
        origin
      );
      return;
    }

    if (url.pathname === "/api/catalog/options" && request.method === "GET") {
      try {
        await handleCatalogOptions(response, origin);
      } catch (error) {
        console.error("Catalog options error:", error);
        sendJson(response, 500, { error: "Catalog options failed." }, origin);
      }
      return;
    }

    if (url.pathname === "/api/catalog/search" && request.method === "GET") {
      try {
        await handleCatalogSearch(url, response, origin);
      } catch (error) {
        console.error("Catalog search error:", error);
        sendJson(response, 500, { error: "Catalog search failed." }, origin);
      }
      return;
    }

    if (url.pathname === "/api/vehicles/tree" && request.method === "GET") {
      try {
        await handleVehicleTree(response, origin);
      } catch (error) {
        console.error("Vehicle tree error:", error);
        sendJson(response, 500, { error: "Vehicle tree failed." }, origin);
      }
      return;
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        await handleChat(request, response, origin);
      } catch (error) {
        console.error("Chat handler error:", error);
        sendJson(response, 500, { error: "Възникна вътрешна грешка." }, origin);
      }
      return;
    }

    if (request.method === "GET") {
      await serveStaticFile(response, url.pathname, origin);
      return;
    }

    sendJson(response, 405, { error: "Методът не е позволен." }, origin);
  });

  server.listen(PORT, () => {
    console.log(`Website AI agent starter is running on http://localhost:${PORT}`);
    console.log(
      OPENAI_API_KEY
        ? `OpenAI mode is enabled with model ${OPENAI_MODEL}.`
        : "OpenAI key not found. Running in demo fallback mode."
    );
  });
}

bootstrap().catch((error) => {
  console.error("Failed to start server:", error);
  process.exitCode = 1;
});
