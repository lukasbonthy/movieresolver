function safeDecode(value) {
  if (typeof value !== "string") return value;

  let current = value;
  for (let i = 0; i < 6; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

function repairBrokenProtocol(value = "") {
  return String(value)
    // Fix pasted links that accidentally miss the leading h: ttps://site/path
    .replace(/(^|[^a-zA-Z])ttps:\/\//gi, "$1https://")
    .replace(/(^|[^a-zA-Z])ttp:\/\//gi, "$1http://")
    .replace(/(^|[^a-zA-Z])ttps%3A%2F%2F/gi, "$1https%3A%2F%2F")
    .replace(/(^|[^a-zA-Z])ttp%3A%2F%2F/gi, "$1http%3A%2F%2F");
}

function normalizeText(value = "") {
  return repairBrokenProtocol(String(value))
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/\\u0026/gi, "&")
    .replace(/\\x26/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\x3d/gi, "=")
    .replace(/\\u003f/gi, "?")
    .replace(/\\x3f/gi, "?")
    .replace(/\\u003a/gi, ":")
    .replace(/\\x3a/gi, ":")
    .replace(/\\u002f/gi, "/")
    .replace(/\\x2f/gi, "/")
    .replace(/\\\//g, "/");
}

function addHttpsToBareUrl(value = "") {
  const out = String(value).trim();

  // Match pasted URLs that start with the hostname instead of http(s)://.
  // Example: filmubox.lemonforest-715663af.southeastasia.azurecontainerapps.io/proxy/video?url=...
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?\//i.test(out)) {
    return `https://${out}`;
  }

  return out;
}

function cleanCandidate(value = "", baseUrl = null) {
  let out = addHttpsToBareUrl(normalizeText(String(value)).trim());

  // Convert protocol-relative URLs.
  if (out.startsWith("//")) out = `https:${out}`;

  // Convert relative proxy paths to absolute URLs when we know the page URL.
  if (baseUrl && out.startsWith("/")) {
    try {
      out = new URL(out, baseUrl).href;
    } catch {
      // Keep the relative value.
    }
  }

  // Remove common JS/HTML punctuation accidentally captured after the URL.
  out = out.replace(/["'`<>]+$/g, "");
  for (let i = 0; i < 5; i++) {
    const next = out.replace(/[\])};,]+$/g, "");
    if (next === out) break;
    out = next;
  }

  return out;
}

function isProxyVideoUrl(value = "") {
  const decoded = safeDecode(normalizeText(value)).toLowerCase();
  return (
    decoded.includes("/proxy/video?url=") ||
    decoded.includes("/highscool/video?url=") ||
    decoded.includes("/highschool/video?url=") ||
    /\/video\?url=/i.test(decoded)
  );
}

function isDirectMediaUrl(value = "") {
  const decoded = safeDecode(normalizeText(value)).toLowerCase();
  return /\.(mp4|m3u8|webm|mov|m4v)(\?|#|$)/i.test(decoded);
}

function looksUseful(value = "") {
  const decoded = safeDecode(normalizeText(value)).toLowerCase();
  return (
    isProxyVideoUrl(decoded) ||
    isDirectMediaUrl(decoded) ||
    decoded.includes("bcdn") ||
    decoded.includes("hakunaymatata") ||
    decoded.includes("trailer") ||
    decoded.includes("mpegurl")
  );
}

function getParamLoose(url, key) {
  if (!url || typeof url !== "string") return null;

  const normalized = normalizeText(url);
  const decoded = safeDecode(normalized);
  const versions = [normalized, decoded];

  for (const item of versions) {
    if (key === "url") {
      // Preserve nested video query params like ?sign=...&t=... by stopping only at known top-level params.
      const match = item.match(/[?&]url=([\s\S]*?)(?=&(?:apikey|api_key|referer|referrer|origin)=|$)/i);
      if (match?.[1]) return match[1];
    }

    try {
      const parsed = new URL(item.startsWith("//") ? `https:${item}` : item);
      const normal = parsed.searchParams.get(key);
      if (normal) return normal;
    } catch {
      // Fall through.
    }

    const generic = item.match(new RegExp(`[?&]${key}=([^&]*)`, "i"));
    if (generic?.[1]) return generic[1];
  }

  return null;
}

function getProxyBase(value = "", baseUrl = null) {
  const cleaned = cleanCandidate(value, baseUrl);
  const beforeQuestion = cleaned.split("?")[0];
  try {
    return new URL(beforeQuestion).href.replace(/\/$/, "");
  } catch {
    return beforeQuestion;
  }
}

function buildEncodedProxyUrl(originalUrl, decodedVideoUrl, apiKey, referer, origin, baseUrl = null) {
  if (!originalUrl || !decodedVideoUrl || !isProxyVideoUrl(originalUrl)) return null;

  const proxyBase = getProxyBase(originalUrl, baseUrl);
  if (!proxyBase) return null;

  const parts = [`url=${encodeURIComponent(decodedVideoUrl)}`];

  if (apiKey) parts.push(`apikey=${encodeURIComponent(apiKey)}`);
  if (referer) parts.push(`referer=${encodeURIComponent(referer)}`);
  if (origin) parts.push(`origin=${encodeURIComponent(origin)}`);

  return `${proxyBase}?${parts.join("&")}`;
}

function parseFoundUrl(rawValue, source = "text", baseUrl = null) {
  const url = cleanCandidate(rawValue, baseUrl);
  const decodedUrl = cleanCandidate(safeDecode(url), baseUrl);
  const isProxy = isProxyVideoUrl(url) || isProxyVideoUrl(decodedUrl);
  const isMedia = isDirectMediaUrl(url) || isDirectMediaUrl(decodedUrl);

  if (!isProxy && !isMedia && !looksUseful(url) && !looksUseful(decodedUrl)) return null;

  const nestedRaw = getParamLoose(url, "url") || getParamLoose(decodedUrl, "url");
  const apiKeyRaw =
    getParamLoose(url, "apikey") || getParamLoose(decodedUrl, "apikey") ||
    getParamLoose(url, "api_key") || getParamLoose(decodedUrl, "api_key");
  const refererRaw =
    getParamLoose(url, "referer") || getParamLoose(decodedUrl, "referer") ||
    getParamLoose(url, "referrer") || getParamLoose(decodedUrl, "referrer");
  const originRaw = getParamLoose(url, "origin") || getParamLoose(decodedUrl, "origin");

  const decodedVideoUrl = nestedRaw ? cleanCandidate(safeDecode(nestedRaw)) : null;
  const apiKey = apiKeyRaw ? safeDecode(apiKeyRaw) : null;
  const referer = refererRaw ? safeDecode(refererRaw) : null;
  const origin = originRaw ? safeDecode(originRaw) : null;
  const encodedProxyUrl = buildEncodedProxyUrl(url, decodedVideoUrl, apiKey, referer, origin, baseUrl);

  return {
    source,
    type: isProxy ? "proxy-video" : isMedia ? "direct-media" : "related-url",
    // Original captured URL. This might be raw/decoded and may not work if nested query params were not encoded.
    url,
    decodedUrl,
    // Use this one for copying/opening when type is proxy-video. It re-encodes the nested url= value.
    encodedProxyUrl,
    workingUrl: encodedProxyUrl || url,
    decodedVideoUrl,
    apiKey,
    referer,
    origin
  };
}

function uniqueResults(items) {
  const seen = new Set();
  const out = [];

  for (const item of items.filter(Boolean)) {
    const key = [item.type, item.decodedUrl || item.url, item.decodedVideoUrl || ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function extractUrlsFromText(text = "", source = "text", baseUrl = null) {
  if (!text) return [];

  const raw = String(text);
  const normalized = normalizeText(raw);
  const decoded = safeDecode(normalized);
  const doubleDecoded = safeDecode(decoded);
  const versions = [raw, normalized, decoded, doubleDecoded];

  const candidates = [];

  for (const body of versions) {
    if (!body) continue;

    // Normal URLs: https://x, http://x, //x, or pasted typo ttps://x
    candidates.push(...(body.match(/(?:(?:https?|ttps?):)?\/\/[^\s"'<>`]+/gi) || []));

    // Bare proxy URLs with no scheme.
    // Example: filmubox.lemonforest-715663af.southeastasia.azurecontainerapps.io/proxy/video?url=...
    for (const match of body.matchAll(/(^|[^a-z0-9.-])([a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?::\d+)?\/(?:proxy\/video|highscool\/video|highschool\/video|video)\?url=[^\s"'<>`]+)/gi)) {
      candidates.push(match[2]);
    }

    // JS escaped URLs: https:\/\/x
    candidates.push(...(body.match(/https?:\\\/\\\/[^\s"'<>`]+/gi) || []));

    // Percent-encoded URLs: https%3A%2F%2Fx, including pasted typo ttps%3A%2F%2Fx
    candidates.push(...(body.match(/(?:https?|ttps?)%3A%2F%2F[^\s"'<>`]+/gi) || []));

    // Relative proxy paths: /proxy/video?url=...
    // Use a prefix capture so we do not accidentally re-capture the path inside a full https://host/proxy/video URL.
    for (const match of body.matchAll(/(^|[\s"'`(=])((?:\/(?:proxy\/video|highscool\/video|highschool\/video|video))\?url=[^\s"'<>`]+)/gi)) {
      candidates.push(match[2]);
    }
  }

  return uniqueResults(candidates.map((candidate) => parseFoundUrl(candidate, source, baseUrl)));
}

module.exports = {
  safeDecode,
  repairBrokenProtocol,
  normalizeText,
  addHttpsToBareUrl,
  isProxyVideoUrl,
  isDirectMediaUrl,
  looksUseful,
  extractUrlsFromText,
  parseFoundUrl,
  buildEncodedProxyUrl
};
