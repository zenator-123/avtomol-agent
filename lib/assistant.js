const crypto = require("node:crypto");
const { normalizeText } = require("./catalog");

const VIBER_PHONE = "0876 778 357";
const SHOP_BASE_URL = "https://avtomol.com";

const LANGUAGE_COPY = {
  bg: {
    noPrice: "цена при запитване",
    noMatch:
      `Мога да помогна с авточасти, гуми, масла, акумулатори и аксесоари от AvtoMol.com. Напиши марка, модел, година, двигател ако го знаеш, и частта, която търсиш. За най-точна проверка изпрати VIN/рама или снимка на талона във Viber/WhatsApp: ${VIBER_PHONE}.`,
    intro: "Най-близките попадения са:",
    openHint: "От картата под отговора можеш да отвориш страницата.",
    vinHint:
      `За 100% точна съвместимост изпрати запитване във Viber/WhatsApp ${VIBER_PHONE} с марка, модел, година, VIN/рама и частта, която търсиш.`,
  },
  en: {
    noPrice: "price on request",
    noMatch:
      `I can help with auto parts, tyres, oils, batteries, and accessories from AvtoMol.com. Send the car make, model, year, engine if known, and the part you need. For an exact check, send the VIN/frame number or registration document photo on Viber/WhatsApp: ${VIBER_PHONE}.`,
    intro: "Closest matches:",
    openHint: "You can open the page from the card below.",
    vinHint:
      `For exact compatibility, send a Viber/WhatsApp inquiry to ${VIBER_PHONE} with make, model, year, VIN/frame number, and the part you need.`,
  },
  de: {
    noPrice: "Preis auf Anfrage",
    noMatch:
      `Ich kann mit Autoteilen, Reifen, Ölen, Batterien und Zubehör von AvtoMol.com helfen. Sende Marke, Modell, Baujahr, Motor falls bekannt, und das gesuchte Teil. Für eine genaue Prüfung sende VIN/Fahrgestellnummer oder ein Foto des Fahrzeugscheins per Viber/WhatsApp: ${VIBER_PHONE}.`,
    intro: "Die nächsten Treffer sind:",
    openHint: "Du kannst die Seite über die Karte unten öffnen.",
    vinHint:
      `Für genaue Kompatibilität sende eine Anfrage per Viber/WhatsApp an ${VIBER_PHONE} mit Marke, Modell, Baujahr, VIN/Fahrgestellnummer und dem gesuchten Teil.`,
  },
};

const FAQ_TRANSLATIONS = {
  contact: {
    bg: `Можеш да се свържеш с AvtoMol.com на телефон/Viber/WhatsApp ${VIBER_PHONE}. Имейл: megamolbg@abv.bg. Работно време: Пн-Пт 09:00 - 18:00.`,
    en: `You can contact AvtoMol.com by phone/Viber/WhatsApp at ${VIBER_PHONE}. Email: megamolbg@abv.bg. Hours: Mon-Fri 09:00 - 18:00.`,
    de: `Du erreichst AvtoMol.com per Telefon/Viber/WhatsApp unter ${VIBER_PHONE}. E-Mail: megamolbg@abv.bg. Zeiten: Mo-Fr 09:00 - 18:00.`,
  },
  vin: {
    bg: `За точна съвместимост изпрати във Viber/WhatsApp ${VIBER_PHONE}: марка, модел, година, VIN/рама или снимка на талона, и частта, която търсиш.`,
    en: `For exact compatibility, send on Viber/WhatsApp ${VIBER_PHONE}: make, model, year, VIN/frame number or registration document photo, and the part you need.`,
    de: `Für genaue Kompatibilität sende per Viber/WhatsApp ${VIBER_PHONE}: Marke, Modell, Baujahr, VIN/Fahrgestellnummer oder Fahrzeugschein-Foto und das gesuchte Teil.`,
  },
  "order-any-part": {
    bg: `Да, можеш да пуснеш запитване за всяка част. Изпрати във Viber/WhatsApp ${VIBER_PHONE}: марка, модел, година, VIN/рама и частта. Екипът ще провери подходящ вариант.`,
    en: `Yes, you can request any part. Send make, model, year, VIN/frame number, and the part on Viber/WhatsApp ${VIBER_PHONE}. The team will check a suitable option.`,
    de: `Ja, du kannst jedes Teil anfragen. Sende Marke, Modell, Baujahr, VIN/Fahrgestellnummer und das Teil per Viber/WhatsApp ${VIBER_PHONE}. Das Team prüft passende Optionen.`,
  },
  tires: {
    bg: "За гуми напиши размер, сезон и марка ако имаш предпочитание, например: зимни гуми 205/55R16 Michelin.",
    en: "For tyres, send size, season, and preferred brand if any, for example: winter tyres 205/55R16 Michelin.",
    de: "Für Reifen sende Größe, Saison und bevorzugte Marke, z. B.: Winterreifen 205/55R16 Michelin.",
  },
  euro07: {
    bg: "Euro07 може да се използва като допълнителен каталог, когато имаме достъп или експорт. Ако си влязъл там, изпрати файл/експорт или данни и ще ги добавим към агента.",
    en: "Euro07 can be used as an extra catalog when access or an export is available. If you are logged in, send the export/file and it can be added to the agent.",
    de: "Euro07 kann als zusätzlicher Katalog genutzt werden, wenn Zugriff oder Export vorhanden ist. Wenn du eingeloggt bist, sende Export/Datei und wir fügen sie dem Agenten hinzu.",
  },
};

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value || "anonymous")).digest("hex").slice(0, 24);
}

function detectLanguage(message = "") {
  if (/[А-Яа-яЁё]/.test(message)) {
    return "bg";
  }

  const normalized = normalizeText(message);
  const germanSignals = ["ich", "und", "fur", "für", "bitte", "reifen", "teile", "auto", "baujahr", "fahrgestellnummer"];
  const englishSignals = ["the", "for", "with", "please", "tyre", "tire", "parts", "car", "year", "vin"];

  const germanScore = germanSignals.reduce((total, token) => total + (normalized.includes(normalizeText(token)) ? 1 : 0), 0);
  const englishScore = englishSignals.reduce((total, token) => total + (normalized.includes(normalizeText(token)) ? 1 : 0), 0);

  return germanScore > englishScore ? "de" : "en";
}

function formatPrice(price, currency = "EUR", language = "bg") {
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 1) {
    return LANGUAGE_COPY[language]?.noPrice || LANGUAGE_COPY.bg.noPrice;
  }

  const locale = language === "de" ? "de-DE" : language === "en" ? "en-US" : "bg-BG";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function buildAssistantInstructions(profile) {
  const rules = (profile.salesRules || []).map((rule) => `- ${rule}`).join("\n");

  return [
    `You are ${profile.assistantName}, the AI auto-parts consultant for ${profile.shopName}.`,
    "Supported languages: Bulgarian, English, and German. Always answer in the customer's language; if unclear, answer in Bulgarian.",
    `Tone: ${profile.brandTone}.`,
    "You help customers find auto parts, tyres, oils, filters, brakes, belts, suspension parts, batteries, and accessories.",
    "Tyre source: tyre suggestions are stored in the local AvtoMol catalog. Never mention or send the customer to external tyre supplier sites. For tyres, use size, season, brand, price, and availability from the current catalog context when present, then guide the customer to AvtoMol search or Viber inquiry.",
    "Euro07 source: e-shop.euro07.net is a professional B2B/login catalog. If no exact public Euro07 product data is present in the context, explain that exact checks are handled by inquiry using vehicle data instead of pretending to browse hidden stock.",
    `Core escalation rule: for exact compatibility, tell the customer to send a Viber/WhatsApp inquiry to ${VIBER_PHONE} with make, model, year, VIN/frame number or registration document photo, and the exact part needed.`,
    "The store can accept inquiries for any auto part. If the requested part, tyre, oil, battery, or accessory is not found in the visible catalog, guide the customer to send a Viber inquiry instead of saying it is unavailable.",
    "When something is not found, do not repeat a generic greeting. Say that it can be checked and ordered by inquiry on Viber/WhatsApp with make, model, year, engine if known, VIN/frame or registration document photo, and the needed part.",
    "Mention preferential pricing and the best possible offer only as an inquiry-based check, not as a guaranteed final price.",
    "Never guarantee compatibility without VIN/frame number or exact vehicle data.",
    "Never invent stock, hidden discounts, delivery promises, or exact prices missing from the context.",
    "When the customer asks for tyres, ask for or use width/profile/diameter, season, and brand preference.",
    "Recommend up to 3 relevant pages/products and explain why they fit.",
    "Use only product, contact, policy, and category information from the current context.",
    rules ? `Sales rules:\n${rules}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCatalogContext(profile, matches) {
  if (!matches.length) {
    return `No strong catalog matches were found for ${profile.shopName}.`;
  }

  const lines = matches.map((product, index) =>
    [
      `${index + 1}. ${product.name}`,
      `Category: ${product.category || product.productType || "n/a"}`,
      `Vendor: ${product.vendor || "n/a"}`,
      `Price: ${product.price ?? "n/a"} ${product.currency || "EUR"}`,
      `Makes: ${(product.makes || []).join(", ") || "n/a"}`,
      `Models: ${(product.models || []).join(", ") || "n/a"}`,
      `Part types: ${(product.partTypes || []).join(", ") || "n/a"}`,
      `Tyre sizes: ${(product.tireSizes || []).join(", ") || "n/a"}`,
      `Summary: ${product.summary || "n/a"}`,
      `Why it matched: ${product.matchReason || "n/a"}`,
      `Page: ${displayUrlForProduct(product)}`,
    ].join(" | ")
  );

  return `Catalog context for ${profile.shopName}:\n${lines.join("\n")}`;
}

function buildFaqContext(profile) {
  if (!Array.isArray(profile.faq) || !profile.faq.length) {
    return "";
  }

  return profile.faq.map((item) => `- ${item.question}: ${item.answer}`).join("\n");
}

function buildLinksContext(profile) {
  const sections = [];

  if (Array.isArray(profile.categoryLinks) && profile.categoryLinks.length) {
    sections.push(`Category links:\n${profile.categoryLinks.map((item) => `- ${item.name}: ${item.url}`).join("\n")}`);
  }

  if (Array.isArray(profile.policyLinks) && profile.policyLinks.length) {
    sections.push(`Policy links:\n${profile.policyLinks.map((item) => `- ${item.name}: ${item.url}`).join("\n")}`);
  }

  return sections.join("\n");
}

function buildPolicyContext(profile) {
  return [
    `Contacts: phone/Viber/WhatsApp ${profile.contact?.phone || VIBER_PHONE}, email ${profile.contact?.email || "n/a"}, hours ${profile.contact?.hours || "n/a"}`,
    profile.contact?.contactPage ? `Contact page: ${profile.contact.contactPage}` : "",
    `Vehicle inquiry rule: ${profile.vehicleInquiryRule || "n/a"}`,
    `Shipping: ${profile.shipping?.summary || "n/a"}`,
    `Payments: ${profile.payments?.summary || "n/a"}`,
    `Returns: ${profile.returns?.summary || "n/a"}`,
    buildLinksContext(profile),
    profile.humanEscalationMessage ? `Human escalation: ${profile.humanEscalationMessage}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildInputPayload({ message, matches, pageContext, profile }) {
  return [
    `Current page title: ${pageContext?.pageTitle || "n/a"}`,
    `Current page URL: ${pageContext?.currentUrl || "n/a"}`,
    buildPolicyContext(profile),
    `FAQ:\n${buildFaqContext(profile) || "n/a"}`,
    buildCatalogContext(profile, matches),
    `Customer message: ${message}`,
  ].join("\n\n");
}

function extractOutputText(payload) {
  if (payload.output_text) {
    return String(payload.output_text).trim();
  }

  if (!Array.isArray(payload.output)) {
    return "";
  }

  const textParts = [];
  for (const item of payload.output) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (content.type === "output_text" && content.text) {
        textParts.push(content.text);
      }
    }
  }

  return textParts.join("\n").trim();
}

function tyreSearchUrl(product) {
  const query = [
    product?.vendor,
    ...(product?.tireSizes || []),
    product?.season === "winter" ? "зимни гуми" : "",
    product?.season === "summer" ? "летни гуми" : "",
    product?.season === "all-season" ? "всесезонни гуми" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `${SHOP_BASE_URL}/search?q=${encodeURIComponent(query || "гуми")}`;
}

function displayUrlForProduct(product) {
  if (product?.source === "avtomol-tyres") {
    return tyreSearchUrl(product);
  }

  return product?.url || SHOP_BASE_URL;
}

async function callOpenAI({ apiKey, model, matches, message, pageContext, previousResponseId, profile, sessionId }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: buildAssistantInstructions(profile),
      previous_response_id: previousResponseId || undefined,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: buildInputPayload({ message, matches, pageContext, profile }),
            },
          ],
        },
      ],
      max_output_tokens: 560,
      temperature: 0.35,
      metadata: {
        channel: "website_widget",
        shop: profile.shopName,
      },
      safety_identifier: hashValue(sessionId),
    }),
  });

  const payload = await response.json();
  if (!response.ok) {
    const errorMessage = payload?.error?.message || "Unsuccessful request to OpenAI.";
    throw new Error(errorMessage);
  }

  return {
    responseId: payload.id || null,
    reply: extractOutputText(payload),
  };
}

function findFaqAnswer(profile, message) {
  const normalized = normalizeText(message);
  const faqItems = Array.isArray(profile.faq) ? profile.faq : [];
  let bestMatch = null;
  let bestScore = 0;

  for (const item of faqItems) {
    const keywords = Array.isArray(item.keywords) ? item.keywords : [];
    const score = keywords.reduce((total, keyword) => total + (normalized.includes(normalizeText(keyword)) ? 1 : 0), 0);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

function localizeFaqAnswer(faqItem, language) {
  if (!faqItem?.id) {
    return faqItem?.answer || "";
  }

  return FAQ_TRANSLATIONS[faqItem.id]?.[language] || faqItem.answer || "";
}

function hasAny(normalizedMessage, terms) {
  return terms.some((term) => normalizedMessage.includes(normalizeText(term)));
}

function extractTireSize(message) {
  const match = String(message || "").match(/\b(\d{3})\s*\/\s*(\d{2})\s*r?\s*(\d{2})\b/i);
  return match ? `${match[1]}/${match[2]}R${match[3]}` : "";
}

function detectRequestIntent(message) {
  const normalized = normalizeText(message);
  const tireSize = extractTireSize(message);
  const intent = {
    isEuro07: hasAny(normalized, ["euro07", "euro 07", "evro07", "evro 07", "евро07", "евро 07"]),
    isTire:
      Boolean(tireSize) ||
      hasAny(normalized, ["guma", "gumi", "tire", "tires", "tyre", "tyres", "reifen", "zimni", "letni", "vsesezonni"]),
    tireSize,
    season: "",
    partLabel: "",
  };

  if (hasAny(normalized, ["zimni", "winter"])) {
    intent.season = "зимни";
  } else if (hasAny(normalized, ["letni", "summer"])) {
    intent.season = "летни";
  } else if (hasAny(normalized, ["vsesezonni", "all season", "allseason"])) {
    intent.season = "всесезонни";
  }

  const partRules = [
    { label: "накладки, дискове или други спирачни части", terms: ["nakladki", "spirachki", "diskove", "brake", "pads", "disc"] },
    { label: "масло или консуматив", terms: ["maslo", "motorno maslo", "oil", "antifreeze", "konsumativ"] },
    { label: "филтър", terms: ["filtar", "filtri", "filter", "maslen filtar", "vazdushen filtar", "goriven filtar"] },
    { label: "акумулатор", terms: ["akumulator", "battery", "batterie"] },
    { label: "ремък, ангренаж или водна помпа", terms: ["remak", "remaci", "angrenazh", "vodna pompa", "belt", "timing"] },
    { label: "част по окачването", terms: ["okachvane", "amortisor", "nosach", "sharnir", "bialetka", "suspension"] },
    { label: "авточаст", terms: ["chast", "chasti", "avtochasti", "part", "parts"] },
  ];

  const partRule = partRules.find((rule) => hasAny(normalized, rule.terms));
  if (partRule) {
    intent.partLabel = partRule.label;
  }

  return intent;
}

function orderLine() {
  return `Всяка авточаст може да бъде поръчана по Viber/WhatsApp ${VIBER_PHONE}. Изпратете марка, модел, година, двигател ако го знаете, VIN/рама или снимка на талона и частта, която търсите. Ще проверим вариант на преференциална цена и най-добрата възможна оферта.`;
}

function buildSmartNoMatchReply(message) {
  const intent = detectRequestIntent(message);

  if (intent.isEuro07) {
    return [
      "Euro07 е професионален B2B каталог. Публичният линк не дава директно пълен списък с артикули без достъп или експорт, затова точната проверка се прави по заявка.",
      orderLine(),
      "Ако вече сте влезли в Euro07 и имате конкретен артикул, изпратете снимка/код или данните на автомобила във Viber."
    ].join("\n");
  }

  if (intent.isTire) {
    const tireDetails = [intent.season, intent.tireSize].filter(Boolean).join(" ");
    return [
      `За гуми${tireDetails ? ` ${tireDetails}` : ""} мога да ориентирам по каталога на AvtoMol.`,
      `За реална наличност, DOT и преференциална оферта изпратете във Viber/WhatsApp ${VIBER_PHONE}: размер, сезон, марка ако имате предпочитание и брой гуми.`,
      "Ако търсите най-ниска цена, напишете и бюджет. Ще се търси най-добрата възможна оферта."
    ].join("\n");
  }

  if (intent.partLabel) {
    return [
      `Можем да проверим и поръчаме ${intent.partLabel} за вашия автомобил.`,
      orderLine(),
      "Ако не знаете точната част, изпратете снимка или кратко описание на проблема. Ще бъде проверено по каталози и партньорски доставки, включително Euro07 при наличен достъп."
    ].join("\n");
  }

  return [
    "Мога да помогна с авточасти, гуми, масла, филтри, спирачки, ремъци, окачване, акумулатори и аксесоари.",
    orderLine(),
    "Напишете какво търсите, например: “накладки за VW Golf 5 2006”, “зимни гуми 205/55R16” или “масло за BMW 320d 2008”."
  ].join("\n");
}

function buildMatchIntro(message, copy) {
  const intent = detectRequestIntent(message);
  if (intent.isTire) {
    return "Намерих близки предложения за гуми:";
  }
  if (intent.partLabel) {
    return `Намерих близки предложения за ${intent.partLabel}:`;
  }
  return copy.intro;
}

function buildMatchFooter(message, copy) {
  const intent = detectRequestIntent(message);
  if (intent.isTire) {
    return `За поръчка през AvtoMol и проверка на наличност/DOT изпратете във Viber/WhatsApp ${VIBER_PHONE}: размер, сезон, марка и брой гуми.`;
  }

  return [copy.openHint, orderLine()].join("\n");
}

function generateFallbackReply({ matches, message, profile }) {
  const language = detectLanguage(message);
  const copy = LANGUAGE_COPY[language] || LANGUAGE_COPY.bg;
  const faqAnswer = findFaqAnswer(profile, message);

  if (faqAnswer) {
    return localizeFaqAnswer(faqAnswer, language);
  }

  if (!matches.length) {
    return buildSmartNoMatchReply(message);
  }

  const picks = matches.slice(0, 3).map((product) => {
    const source = product.source === "avtomol-tyres" ? "AvtoMol гуми" : "AvtoMol";
    const details = [source, product.summary || product.category || "", product.matchReason || ""].filter(Boolean).join(" - ");
    return `- ${product.name} (${formatPrice(product.price, product.currency, language)})${details ? ` - ${details}` : ""}`;
  });

  return [buildMatchIntro(message, copy), picks.join("\n"), buildMatchFooter(message, copy)].join("\n");
}

function extractLead(message) {
  const emailMatch = message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatch = message.match(/(?:\+?\d[\d\s().-]{7,}\d)/);
  const vinMatch = message.match(/\b[A-HJ-NPR-Z0-9]{11,17}\b/i);

  if (!emailMatch && !phoneMatch && !vinMatch) {
    return null;
  }

  return {
    email: emailMatch ? emailMatch[0] : null,
    phone: phoneMatch ? phoneMatch[0].trim() : null,
    vin: vinMatch ? vinMatch[0].trim().toUpperCase() : null,
  };
}

module.exports = {
  callOpenAI,
  detectLanguage,
  extractLead,
  findFaqAnswer,
  generateFallbackReply,
};
