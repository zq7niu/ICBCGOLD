const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = Number(process.env.PORT || 5177);
const ROOT = __dirname;
const CACHE_FILE = path.join(ROOT, "market-cache.json");
const OUNCE_TO_GRAM = 31.1034768;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

async function fetchText(url) {
  if (process.env.FORCE_MARKET_SOURCE_FAIL === "1") throw new Error("forced source failure");
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      accept: "text/html,application/json,text/plain,*/*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      origin: "https://finance.yahoo.com",
      referer: "https://finance.yahoo.com/",
    },
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(payload) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    console.warn(`Unable to write cache: ${error.message}`);
  }
}

function fetchTextViaPowerShell(url) {
  return new Promise((resolve, reject) => {
    if (process.env.FORCE_MARKET_SOURCE_FAIL === "1") {
      reject(new Error("forced source failure"));
      return;
    }
    const quotedUrl = url.replace(/'/g, "''");
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -Uri '${quotedUrl}' -UseBasicParsing -TimeoutSec 30).Content`,
      ],
      { maxBuffer: 1024 * 1024 * 20, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error("PowerShell 请求失败或超时"));
        else resolve(stdout);
      }
    );
  });
}

function fetchTextViaCurl(url, headers = []) {
  return new Promise((resolve, reject) => {
    if (process.env.FORCE_MARKET_SOURCE_FAIL === "1") {
      reject(new Error("forced source failure"));
      return;
    }
    const args = ["-L", "-sS", "-A", "Mozilla/5.0"];
    headers.forEach((header) => args.push("-H", header));
    args.push(url);
    execFile("curl.exe", args, { maxBuffer: 1024 * 1024 * 20, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

function fetchTextViaCurlPost(url, body, headers = []) {
  return new Promise((resolve, reject) => {
    if (process.env.FORCE_MARKET_SOURCE_FAIL === "1") {
      reject(new Error("forced source failure"));
      return;
    }
    const args = ["-L", "-sS", "-A", "Mozilla/5.0", "-e", "https://mybank.icbc.com.cn/icbc/newperbank/perbank3/gold/goldaccrual_query_out.jsp"];
    headers.forEach((header) => args.push("-H", header));
    args.push("-d", body, url);
    execFile("curl.exe", args, { maxBuffer: 1024 * 1024 * 20, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

function parseYahooChart(json) {
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(json.chart?.error?.description || "Yahoo chart result is empty");
  const quote = result.indicators?.quote?.[0] || {};
  const timestamps = result.timestamp || [];
  const prices = timestamps
    .map((time, index) => ({
      time: new Date(time * 1000).toISOString(),
      open: quote.open?.[index],
      high: quote.high?.[index],
      low: quote.low?.[index],
      close: quote.close?.[index],
      volume: quote.volume?.[index],
    }))
    .filter((item) => Number.isFinite(item.close));
  if (!prices.length) throw new Error("Yahoo chart has no valid prices");
  return { meta: result.meta, prices };
}

async function fetchYahoo(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=${interval}`;
  return parseYahooChart(JSON.parse(await fetchTextViaPowerShell(url)));
}

async function fetchFxRate() {
  try {
    const fx = await fetchYahoo("CNY=X", "5d", "1d");
    return {
      symbol: "CNY=X",
      source: "Yahoo Finance USD/CNY",
      rate: fx.prices.at(-1).close,
      time: fx.prices.at(-1).time,
    };
  } catch (error) {
    const data = await fetchJson("https://api.frankfurter.app/latest?from=USD&to=CNY");
    const rate = data?.rates?.CNY;
    if (!Number.isFinite(rate)) throw error;
    return {
      symbol: "USD/CNY",
      source: "Frankfurter USD/CNY",
      rate,
      time: data.date,
    };
  }
}

async function fetchWorldFuturesFromYahoo(fxRate) {
  const intraday = await fetchYahoo("GC=F", "1d", "5m");
  const month = await fetchYahoo("GC=F", "1mo", "1d");
  const ytd = await fetchYahoo("GC=F", "ytd", "1d");
  const latestUsd = intraday.prices.at(-1).close;
  return {
    available: true,
    symbol: "GC=F",
    name: "COMEX Gold Futures",
    type: "futures",
    note: "COMEX 黄金期货近月合约，用于观察期货市场情绪；不等同于 XAU/USD 现货。",
    source: "Yahoo Finance",
    sourceUrl: "https://finance.yahoo.com/quote/GC=F",
    usdPerOunce: latestUsd,
    cnyPerGram: (latestUsd * fxRate) / OUNCE_TO_GRAM,
    meta: intraday.meta,
    intraday: intraday.prices,
    month: month.prices,
    ytd: ytd.prices,
  };
}

function parseSinaXau(text) {
  const match = text.match(/hq_str_hf_XAU="([^"]+)"/);
  if (!match) throw new Error("Sina hf_XAU quote not found");
  const cells = match[1].split(",");
  const latest = pickNumber(cells[0]);
  const open = pickNumber(cells[1]);
  const high = pickNumber(cells[4]);
  const low = pickNumber(cells[5]);
  const time = `${cells[12] || ""} ${cells[6] || ""}`.trim();
  if (![latest, open, high, low].every(Number.isFinite)) throw new Error("Sina hf_XAU quote parse failed");
  const points = [
    { time, open, high, low, close: open },
    { time, open, high, low, close: low },
    { time, open, high, low, close: high },
    { time, open, high, low, close: latest },
  ];
  return { latest, open, high, low, time, points };
}

async function fetchWorldGoldFromSina(fxRate) {
  const url = "https://hq.sinajs.cn/list=hf_XAU";
  const quote = parseSinaXau(await fetchTextViaCurl(url, ["Referer: https://finance.sina.com.cn"]));
  return {
    available: true,
    degraded: true,
    symbol: "hf_XAU",
    name: "伦敦金（现货黄金）",
    type: "spot",
    note: "新浪财经伦敦金 hf_XAU，作为国际现货黄金参考；该源只提供当前 OHLC，不提供完整历史趋势。",
    source: "新浪财经",
    sourceUrl: "https://gu.sina.cn/ft/hq/hf.php?symbol=XAU",
    usdPerOunce: quote.latest,
    cnyPerGram: (quote.latest * fxRate) / OUNCE_TO_GRAM,
    meta: { regularMarketTimeText: quote.time },
    intraday: quote.points,
    month: [],
    ytd: [],
  };
}

async function fetchWorldSpot(fxRate) {
  try {
    return { data: await fetchWorldGoldFromSina(fxRate), warnings: [] };
  } catch (error) {
    throw new Error(`新浪 hf_XAU：${error.message}`);
  }
}

async function fetchWorldFutures(fxRate) {
  try {
    return { data: await fetchWorldFuturesFromYahoo(fxRate), warnings: [] };
  } catch (error) {
    throw new Error(`Yahoo GC=F：${error.message}`);
  }
}

function pickNumber(text) {
  const value = Number(String(text).replace(/,/g, "").trim());
  return Number.isFinite(value) ? value : null;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

async function fetchSgeDelayed() {
  const url = "https://www.sge.com.cn/sjzx/yshqbg";
  const html = await fetchText(url);
  const title = stripTags(html.match(/<h1>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const timeText = stripTags(html.match(/<p><span><i>来源:[\s\S]*?<span><i>时间:<\/i>(.*?)<\/span>/i)?.[1] || "");
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const contracts = rows
    .map((row) => {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        stripTags(cell[1])
      );
      if (cells.length < 5 || cells[0] === "合约") return null;
      return {
        contract: cells[0],
        latest: pickNumber(cells[1]),
        high: pickNumber(cells[2]),
        low: pickNumber(cells[3]),
        open: pickNumber(cells[4]),
      };
    })
    .filter(Boolean);
  const auTd = contracts.find((item) => item.contract === "Au(T+D)");
  const au9999 = contracts.find((item) => item.contract === "Au99.99");
  if (!auTd) throw new Error("SGE Au(T+D) quote not found");
  return {
    source: "上海黄金交易所延时行情",
    url,
    title,
    timeText,
    auTd,
    au9999,
    contracts,
  };
}

async function fetchIcbcGoldAccumulation() {
  const url = "https://mybank.icbc.com.cn/servlet/AsynGetDataServlet";
  const text = await fetchTextViaCurlPost(url, "tranCode=A00505", [
    "Content-Type: application/x-www-form-urlencoded; charset=UTF-8",
  ]);
  const data = JSON.parse(text);
  const product = data.ryinfo?.find((item) => item.productName?.includes("如意金"));
  const price = data.pronoinfo?.find((item) => item.prodcode === product?.productId) || data.pronoinfo?.[0];
  if (!product || !price) throw new Error("ICBC ruyi quote not found");
  const toYuan = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric / 100 : null;
  };
  const quote = {
    product: product.productName,
    activePrice: toYuan(price.buyprice),
    redeemPrice: toYuan(price.sellprice),
    timeText: new Date().toLocaleString("zh-CN", { hour12: false }),
    source: "工商银行如意金积存行情",
    sourceUrl: "https://mybank.icbc.com.cn/icbc/newperbank/perbank3/gold/goldaccrual_query_out.jsp",
  };
  if (!Number.isFinite(quote.activePrice) || !Number.isFinite(quote.redeemPrice)) {
    throw new Error("ICBC ruyi quote parse failed");
  }
  return quote;
}

function getStatus() {
  const sh = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const day = sh.getDay();
  const hour = sh.getHours();
  const minute = sh.getMinutes();
  const decimal = hour + minute / 60;
  const chinaLive =
    day >= 1 &&
    day <= 5 &&
    ((decimal >= 9 && decimal <= 11.5) ||
      (decimal >= 13.5 && decimal <= 15.5) ||
      decimal >= 20 ||
      decimal <= 2.5);

  const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const nyDay = ny.getDay();
  const nyDecimal = ny.getHours() + ny.getMinutes() / 60;
  const worldLive =
    (nyDay === 0 && nyDecimal >= 18) ||
    (nyDay >= 1 && nyDay <= 4 && !(nyDecimal >= 17 && nyDecimal < 18)) ||
    (nyDay === 5 && nyDecimal < 17);

  return {
    china: chinaLive ? "交易中" : day === 0 || day === 6 ? "闭市" : "休市",
    world: worldLive ? "交易中" : "闭市",
  };
}

async function buildMarketPayload() {
  const cache = readCache();
  const warnings = [];
  let sge = null;
  let icbc = null;
  let fx = null;
  let worldSpot = null;
  let worldFutures = null;
  let cacheUsed = false;
  let cacheTime = null;

  try {
    sge = await fetchSgeDelayed();
  } catch (error) {
    warnings.push(`国内首选源不可用：${error.message}`);
    if (cache?.china) {
      sge = {
        source: `${cache.china.source}（缓存）`,
        url: cache.china.sourceUrl,
        title: cache.china.title,
        timeText: cache.china.timeText,
        auTd: {
          latest: cache.china.latest,
          high: cache.china.high,
          low: cache.china.low,
          open: cache.china.open,
        },
        au9999: cache.china.au9999,
        contracts: cache.china.contracts || [],
      };
      cacheUsed = true;
      cacheTime = cache.fetchedAt;
      warnings.push(`国内行情使用本地缓存，缓存时间：${new Date(cache.fetchedAt).toLocaleString("zh-CN", { hour12: false })}`);
    } else {
      throw error;
    }
  }

  try {
    icbc = await fetchIcbcGoldAccumulation();
  } catch (error) {
    warnings.push(`工行积存金源不可用：${error.message}`);
    if (cache?.icbcGold) {
      icbc = { ...cache.icbcGold, source: `${cache.icbcGold.source}（缓存）`, cached: true };
      cacheUsed = true;
      cacheTime ||= cache.fetchedAt;
      warnings.push(`工行积存金使用本地缓存，缓存时间：${new Date(cache.fetchedAt).toLocaleString("zh-CN", { hour12: false })}`);
    }
  }

  try {
    fx = await fetchFxRate();
  } catch (error) {
    warnings.push(`汇率源不可用：${error.message}`);
    if (cache?.fx?.rate) {
      fx = { ...cache.fx, source: `${cache.fx.source}（缓存）` };
      cacheUsed = true;
      cacheTime ||= cache.fetchedAt;
    }
  }
  try {
    if (!fx?.rate) throw new Error("缺少 USD/CNY 汇率，无法折算国际现货金价");
    const result = await fetchWorldSpot(fx.rate);
    worldSpot = result.data;
    warnings.push(...result.warnings);
  } catch (error) {
    warnings.push(`国际现货源不可用：${error.message}`);
    const cachedSpot = cache?.worldSpot || (cache?.world?.type === "spot" ? cache.world : null);
    if (cachedSpot?.available) {
      worldSpot = {
        ...cachedSpot,
        source: `${cachedSpot.source}（缓存）`,
        cached: true,
        error: error.message,
      };
      cacheUsed = true;
      cacheTime ||= cache.fetchedAt;
      warnings.push(`国际现货使用本地缓存，缓存时间：${new Date(cache.fetchedAt).toLocaleString("zh-CN", { hour12: false })}`);
    } else {
      worldSpot = {
        available: false,
        symbol: "hf_XAU",
        name: "伦敦金（现货黄金）",
        type: "spot",
        source: "新浪财经",
        sourceUrl: "https://gu.sina.cn/ft/hq/hf.php?symbol=XAU",
        error: error.message,
        intraday: [],
        month: [],
        ytd: [],
      };
    }
  }
  try {
    if (!fx?.rate) throw new Error("缺少 USD/CNY 汇率，无法折算国际期货金价");
    const result = await fetchWorldFutures(fx.rate);
    worldFutures = result.data;
    warnings.push(...result.warnings);
  } catch (error) {
    warnings.push(`国际期货源不可用：${error.message}`);
    const cachedFutures = cache?.worldFutures || (cache?.world?.type === "futures" ? cache.world : null);
    if (cachedFutures?.available) {
      worldFutures = {
        ...cachedFutures,
        source: `${cachedFutures.source}（缓存）`,
        cached: true,
        error: error.message,
      };
      cacheUsed = true;
      cacheTime ||= cache.fetchedAt;
      warnings.push(`国际期货使用本地缓存，缓存时间：${new Date(cache.fetchedAt).toLocaleString("zh-CN", { hour12: false })}`);
    } else {
      worldFutures = {
        available: false,
        symbol: "GC=F",
        name: "COMEX Gold Futures",
        type: "futures",
        source: "Yahoo Finance",
        sourceUrl: "https://finance.yahoo.com/quote/GC=F",
        error: error.message,
        intraday: [],
        month: [],
        ytd: [],
      };
    }
  }

  const payload = {
    ok: true,
    fetchedAt: new Date().toISOString(),
    cacheUsed,
    cacheTime,
    warnings,
    status: getStatus(),
    fx,
    world: worldSpot,
    worldSpot,
    worldFutures,
    china: {
      symbol: "Au(T+D)",
      source: sge.source,
      sourceUrl: sge.url,
      title: sge.title,
      timeText: sge.timeText,
      latest: sge.auTd.latest,
      high: sge.auTd.high,
      low: sge.auTd.low,
      open: sge.auTd.open,
      au9999: sge.au9999,
      contracts: sge.contracts,
    },
    icbcGold: icbc,
  };
  if (!cacheUsed || !cache) writeCache(payload);
  return payload;
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(ROOT, safePath));
  if (!filePath.startsWith(ROOT)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
  fs.readFile(filePath, (error, content) => {
    if (error) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    send(res, 200, content, MIME[path.extname(filePath)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/market")) {
    try {
      const payload = await buildMarketPayload();
      send(res, 200, JSON.stringify(payload));
    } catch (error) {
      send(
        res,
        502,
        JSON.stringify({
          ok: false,
          fetchedAt: new Date().toISOString(),
          error: error.message,
        })
      );
    }
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Gold monitor running at http://localhost:${PORT}`);
});
