const { URL } = require("node:url");

function textOnly(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag, name) {
  const match = String(tag || "").match(new RegExp(name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"));
  return match ? match[1].trim() : "";
}

function analyzeHtml(html, finalUrl) {
  const source = String(html || "");
  const title = textOnly(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const h1 = textOnly(source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const descriptionTag =
    source.match(/<meta\b[^>]*name\s*=\s*[\"']description[\"'][^>]*>/i)?.[0] ||
    source.match(/<meta\b[^>]*content\s*=\s*[\"'][^\"']*[\"'][^>]*name\s*=\s*[\"']description[\"'][^>]*>/i)?.[0] ||
    "";
  const canonicalTag = source.match(/<link\b[^>]*rel\s*=\s*[\"']canonical[\"'][^>]*>/i)?.[0] || "";
  const robotsTag = source.match(/<meta\b[^>]*name\s*=\s*[\"']robots[\"'][^>]*>/i)?.[0] || "";
  const description = attribute(descriptionTag, "content");
  const canonical = attribute(canonicalTag, "href");
  const robots = attribute(robotsTag, "content").toLowerCase();
  const images = [...source.matchAll(/<img\b[^>]*>/gi)].map((item) => item[0]);
  const missingAlt = images.filter((tag) => !/\balt\s*=\s*[\"'][^\"']+[\"']/i.test(tag)).length;
  const schemaCount = (source.match(/application\/ld\+json/gi) || []).length;
  const issues = [];

  if (!title) issues.push({ severity: "critical", code: "missing_title", message: "Липсва SEO заглавие." });
  else if (title.length < 25 || title.length > 65) issues.push({ severity: "warning", code: "title_length", message: "SEO заглавието е " + title.length + " символа." });
  if (!description) issues.push({ severity: "critical", code: "missing_description", message: "Липсва meta description." });
  else if (description.length < 70 || description.length > 170) issues.push({ severity: "warning", code: "description_length", message: "Meta description е " + description.length + " символа." });
  if (!h1) issues.push({ severity: "warning", code: "missing_h1", message: "Липсва основно H1 заглавие." });
  if (!canonical) issues.push({ severity: "warning", code: "missing_canonical", message: "Липсва canonical адрес." });
  if (robots.includes("noindex")) issues.push({ severity: "critical", code: "noindex", message: "Страницата е забранена за индексиране." });
  if (!schemaCount) issues.push({ severity: "warning", code: "missing_schema", message: "Не е намерена структурирана информация JSON-LD." });
  if (missingAlt) issues.push({ severity: "warning", code: "missing_alt", message: missingAlt + " изображения са без ALT текст." });

  return {
    finalUrl,
    title,
    titleLength: title.length,
    description,
    descriptionLength: description.length,
    h1,
    canonical,
    robots,
    schemaCount,
    images: images.length,
    imagesMissingAlt: missingAlt,
    issues,
  };
}

function trackedUrl(url, campaign, source, medium) {
  const result = new URL(url);
  result.searchParams.set("utm_source", source);
  result.searchParams.set("utm_medium", medium);
  result.searchParams.set("utm_campaign", campaign);
  return result.toString();
}

function buildContentPlan(config, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const channels = config.channels || [];
  const plan = [];
  for (const site of (config.sites || []).filter((item) => item.enabled !== false)) {
    const topics = site.topics?.length ? site.topics : [site.name];
    const topic = topics[date.getUTCDate() % topics.length];
    const campaign = site.slug + "-" + day.replaceAll("-", "");
    plan.push({
      id: campaign + "-article",
      type: "article",
      site: site.slug,
      topic,
      title: topic.charAt(0).toUpperCase() + topic.slice(1) + " – практично ръководство",
      status: "draft",
    });
    for (const channel of channels.filter((item) => item.enabled !== false)) {
      const link = trackedUrl(site.url, campaign, channel.slug, channel.medium || "organic");
      plan.push({
        id: campaign + "-" + channel.slug,
        type: "social",
        site: site.slug,
        channel: channel.slug,
        topic,
        trackedUrl: link,
        text: site.name + ": " + topic + "\n\nПолезна информация и актуални предложения: " + link,
        status: "draft",
      });
    }
  }
  return plan;
}

function summarizeLeads(lines, now = Date.now()) {
  const result = { last7Days: 0, last30Days: 0, total: 0 };
  for (const line of lines) {
    if (!String(line).trim()) continue;
    try {
      const lead = JSON.parse(line);
      const time = Date.parse(lead.capturedAt || "");
      result.total += 1;
      if (Number.isFinite(time) && now - time <= 30 * 86400000) result.last30Days += 1;
      if (Number.isFinite(time) && now - time <= 7 * 86400000) result.last7Days += 1;
    } catch {}
  }
  return result;
}

module.exports = { analyzeHtml, buildContentPlan, summarizeLeads, trackedUrl };
