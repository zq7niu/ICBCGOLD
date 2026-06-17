const OUNCE_TO_GRAM = 31.1034768;
const state = {
  refreshTimer: null,
  intervalSeconds: 60,
  lastPayload: null,
};

const $ = (id) => document.getElementById(id);

const formatMoney = (value, currency = "", digits = 2) => {
  if (!Number.isFinite(value)) return "--";
  return `${currency}${value.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
};

const formatPct = (value) => {
  if (!Number.isFinite(value)) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
};

const pctChange = (now, before) => {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0) return 0;
  return ((now - before) / before) * 100;
};

function applyStatus(el, text) {
  const cls = text === "交易中" ? "live" : text === "休市" ? "pause" : "closed";
  el.textContent = text || "未知";
  el.className = `status ${cls}`;
}

async function fetchMarket() {
  const response = await fetch(`/api/market?t=${Date.now()}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `行情服务返回 ${response.status}`);
  return payload;
}

function drawLineChart(canvas, series, options = {}) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = Number(canvas.getAttribute("height")) * dpr;
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = Number(canvas.getAttribute("height"));
  const pad = { top: 22, right: 18, bottom: 28, left: 54 };
  ctx.clearRect(0, 0, width, height);

  const values = series.map((item) => item.value).filter(Number.isFinite);
  if (!values.length) {
    ctx.fillStyle = "#766b5c";
    ctx.font = "14px Microsoft YaHei, Arial";
    ctx.fillText("暂无行情数据", 24, 44);
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const y = (value) => pad.top + ((max - value) / span) * (height - pad.top - pad.bottom);
  const x = (index) => pad.left + (index / Math.max(series.length - 1, 1)) * (width - pad.left - pad.right);

  ctx.strokeStyle = "#eadfcb";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#766b5c";
  ctx.font = "12px Microsoft YaHei, Arial";
  for (let i = 0; i <= 4; i += 1) {
    const gy = pad.top + (i / 4) * (height - pad.top - pad.bottom);
    ctx.beginPath();
    ctx.moveTo(pad.left, gy);
    ctx.lineTo(width - pad.right, gy);
    ctx.stroke();
    ctx.fillText((max - (i / 4) * span).toFixed(options.digits ?? 1), 8, gy + 4);
  }

  const rising = values.at(-1) >= values[0];
  const stroke = options.color || (rising ? "#16835b" : "#b73a33");
  const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom);
  gradient.addColorStop(0, rising ? "rgba(22, 131, 91, 0.25)" : "rgba(183, 58, 51, 0.22)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");

  ctx.beginPath();
  series.forEach((point, index) => {
    const px = x(index);
    const py = y(point.value);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.lineTo(x(series.length - 1), height - pad.bottom);
  ctx.lineTo(x(0), height - pad.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  series.forEach((point, index) => {
    const px = x(index);
    const py = y(point.value);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.fillStyle = stroke;
  ctx.beginPath();
  ctx.arc(x(series.length - 1), y(values.at(-1)), 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#766b5c";
  ctx.fillText(options.leftLabel || "", pad.left, height - 8);
  ctx.textAlign = "right";
  ctx.fillText(options.rightLabel || "", width - pad.right, height - 8);
  ctx.textAlign = "left";
}

function summarizeSeries(prices) {
  const closes = prices.map((item) => item.close).filter(Number.isFinite);
  const highs = prices.map((item) => item.high).filter(Number.isFinite);
  const lows = prices.map((item) => item.low).filter(Number.isFinite);
  const first = prices[0];
  const last = prices.at(-1);
  const open = Number.isFinite(first?.open) ? first.open : closes[0];
  const current = last?.close;
  const high = Math.max(...highs, ...closes);
  const low = Math.min(...lows, ...closes);
  return {
    open,
    current,
    high,
    low,
    amplitude: ((high - low) / open) * 100,
    intradayChange: pctChange(current, open),
  };
}

function renderMetrics(china) {
  const amplitude = ((china.high - china.low) / china.open) * 100;
  const change = pctChange(china.latest, china.open);
  const metrics = [
    ["当前价格", formatMoney(china.latest, "¥"), "Au(T+D) 元/克"],
    ["今日开市", formatMoney(china.open, "¥"), "上海黄金交易所"],
    ["今日最高", formatMoney(china.high, "¥"), "上海黄金交易所"],
    ["今日最低", formatMoney(china.low, "¥"), "上海黄金交易所"],
    ["日内涨跌", formatPct(change), "相对今日开市"],
    ["日内振幅", formatPct(amplitude), "最高与最低区间"],
    ["观察策略", amplitude > 1.2 ? "分批等待" : "小额定投", "按波动强度控制仓位"],
    ["风险等级", amplitude > 1.8 ? "偏高" : amplitude > 0.9 ? "中等" : "较低", "仅作观察参考"],
  ];

  $("metricsGrid").innerHTML = metrics
    .map(
      ([label, value, helper]) => `
        <div class="metric">
          <span>${label}</span>
          <strong>${value}</strong>
          <small>${helper}</small>
        </div>
      `
    )
    .join("");

  const badge = $("volatilityBadge");
  if (amplitude > 1.8) {
    badge.textContent = "高波动";
    badge.className = "badge high";
  } else if (amplitude > 0.9) {
    badge.textContent = "中等波动";
    badge.className = "badge medium";
  } else {
    badge.textContent = "低波动";
    badge.className = "badge low";
  }
}

function nearestChange(series, offsetDays) {
  const current = series.at(-1)?.close;
  const targetTime = Date.now() - offsetDays * 24 * 60 * 60 * 1000;
  const prior = series.reduce((best, point) => {
    const distance = Math.abs(new Date(point.time).getTime() - targetTime);
    if (!best || distance < best.distance) return { point, distance };
    return best;
  }, null)?.point?.close;
  return pctChange(current, prior);
}

function renderChanges(world) {
  if (!world?.available || !world.month?.length || !world.ytd?.length) {
    $("changeList").innerHTML = ["较昨天", "较上周", "较上月", "今年以来"]
      .map((label) => `<div class="change-item"><p>${label}</p><strong>待恢复</strong></div>`)
      .join("");
    return;
  }
  const changes = [
    ["较昨天", nearestChange(world.month, 1)],
    ["较上周", nearestChange(world.month, 7)],
    ["较上月", nearestChange(world.month, 30)],
    ["今年以来", pctChange(world.ytd.at(-1)?.close, world.ytd[0]?.close)],
  ];
  $("changeList").innerHTML = changes
    .map(([label, value]) => {
      const direction = value > 0 ? "up" : value < 0 ? "down" : "";
      return `<div class="change-item ${direction}"><p>${label}</p><strong>${formatPct(value)}</strong></div>`;
    })
    .join("");
}

function classifyChange(value) {
  if (!Number.isFinite(value)) return "unknown";
  if (value >= 0.8) return "strong-up";
  if (value >= 0.2) return "up";
  if (value <= -0.8) return "strong-down";
  if (value <= -0.2) return "down";
  return "flat";
}

function buildMarketSignals(payload) {
  const spot = payload.worldSpot || payload.world;
  const futures = payload.worldFutures || {};
  const china = payload.china;
  const icbc = payload.icbcGold;
  const trendSource = futures?.available ? futures : spot;
  const hasTrend = trendSource?.available && trendSource.month?.length && trendSource.ytd?.length;
  const chinaChange = pctChange(china.latest, china.open);
  const chinaAmplitude = ((china.high - china.low) / china.open) * 100;
  const spotSpread = spot?.available ? china.latest - spot.cnyPerGram : null;
  const spotSpreadPct = spot?.available ? (spotSpread / spot.cnyPerGram) * 100 : null;
  const bankSpread = icbc ? icbc.activePrice - icbc.redeemPrice : null;
  const bankSpreadPct = icbc ? (bankSpread / icbc.activePrice) * 100 : null;
  const weekChange = hasTrend ? nearestChange(trendSource.month, 7) : null;
  const monthChange = hasTrend ? nearestChange(trendSource.month, 30) : null;
  const ytdChange = hasTrend ? pctChange(trendSource.ytd.at(-1)?.close, trendSource.ytd[0]?.close) : null;
  const score =
    (classifyChange(chinaChange).includes("up") ? 1 : classifyChange(chinaChange).includes("down") ? -1 : 0) +
    (Number.isFinite(weekChange) ? (weekChange > 0.5 ? 1 : weekChange < -0.5 ? -1 : 0) : 0) +
    (Number.isFinite(monthChange) ? (monthChange > 1 ? 1 : monthChange < -1 ? -1 : 0) : 0) +
    (Number.isFinite(spotSpreadPct) ? (spotSpreadPct > 0.5 ? -0.5 : spotSpreadPct < -0.5 ? 0.5 : 0) : 0);

  return {
    spot,
    futures,
    trendSource,
    hasTrend,
    chinaChange,
    chinaAmplitude,
    spotSpread,
    spotSpreadPct,
    bankSpread,
    bankSpreadPct,
    weekChange,
    monthChange,
    ytdChange,
    score,
    trendLabel: score >= 2 ? "偏强" : score <= -1.5 ? "偏弱" : "震荡",
    volatilityLabel: chinaAmplitude >= 1.2 ? "高波动" : chinaAmplitude >= 0.6 ? "中等波动" : "低波动",
  };
}

function renderDecision(payload) {
  const s = buildMarketSignals(payload);
  const isExpensiveBankEntry = Number.isFinite(s.bankSpreadPct) && s.bankSpreadPct >= 1.5;
  const domesticPremiumHigh = Number.isFinite(s.spotSpreadPct) && s.spotSpreadPct > 0.5;
  const domesticDiscount = Number.isFinite(s.spotSpreadPct) && s.spotSpreadPct < -0.5;
  const intraday = classifyChange(s.chinaChange);
  const trendDataText = s.hasTrend
    ? `期货趋势参考：近一周 ${formatPct(s.weekChange)}，近一月 ${formatPct(s.monthChange)}，今年以来 ${formatPct(s.ytdChange)}。`
    : "国际期货历史趋势暂不可用，当前主要依据国际现货、国内 Au(T+D) 和银行如意金报价判断。";

  const reasons = [
    `国内 Au(T+D) 日内${formatPct(s.chinaChange)}，振幅 ${formatPct(s.chinaAmplitude)}，当前属于${s.volatilityLabel}、${s.trendLabel}观察区间。`,
    Number.isFinite(s.spotSpread)
      ? `国内 Au(T+D) 较国际现货折算价${s.spotSpread >= 0 ? "溢价" : "折价"} ${Math.abs(s.spotSpread).toFixed(2)} 元/克，${domesticPremiumHigh ? "国内买入成本偏高" : domesticDiscount ? "国内价格相对国际现货偏低" : "内外价差处于相对温和区间"}。`
      : "国际现货折算价暂不可用，内外价差无法确认。",
    Number.isFinite(s.bankSpread)
      ? `工行如意金主动积存价与赎回价价差为 ${s.bankSpread.toFixed(2)} 元/克，约 ${formatPct(s.bankSpreadPct)}，${isExpensiveBankEntry ? "短线买入后立即变现成本较高" : "银行渠道买卖价差相对可控"}。`
      : "工行如意金报价暂不可用，银行渠道买卖价差无法确认。",
  ];

  const forecasts = [
    {
      title: "未来 1 天",
      text:
        s.chinaAmplitude >= 1.2
          ? `日内振幅已达 ${formatPct(s.chinaAmplitude)}，短线容易继续拉扯；若价格靠近今日高位，优先等待回落，不宜追高。`
          : intraday.includes("up")
          ? `日内价格小幅走强但振幅不高，若能维持在开盘价上方，可继续观察小额分批机会。`
          : intraday.includes("down")
          ? `日内价格偏弱，短线可能继续测试低位；更适合等企稳或分批低吸，不急于一次买入。`
          : `日内走势接近横盘，预计 1 天内仍以区间震荡为主，适合观察而非重仓出手。`,
    },
    {
      title: "未来 1 周",
      text:
        s.trendLabel === "偏强"
          ? `${trendDataText} 一周维度仍偏强，但如果国内溢价或银行买卖价差扩大，建议用分批买入替代追涨。`
          : s.trendLabel === "偏弱"
          ? `${trendDataText} 一周维度偏谨慎，建议等待回落后的支撑确认，再考虑提高买入比例。`
          : `${trendDataText} 一周维度更像震荡整理，适合维持定投节奏，避免因单日波动改变长期计划。`,
    },
  ];

  const advice = [
    s.trendLabel === "偏强" && s.chinaAmplitude < 1.2
      ? "长期仓位可以维持小额定投或分批加仓，但单次投入不宜过大，避免买在短线高点。"
      : s.trendLabel === "偏弱"
      ? "暂时降低新增投入节奏，把资金拆成多笔，等待价格接近今日低位或重新站回开盘价后再加。"
      : "维持长期定投为主，单日价格没有明显优势时，不建议为了短线波动临时加大仓位。",
    isExpensiveBankEntry
      ? "如意金主动积存价与赎回价差较大时，不适合做短线快进快出；更适合作为长期持有渠道观察。"
      : "如意金买卖价差相对可控时，可把它作为银行渠道的小额积存参考，但仍需分批执行。",
    domesticPremiumHigh
      ? "国内价格较国际现货溢价偏高时，优先等待价差收敛；若必须买入，建议只投入计划金额的一小部分。"
      : domesticDiscount
      ? "国内价格相对国际现货偏低时，可关注小额机会仓，但仍要保留后续补仓资金。"
      : "内外价差温和时，按原定长期配置计划执行即可，不必因为微小价差频繁操作。",
  ];

  $("reasonList").innerHTML = reasons.map((item) => `<li>${item}</li>`).join("");
  $("forecastList").innerHTML = forecasts
    .map((item) => `<div class="forecast"><strong>${item.title}</strong><span>${item.text}</span></div>`)
    .join("");
  $("adviceList").innerHTML = advice.map((item) => `<li>${item}</li>`).join("");
}

function makeChinaOhlcSeries(china) {
  return [
    { value: china.open },
    { value: china.low },
    { value: china.high },
    { value: china.latest },
  ].filter((item) => Number.isFinite(item.value));
}

function renderPayload(payload) {
  state.lastPayload = payload;
  applyStatus($("worldStatus"), payload.status.world);
  applyStatus($("chinaStatus"), payload.status.china);

  const spot = payload.worldSpot || payload.world;
  const futures = payload.worldFutures || {};
  $("worldUsd").textContent = spot?.available ? formatMoney(spot.usdPerOunce, "$") : "暂不可用";
  $("worldCnyGram").textContent = spot?.available ? formatMoney(spot.cnyPerGram, "¥") : "暂不可用";
  $("futuresUsd").textContent = futures?.available ? formatMoney(futures.usdPerOunce, "$") : "暂不可用";
  $("futuresCnyGram").textContent = futures?.available ? formatMoney(futures.cnyPerGram, "¥") : "暂不可用";
  $("chinaCnyGram").textContent = formatMoney(payload.china.latest, "¥");
  const spread = spot?.available ? payload.china.latest - spot.cnyPerGram : null;
  $("chinaPremium").textContent = Number.isFinite(spread)
    ? `${spread >= 0 ? "+" : ""}${spread.toFixed(2)} 元/克`
    : "现货源待恢复";

  $("worldSource").textContent = [
    spot?.available
      ? `现货：${spot.source} ${spot.symbol}；${spot.note}`
      : `现货：${spot?.source || "国际现货源"}暂不可用；${spot?.error || ""}`,
    futures?.available
      ? `期货：${futures.source} ${futures.symbol}；${futures.note}`
      : `期货：${futures?.source || "国际期货源"}暂不可用；${futures?.error || ""}`,
    `汇率：${payload.fx?.source || "汇率源"} ${payload.fx?.rate?.toFixed(4) || "--"}`,
  ].join(" ｜ ");
  $("chinaSource").textContent = `数据源：${payload.china.source} ${payload.china.symbol}；${payload.china.timeText || payload.china.title}`;
  if (payload.icbcGold) {
    $("icbcActivePrice").textContent = formatMoney(payload.icbcGold.activePrice, "¥");
    $("icbcRedeemPrice").textContent = formatMoney(payload.icbcGold.redeemPrice, "¥");
    $("icbcStatus").textContent = payload.icbcGold.cached ? "缓存" : "已更新";
    $("icbcStatus").className = payload.icbcGold.cached ? "badge medium" : "badge low";
    $("icbcSource").textContent = `数据源：${payload.icbcGold.source}；${payload.icbcGold.timeText || "以工行页面为准"}`;
  } else {
    $("icbcActivePrice").textContent = "暂不可用";
    $("icbcRedeemPrice").textContent = "暂不可用";
    $("icbcStatus").textContent = "不可用";
    $("icbcStatus").className = "badge high";
    $("icbcSource").textContent = "数据源：工商银行积存金行情暂不可用";
  }
  $("dataStateInput").value = payload.cacheUsed
    ? `使用缓存：${new Date(payload.cacheTime || payload.fetchedAt).toLocaleString("zh-CN", { hour12: false })}`
    : payload.warnings?.length
    ? "已使用备选通道"
    : "实时数据已更新";
  $("dataNotice").className = "notice";
  $("dataNotice").innerHTML = payload.cacheUsed
    ? `<strong>使用上次成功数据：</strong>全部或部分实时源暂不可用，页面保持上次成功行情；上次数据时间：${new Date(
        payload.cacheTime || payload.fetchedAt
      ).toLocaleString("zh-CN", { hour12: false })}。${payload.warnings?.join("；") || ""}`
    : payload.warnings?.length
    ? `<strong>已启用备选通道：</strong>${payload.warnings.join("；")}。页面未生成模拟行情。`
    : "<strong>实时数据：</strong>当前页面只展示服务端抓取到的最新行情；国际现货为新浪 hf_XAU，国际期货为 Yahoo GC=F，国内为上金所 Au(T+D) 延时行情。";

  renderMetrics(payload.china);
  renderChanges(futures?.available ? futures : spot);
  renderDecision(payload);

  drawLineChart(
    $("worldChart"),
    spot?.available ? spot.intraday.map((point) => ({ value: point.close })) : [],
    { leftLabel: "现货开盘", rightLabel: "现货最新", digits: 0 }
  );
  drawLineChart($("chinaChart"), makeChinaOhlcSeries(payload.china), {
    leftLabel: "OHLC",
    rightLabel: "最新",
    digits: 1,
    color: "#285d8f",
  });
  drawLineChart(
    $("periodChart"),
    futures?.available && payload.fx?.rate && futures.ytd?.length
      ? futures.ytd.map((point) => ({ value: (point.close * payload.fx.rate) / OUNCE_TO_GRAM }))
      : [],
    { leftLabel: "期货年初", rightLabel: "期货当前", digits: 1 }
  );

  $("lastUpdated").textContent = `更新于 ${new Date(payload.fetchedAt).toLocaleString("zh-CN", {
    hour12: false,
  })}${payload.cacheUsed ? `（数据时间 ${new Date(payload.cacheTime || payload.fetchedAt).toLocaleString("zh-CN", { hour12: false })}）` : ""}`;
}

function renderError(error) {
  $("dataStateInput").value = "实时数据获取失败";
  $("dataNotice").className = "notice error";
  $("dataNotice").innerHTML = `<strong>实时数据获取失败：</strong>${error.message}。页面未生成模拟行情，请稍后刷新或检查网络/数据源。`;
}

async function updateDashboard() {
  const refreshBtn = $("refreshBtn");
  refreshBtn.disabled = true;
  refreshBtn.textContent = "刷新中";
  $("dataStateInput").value = "正在请求实时数据";
  try {
    renderPayload(await fetchMarket());
  } catch (error) {
    console.error(error);
    renderError(error);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "刷新行情";
  }
}

function setupAutoRefresh() {
  clearInterval(state.refreshTimer);
  state.intervalSeconds = Math.max(30, Number($("intervalInput").value) || 60);
  state.refreshTimer = setInterval(updateDashboard, state.intervalSeconds * 1000);
}

window.addEventListener("resize", () => {
  clearTimeout(state.resizeTimer);
  state.resizeTimer = setTimeout(() => {
    if (state.lastPayload) renderPayload(state.lastPayload);
  }, 250);
});

$("refreshBtn").addEventListener("click", updateDashboard);
$("intervalInput").addEventListener("change", setupAutoRefresh);

setupAutoRefresh();
updateDashboard();
