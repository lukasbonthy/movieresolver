const express = require("express");
const { chromium } = require("playwright");
const {
  extractUrlsFromText,
  parseFoundUrl,
  looksUseful,
  repairBrokenProtocol,
  addHttpsToBareUrl
} = require("./extractor");

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_URL = "https://embed.filmu.in/movie/1726";
const SCAN_WAIT_MS = Number(process.env.SCAN_WAIT_MS || 9000);

app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function uniqueResults(items) {
  const seen = new Set();
  const out = [];

  for (const item of items.filter(Boolean)) {
    const key = [item.type, item.workingUrl || item.encodedProxyUrl || item.decodedUrl || item.url, item.decodedVideoUrl || "", item.status || ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}


function wantsJson(req) {
  const accept = String(req.headers.accept || "").toLowerCase();
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  return (
    req.path.startsWith("/api/") ||
    req.query.format === "json" ||
    accept.includes("application/json") ||
    contentType.includes("application/json") ||
    req.get("x-requested-with") === "XMLHttpRequest"
  );
}

function sendScanError(req, res, targetUrl, error, status = 500) {
  const message = error?.message || String(error || "Scan failed");
  if (wantsJson(req)) {
    return res.status(status).json({ ok: false, targetUrl, error: message });
  }
  return res.status(status).send(renderPage({ targetUrl, error: message }));
}

function sendScanSuccess(req, res, targetUrl, results) {
  if (wantsJson(req)) {
    return res.json({ ok: true, targetUrl, count: results.length, results });
  }
  return res.send(renderPage({ targetUrl, results, apiUrl: `/api/scan?url=${encodeURIComponent(targetUrl)}` }));
}

function shouldReadResponseBody(url, contentType) {
  const lowerUrl = url.toLowerCase();
  const lowerType = String(contentType || "").toLowerCase();

  return (
    lowerType.includes("text/") ||
    lowerType.includes("json") ||
    lowerType.includes("javascript") ||
    lowerType.includes("xml") ||
    lowerType.includes("mpegurl") ||
    lowerUrl.endsWith(".js") ||
    lowerUrl.includes(".js?") ||
    lowerUrl.endsWith(".json") ||
    lowerUrl.includes(".json?") ||
    lowerUrl.endsWith(".m3u8") ||
    lowerUrl.includes(".m3u8?")
  );
}

async function dumpFrameContent(page, baseUrl) {
  const found = [];
  for (const frame of page.frames()) {
    const frameUrl = frame.url();
    const frameBase = frameUrl && frameUrl !== "about:blank" ? frameUrl : baseUrl;

    const html = await frame.content().catch(() => "");
    found.push(...extractUrlsFromText(html, "frame-html", frameBase));

    const storageText = await frame
      .evaluate(() => {
        const rows = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            rows.push(`localStorage:${key}=${localStorage.getItem(key)}`);
          }
        } catch {}
        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            rows.push(`sessionStorage:${key}=${sessionStorage.getItem(key)}`);
          }
        } catch {}
        return rows.join("\n");
      })
      .catch(() => "");

    found.push(...extractUrlsFromText(storageText, "browser-storage", frameBase));
  }
  return found;
}

async function clickPossiblePlayers(page) {
  const selectors = [
    "video",
    "button",
    "[role='button']",
    "[aria-label*='play' i]",
    "[class*='play' i]",
    "[id*='play' i]",
    ".jw-icon-playback",
    ".vjs-big-play-button",
    ".plyr__control",
    "svg"
  ];

  // Try mouse/keyboard first because some overlays do not have a clean selector.
  await page.mouse.click(683, 384).catch(() => {});
  await page.keyboard.press("Space").catch(() => {});
  await page.waitForTimeout(1400);

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const loc = frame.locator(selector).first();
      const count = await loc.count().catch(() => 0);
      if (!count) continue;
      await loc.click({ timeout: 1800, force: true }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  }
}

async function captureTrailerUrls(targetUrl) {
  targetUrl = addHttpsToBareUrl(repairBrokenProtocol(targetUrl));
  const found = [];
  const responseTasks = [];

  // If somebody pastes the proxy URL itself, return it instantly.
  const direct = parseFoundUrl(targetUrl, "input-url", targetUrl);
  if (direct && looksUseful(direct.url)) found.push(direct);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--autoplay-policy=no-user-gesture-required"]
    });
  } catch (error) {
    throw new Error(
      "Playwright Chromium is not installed yet. Run: npm run install-browser\n\nOriginal error: " + error.message
    );
  }

  const context = await browser.newContext({
    viewport: { width: 1365, height: 768 },
    javaScriptEnabled: true,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  const page = await context.newPage();

  page.on("console", (msg) => {
    found.push(...extractUrlsFromText(msg.text(), "console", targetUrl));
  });

  page.on("request", (request) => {
    const url = request.url();
    if (looksUseful(url)) {
      const item = parseFoundUrl(url, "network-request", targetUrl);
      if (item) found.push({ ...item, method: request.method(), resourceType: request.resourceType() });
    }
  });

  page.on("response", (response) => {
    const task = (async () => {
      const url = response.url();
      const headers = response.headers();
      const contentType = headers["content-type"] || "";

      if (looksUseful(url) || contentType.includes("video") || contentType.includes("mpegurl")) {
        const item = parseFoundUrl(url, "network-response", targetUrl);
        if (item) found.push({ ...item, status: response.status(), contentType });
      }

      if (shouldReadResponseBody(url, contentType)) {
        const text = await response.text().catch(() => "");
        if (text) found.push(...extractUrlsFromText(text, "response-body", url));
      }
    })();

    responseTasks.push(task);
  });

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(SCAN_WAIT_MS);

    found.push(...(await dumpFrameContent(page, targetUrl)));

    await clickPossiblePlayers(page);
    await page.waitForTimeout(5000);

    found.push(...(await dumpFrameContent(page, targetUrl)));

    await Promise.allSettled(responseTasks);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return uniqueResults(found).filter((item) => looksUseful(item.workingUrl || item.url) || looksUseful(item.decodedVideoUrl || ""));
}

function renderPage({ targetUrl = DEFAULT_URL, results = null, error = null, apiUrl = null } = {}) {
  const resultCards = results
    ? results.length
      ? results
          .map((item, index) => {
            const nested = item.decodedVideoUrl
              ? `<div class="field"><span>Decoded video URL</span><a href="${escapeHtml(item.decodedVideoUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.decodedVideoUrl)}</a></div>`
              : "";

            const details = [
              item.source,
              item.status ? `status ${item.status}` : null,
              item.contentType,
              item.resourceType,
              item.method
            ]
              .filter(Boolean)
              .join(" • ");

            const api = item.apiKey ? `<div class="mini"><b>API key:</b> ${escapeHtml(item.apiKey)}</div>` : "";
            const referer = item.referer ? `<div class="mini"><b>Referer:</b> ${escapeHtml(item.referer)}</div>` : "";
            const origin = item.origin ? `<div class="mini"><b>Origin:</b> ${escapeHtml(item.origin)}</div>` : "";

            return `
              <article class="result-card">
                <div class="result-top">
                  <div class="number">${index + 1}</div>
                  <div>
                    <h3>${escapeHtml(item.type || "matched-url")}</h3>
                    <p>${escapeHtml(details || "captured")}</p>
                  </div>
                </div>
                ${item.encodedProxyUrl ? `<div class="field"><span>Working encoded proxy URL</span><a href="${escapeHtml(item.encodedProxyUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.encodedProxyUrl)}</a></div>` : ""}
                <div class="field"><span>${item.encodedProxyUrl ? "Original captured URL" : "Full matched URL"}</span><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.url)}</a></div>
                ${item.decodedUrl && item.decodedUrl !== item.url ? `<div class="field"><span>Decoded full matched URL</span><a href="${escapeHtml(item.decodedUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.decodedUrl)}</a></div>` : ""}
                ${nested}
                ${api}${referer}${origin}
              </article>`;
          })
          .join("")
      : `<div class="empty"><b>No matches found.</b><br>Open the same page in Chrome DevTools → Network and press play. If you see the URL there but this app misses it, paste the page HTML or network HAR text into <code>/api/test-text</code> to test the extractor.</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>School Trailer URL Scanner</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="badge">Playwright network scanner</div>
      <h1>Find proxy trailer URLs after JavaScript loads</h1>
      <p>Scans page HTML, frames, storage, JS responses, network requests, and URLs like <code>https://filmubox.../proxy/video?url=...</code>.</p>
    </section>

    <form method="POST" action="/scan" class="panel">
      <label for="url">Movie or embed URL</label>
      <div class="row">
        <input id="url" name="url" value="${escapeHtml(targetUrl)}" placeholder="https://embed.filmu.in/movie/1726" required />
        <button type="submit">Scan</button>
      </div>
      <p class="hint">For JSON, use <code>${escapeHtml(apiUrl || `/api/scan?url=${encodeURIComponent(targetUrl)}`)}</code></p>
    </form>

    ${error ? `<div class="error">${escapeHtml(error).replace(/\n/g, "<br>")}</div>` : ""}
    ${results ? `<section class="results"><h2>Results <span>${results.length}</span></h2>${resultCards}</section>` : ""}
  </main>
</body>
</html>`;
}

app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));

app.get("/", (req, res) => res.send(renderPage()));

async function handleScanRequest(req, res) {
  const inputUrl = req.body?.url || req.query?.url || DEFAULT_URL;
  const targetUrl = addHttpsToBareUrl(repairBrokenProtocol(inputUrl));

  try {
    new URL(targetUrl);
  } catch (error) {
    return sendScanError(req, res, targetUrl, new Error("That is not a valid URL. Example: https://embed.filmu.in/movie/1726"), 400);
  }

  try {
    const results = await captureTrailerUrls(targetUrl);
    return sendScanSuccess(req, res, targetUrl, results);
  } catch (error) {
    return sendScanError(req, res, targetUrl, error, 500);
  }
}

// HTML form route. If JavaScript/fetch asks for JSON, this same route returns JSON.
app.get("/scan", handleScanRequest);
app.post("/scan", handleScanRequest);

// JSON API routes. Multiple aliases are here so old frontend code does not hit a missing route and parse HTML.
app.get("/api/scan", handleScanRequest);
app.post("/api/scan", handleScanRequest);
app.get("/api/search", handleScanRequest);
app.post("/api/search", handleScanRequest);
app.get("/api/scrape", handleScanRequest);
app.post("/api/scrape", handleScanRequest);
app.get("/api/find", handleScanRequest);
app.post("/api/find", handleScanRequest);

app.post("/api/test-text", (req, res) => {
  const text = req.body.text || "";
  const baseUrl = req.body.baseUrl || DEFAULT_URL;
  const results = extractUrlsFromText(text, "manual-test", baseUrl);
  res.json({ ok: true, count: results.length, results });
});

// Important: any /api typo returns JSON instead of an HTML <!DOCTYPE> error page.
app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    error: `API route not found: ${req.method} ${req.originalUrl}`,
    validRoutes: ["/api/scan?url=...", "/api/search?url=...", "/api/scrape?url=...", "/api/find?url=..."]
  });
});

app.use((req, res) => {
  res.status(404).send(renderPage({ error: `Page not found: ${req.originalUrl}` }));
});

app.listen(PORT, () => {
  console.log(`School trailer scanner running at http://localhost:${PORT}`);
});
