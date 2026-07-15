/**
 * CFSpeedSync modern Cloudflare Worker dashboard.
 *
 * Deployment:
 * 1. Create a Cloudflare Worker using the Modules syntax.
 * 2. Bind the project's KV namespace as `KV_NAMESPACE`.
 * 3. Adjust CONFIG below and deploy this file.
 */

const CONFIG = Object.freeze({
  brand: 'CFSpeedSync',
  provider: 'Cloudflare',
  publicDomain: 'cname.example.com',
  wildcardDomain: true,
  checkIntervalMinutes: 30,
  refreshIntervalHours: 24,
  kvBinding: 'KV_NAMESPACE',
});

const DATA_SUFFIXES = Object.freeze([
  'ipv4',
  'ipv4time',
  'ipv6',
  'ipv6time',
  'excellent_ipv4',
  'excellent_ipv6',
]);

const REGION_NAMES = Object.freeze({
  HKG: '香港',
  NRT: '东京',
  KIX: '大阪',
  SIN: '新加坡',
  TPE: '台北',
  ICN: '首尔',
  SJC: '圣何塞',
  LAX: '洛杉矶',
  SEA: '西雅图',
  FRA: '法兰克福',
  LHR: '伦敦',
  AMS: '阿姆斯特丹',
  CDG: '巴黎',
  SYD: '悉尼',
});

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return textResponse('Method not allowed', 405, { Allow: 'GET, HEAD, OPTIONS' });
    }

    const url = new URL(request.url);

    if (url.pathname === '/favicon.svg') {
      return new Response(renderFavicon(), {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          ...SECURITY_HEADERS,
        },
      });
    }

    if (url.pathname === '/healthz') {
      return jsonResponse({ ok: true, service: CONFIG.brand });
    }

    if (!['/', '/api/nodes'].includes(url.pathname)) {
      return textResponse('Not found', 404);
    }

    const kv = env[CONFIG.kvBinding];
    if (!kv || typeof kv.get !== 'function' || typeof kv.list !== 'function') {
      const message = `Missing KV binding: ${CONFIG.kvBinding}`;
      if (url.pathname === '/api/nodes') {
        return jsonResponse({ error: message }, 503);
      }
      return htmlResponse(renderErrorPage(message), 503);
    }

    try {
      const index = await discoverData(kv);
      const requestedPrefix = url.searchParams.get('prefix') || '';
      const selectedPrefix = index.prefixes.includes(requestedPrefix) ? requestedPrefix : '';
      const requestedSource = url.searchParams.get('source') === 'pool' ? 'pool' : 'latest';
      const selectedSource = requestedSource === 'pool' && index.hasPool ? 'pool' : 'latest';
      const snapshot = await loadSnapshot(kv, index, selectedPrefix, selectedSource);

      if (url.pathname === '/api/nodes') {
        return jsonResponse({
          service: CONFIG.brand,
          provider: CONFIG.provider,
          generated_at: new Date().toISOString(),
          selected_prefix: selectedPrefix || null,
          source: selectedSource,
          available_prefixes: index.prefixes,
          data: snapshot,
        });
      }

      return htmlResponse(renderPage({
        index,
        selectedPrefix,
        selectedSource,
        snapshot,
      }));
    } catch (error) {
      console.error('CFSpeedSync Worker error', error);
      if (url.pathname === '/api/nodes') {
        return jsonResponse({ error: 'Unable to read node data' }, 500);
      }
      return htmlResponse(renderErrorPage('Unable to read node data'), 500);
    }
  },
};

async function discoverData(kv) {
  const keys = [];
  let cursor;

  do {
    const page = await kv.list(cursor ? { cursor } : undefined);
    keys.push(...page.keys.map((item) => item.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const keySet = new Set(keys);
  const prefixes = new Set();
  let hasPool = false;

  for (const key of keys) {
    const parsed = parseDataKey(key);
    if (!parsed) continue;
    if (parsed.prefix) prefixes.add(parsed.prefix);
    if (parsed.suffix.startsWith('excellent_')) hasPool = true;
  }

  return {
    keys: keySet,
    prefixes: Array.from(prefixes).sort((a, b) => a.localeCompare(b)),
    hasPool,
  };
}

function parseDataKey(key) {
  for (const suffix of DATA_SUFFIXES) {
    if (key === suffix) return { prefix: '', suffix };
    const marker = `:${suffix}`;
    if (key.endsWith(marker)) {
      return { prefix: key.slice(0, -marker.length), suffix };
    }
  }
  return null;
}

async function loadSnapshot(kv, index, selectedPrefix, source) {
  const scopes = selectedPrefix
    ? [selectedPrefix]
    : ['', ...index.prefixes];

  const [ipv4, ipv6] = await Promise.all([
    loadFamily(kv, index.keys, scopes, source, 'ipv4'),
    loadFamily(kv, index.keys, scopes, source, 'ipv6'),
  ]);

  return { ipv4, ipv6 };
}

async function loadFamily(kv, keySet, scopes, source, family) {
  const dataSuffix = source === 'pool' ? `excellent_${family}` : family;
  const timeSuffix = `${family}time`;
  const availableScopes = scopes.filter((scope) => keySet.has(scopedKey(scope, dataSuffix)));

  if (availableScopes.length === 0) {
    return { rows: [], updatedAt: null };
  }

  if (source === 'pool') {
    const values = await Promise.all(
      availableScopes.map((scope) => kv.get(scopedKey(scope, dataSuffix))),
    );
    const rows = [];
    let updatedAt = null;

    values.forEach((value, index) => {
      const scope = availableScopes[index];
      const parsedRows = parsePoolRows(value, scope);
      rows.push(...parsedRows);
      for (const row of parsedRows) {
        if (row.addedAt && (!updatedAt || row.addedAt > updatedAt)) updatedAt = row.addedAt;
      }
    });

    return { rows: sortRows(rows, 'speed'), updatedAt };
  }

  const values = await Promise.all(availableScopes.flatMap((scope) => [
    kv.get(scopedKey(scope, dataSuffix)),
    keySet.has(scopedKey(scope, timeSuffix))
      ? kv.get(scopedKey(scope, timeSuffix))
      : Promise.resolve(null),
  ]));

  const rows = [];
  let updatedAt = null;
  availableScopes.forEach((scope, index) => {
    const rawData = values[index * 2];
    const rawTime = values[index * 2 + 1];
    rows.push(...parseLatestRows(rawData, scope));
    if (rawTime && (!updatedAt || rawTime > updatedAt)) updatedAt = rawTime;
  });

  return { rows: sortRows(rows, 'speed'), updatedAt };
}

function scopedKey(scope, suffix) {
  return scope ? `${scope}:${suffix}` : suffix;
}

function parseLatestRows(raw, scope) {
  if (!raw || typeof raw !== 'string') return [];

  return raw.split('&').flatMap((record) => {
    const fields = parseCSVRecord(record);
    if (fields.length !== 7 || !fields[0]) return [];
    return [normalizeRow({
      ip: fields[0],
      packets: fields[1],
      received: fields[2],
      loss: fields[3],
      latency: fields[4],
      speed: fields[5],
      colo: fields[6],
      scope,
      addedAt: null,
    })];
  });
}

function parsePoolRows(raw, scope) {
  if (!raw || typeof raw !== 'string') return [];

  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.flatMap((item) => {
      if (!item || typeof item !== 'object' || !item.ip) return [];
      const rawLoss = finiteNumber(item.loss_rate);
      const lossPercent = rawLoss <= 1 ? rawLoss * 100 : rawLoss;
      return [normalizeRow({
        ip: item.ip,
        packets: item.packets,
        received: item.received,
        loss: lossPercent,
        latency: item.delay,
        speed: item.speed,
        colo: item.colo,
        scope,
        addedAt: item.added_time || null,
      })];
    });
  } catch (error) {
    console.warn('Invalid excellent pool JSON', error);
    return [];
  }
}

function parseCSVRecord(record) {
  const values = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < record.length; index += 1) {
    const char = record[index];
    if (char === '"') {
      if (quoted && record[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }

  values.push(value.trim());
  return values;
}

function normalizeRow(row) {
  return {
    ip: String(row.ip || '').trim(),
    packets: Math.max(0, Math.trunc(finiteNumber(row.packets))),
    received: Math.max(0, Math.trunc(finiteNumber(row.received))),
    loss: Math.max(0, finiteNumber(row.loss)),
    latency: Math.max(0, finiteNumber(row.latency)),
    speed: Math.max(0, finiteNumber(row.speed)),
    colo: String(row.colo || 'N/A').trim() || 'N/A',
    scope: String(row.scope || ''),
    addedAt: row.addedAt ? String(row.addedAt) : null,
  };
}

function finiteNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

function sortRows(rows, sortBy) {
  return [...rows].sort((a, b) => {
    if (sortBy === 'latency') return a.latency - b.latency || b.speed - a.speed;
    if (sortBy === 'loss') return a.loss - b.loss || b.speed - a.speed;
    return b.speed - a.speed || a.latency - b.latency;
  });
}

function renderPage({ index, selectedPrefix, selectedSource, snapshot }) {
  const initialFamily = snapshot.ipv4.rows.length > 0 ? 'ipv4' : 'ipv6';
  const initialData = snapshot[initialFamily];
  const initialBestSpeed = initialData.rows.length
    ? Math.max(...initialData.rows.map((row) => row.speed))
    : 0;
  const appData = {
    initialFamily,
    families: {
      ipv4: summarize(snapshot.ipv4),
      ipv6: summarize(snapshot.ipv6),
    },
  };
  const pageTitle = selectedPrefix ? friendlyScope(selectedPrefix) : '全部线路';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#11131a">
  <meta name="description" content="${escapeHTML(CONFIG.provider)} 优选 IP 节点观测台">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>${escapeHTML(CONFIG.brand)} · ${escapeHTML(pageTitle)}</title>
  <style>${renderStyles()}</style>
</head>
<body>
  <header class="site-header">
    <div class="shell site-header-inner">
      <a class="brand" href="/" aria-label="${escapeHTML(CONFIG.brand)} home">
        <span class="brand-mark" aria-hidden="true">${iconActivity()}</span>
        <span>
          <strong>${escapeHTML(CONFIG.brand)}</strong>
          <small>EDGE OBSERVATORY</small>
        </span>
      </a>
      <div class="header-utility">
        <a class="api-link" href="/api/nodes">API</a>
        <div class="topbar-status">
          <span class="live-dot" aria-hidden="true"></span>
          数据在线
        </div>
      </div>
    </div>
  </header>

  <main class="shell main">
    <section class="hero" aria-labelledby="page-title">
      <div class="hero-copy">
        <p class="eyebrow"><span></span>${escapeHTML(CONFIG.provider)} / EDGE NETWORK</p>
        <h1 id="page-title">优选节点，<em>一眼识别。</em></h1>
        <p class="subtitle">${escapeHTML(pageTitle)} · ${selectedSource === 'pool' ? '优良库' : '最新测速'} · 面向更快、更稳的连接</p>
      </div>
      <div class="hero-panel">
        <div>
          <span class="hero-label">当前最快</span>
          <strong class="hero-number"><span id="hero-speed">${formatNumber(initialBestSpeed)}</span><small>MB/s</small></strong>
        </div>
        <div class="hero-meta">
          <span>最近同步</span>
          <strong id="hero-updated">${escapeHTML(initialData.updatedAt || '等待同步')}</strong>
        </div>
        ${renderPublicDomain()}
      </div>
    </section>

    <section class="scope-deck">
      <div class="scope-deck-title"><span>线路选择</span><small>${index.prefixes.length ? `${index.prefixes.length} 个可用网络` : '默认数据源'}</small></div>
      ${renderScopeNav(index.prefixes, selectedPrefix, selectedSource)}
    </section>

    <section class="summary" aria-label="当前数据摘要">
      ${renderSummaryItem('可用节点', 'summary-count', '0')}
      ${renderSummaryItem('峰值速度', 'summary-speed', '0 MB/s')}
      ${renderSummaryItem('最低延迟', 'summary-latency', '0 ms')}
      ${renderSummaryItem('数据更新', 'summary-updated', '暂无数据')}
    </section>

    <section class="workspace" aria-label="节点数据">
      <div class="workspace-head">
        <div><span class="section-kicker">NODE DIRECTORY</span><h2>可用节点池</h2></div>
        ${renderSourceSwitch(index.hasPool, selectedPrefix, selectedSource)}
      </div>
      <div class="toolbar">
        <div class="segmented" aria-label="IP version">
          ${renderFamilyButton('ipv4', 'IPv4', snapshot.ipv4.rows.length, initialFamily)}
          ${renderFamilyButton('ipv6', 'IPv6', snapshot.ipv6.rows.length, initialFamily)}
        </div>

        ${renderSourceSwitch(index.hasPool, selectedPrefix, selectedSource)}

        <label class="search">
          <span class="sr-only">搜索节点</span>
          ${iconSearch()}
          <input id="search-input" type="search" placeholder="搜索 IP、地区或线路" autocomplete="off">
        </label>

        <label class="sort-select">
          <span class="sr-only">节点排序</span>
          <select id="sort-select" aria-label="节点排序">
            <option value="speed">速度优先</option>
            <option value="latency">延迟优先</option>
            <option value="loss">丢包优先</option>
          </select>
          ${iconChevronDown()}
        </label>

        <button class="icon-button" id="refresh-button" type="button" title="刷新数据" aria-label="刷新数据">
          ${iconRefresh()}
        </button>
      </div>

      ${renderFamilyPanel('ipv4', snapshot.ipv4, initialFamily, selectedPrefix)}
      ${renderFamilyPanel('ipv6', snapshot.ipv6, initialFamily, selectedPrefix)}

      <div class="no-results" id="no-results" hidden>
        ${iconSearchLarge()}
        <strong>没有匹配的节点</strong>
        <span>请尝试其他搜索内容</span>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="shell footer-inner">
      <span>${escapeHTML(CONFIG.brand)} <i></i> ${escapeHTML(CONFIG.provider)}</span>
      <span>节点探测 ${CONFIG.checkIntervalMinutes} 分钟 · 数据刷新 ${CONFIG.refreshIntervalHours} 小时</span>
      <a href="/api/nodes">公开 JSON 接口</a>
    </div>
  </footer>

  <div class="toast" id="toast" role="status" aria-live="polite">
    ${iconCheck()}<span>IP 已复制</span>
  </div>

  <script>window.__CFSPEEDSYNC__=${safeJSON(appData)};</script>
  <script>${renderClientScript()}</script>
</body>
</html>`;
}

function renderScopeNav(prefixes, selectedPrefix, selectedSource) {
  if (prefixes.length === 0) return '<div class="scope-nav scope-nav-single"><span>当前使用默认 KV 数据源</span></div>';
  const items = [
    scopeLink('', '全部线路', selectedPrefix, selectedSource),
    ...prefixes.map((prefix) => scopeLink(prefix, friendlyScope(prefix), selectedPrefix, selectedSource)),
  ];
  return `<nav class="scope-nav" aria-label="网络线路">${items.join('')}</nav>`;
}

function scopeLink(prefix, label, selectedPrefix, source) {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  if (source === 'pool') params.set('source', 'pool');
  const href = params.size ? `/?${params.toString()}` : '/';
  const active = prefix === selectedPrefix;
  return `<a class="scope-link${active ? ' active' : ''}" href="${escapeHTML(href)}"${active ? ' aria-current="page"' : ''}>${escapeHTML(label)}</a>`;
}

function renderSourceSwitch(hasPool, selectedPrefix, selectedSource) {
  if (!hasPool) return '';
  const latestParams = new URLSearchParams();
  const poolParams = new URLSearchParams({ source: 'pool' });
  if (selectedPrefix) {
    latestParams.set('prefix', selectedPrefix);
    poolParams.set('prefix', selectedPrefix);
  }
  const latestHref = latestParams.size ? `/?${latestParams.toString()}` : '/';
  const poolHref = `/?${poolParams.toString()}`;
  return `<div class="source-switch" aria-label="数据来源">
    <a href="${escapeHTML(latestHref)}" class="${selectedSource === 'latest' ? 'active' : ''}">最新结果</a>
    <a href="${escapeHTML(poolHref)}" class="${selectedSource === 'pool' ? 'active' : ''}">优良库</a>
  </div>`;
}

function renderFamilyButton(family, label, count, initialFamily) {
  if (count === 0) return '';
  const active = family === initialFamily;
  return `<button type="button" class="family-button${active ? ' active' : ''}" data-family="${family}"${active ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${label}<span>${count}</span></button>`;
}

function renderFamilyPanel(family, data, initialFamily, selectedPrefix) {
  const active = family === initialFamily;
  const maxSpeed = Math.max(0, ...data.rows.map((row) => row.speed));
  const cards = data.rows.map((row, index) => renderNodeCard(row, index, maxSpeed, selectedPrefix)).join('');
  return `<div class="family-panel${active ? ' active' : ''}" id="panel-${family}" data-family="${family}"${active ? '' : ' hidden'}>
    <div class="node-grid">${cards}</div>
    ${data.rows.length === 0 ? renderEmptyState(family) : ''}
  </div>`;
}

function renderNodeCard(row, index, maxSpeed, selectedPrefix) {
  const width = maxSpeed > 0 ? Math.max(3, Math.min(100, (row.speed / maxSpeed) * 100)) : 0;
  const quality = row.loss <= 0 && row.latency < 100 ? 'excellent' : row.loss <= 1 && row.latency < 180 ? 'good' : 'attention';
  const scope = row.scope ? friendlyScope(row.scope) : '默认';
  const operatorClass = operatorTone(row.scope);
  const searchable = `${row.ip} ${row.colo} ${regionLabel(row.colo)} ${scope}`.toLowerCase();

  return `<article class="node-card ${operatorClass}"
      data-ip="${escapeHTML(row.ip.toLowerCase())}"
      data-search="${escapeHTML(searchable)}"
      data-speed="${row.speed}"
      data-latency="${row.latency}"
      data-loss="${row.loss}">
    <header class="card-topline">
      <span class="rank"><span>排名</span><b class="rank-value">${String(index + 1).padStart(2, '0')}</b></span>
      <div class="card-actions">
        ${selectedPrefix ? '' : `<span class="scope-tag">${escapeHTML(scope)}</span>`}
        <button class="copy-button" type="button" data-copy-ip="${escapeHTML(row.ip)}" title="复制 IP" aria-label="复制 ${escapeHTML(row.ip)}">${iconCopy()}</button>
      </div>
    </header>

    <div class="address-row"><code>${escapeHTML(row.ip)}</code></div>

    <div class="location-row">
      ${iconMapPin()}<strong>${escapeHTML(regionLabel(row.colo))}</strong><span>${escapeHTML(row.colo)}</span>
      <span class="quality ${quality}"><i></i>${quality === 'excellent' ? '极佳' : quality === 'good' ? '良好' : '关注'}</span>
    </div>

    <div class="metrics">
      <div class="speed-metric">
        <span>下载速度</span>
        <strong>${formatNumber(row.speed)}<small>MB/s</small></strong>
      </div>
      <div>
        <span>网络延迟</span>
        <strong>${formatNumber(row.latency)}<small>ms</small></strong>
      </div>
    </div>

    <div class="speed-track" aria-hidden="true"><i style="width:${width.toFixed(2)}%"></i></div>
    <div class="card-foot"><span>丢包 <b>${formatNumber(row.loss)}%</b></span><span>收包 <b>${row.received}/${row.packets}</b></span></div>
  </article>`;
}

function renderEmptyState(family) {
  return `<div class="empty-state">
    ${iconServerLarge()}
    <strong>暂无 ${family.toUpperCase()} 数据</strong>
    <span>当前 KV 命名空间中没有此视图的测速结果</span>
  </div>`;
}

function renderSummaryItem(label, id, value) {
  return `<div class="summary-item">
    <small>${label}</small><strong id="${id}">${escapeHTML(value)}</strong>
  </div>`;
}

function renderPublicDomain() {
  const isConfigured = CONFIG.publicDomain && !CONFIG.publicDomain.endsWith('example.com');
  if (!isConfigured) return '';
  const value = `${CONFIG.wildcardDomain ? '*.' : ''}${CONFIG.publicDomain}`;
  return `<button class="domain-chip" type="button" data-copy-ip="${escapeHTML(CONFIG.publicDomain)}" title="复制公共域名">
    <span>${iconGlobe()}</span><code>${escapeHTML(value)}</code>${iconCopy()}
  </button>`;
}

function summarize(data) {
  const rows = data.rows;
  const latencies = rows.map((row) => row.latency).filter((value) => value > 0);
  return {
    count: rows.length,
    bestSpeed: rows.length ? Math.max(...rows.map((row) => row.speed)) : 0,
    lowestLatency: latencies.length ? Math.min(...latencies) : 0,
    updatedAt: data.updatedAt || null,
  };
}

function friendlyScope(prefix) {
  if (!prefix) return '默认';
  const code = prefix.split('.')[0].toLowerCase();
  const names = {
    ct: '中国电信',
    dx: '中国电信',
    telecom: '中国电信',
    cm: '中国移动',
    yd: '中国移动',
    mobile: '中国移动',
    cu: '中国联通',
    lt: '中国联通',
    unicom: '中国联通',
    wjt: '天威视讯',
  };
  return names[code] || prefix;
}

function operatorTone(prefix) {
  const code = (prefix || '').split('.')[0].toLowerCase();
  if (['ct', 'dx', 'telecom'].includes(code)) return 'tone-blue';
  if (['cm', 'yd', 'mobile'].includes(code)) return 'tone-green';
  if (['cu', 'lt', 'unicom'].includes(code)) return 'tone-amber';
  return 'tone-neutral';
}

function regionLabel(colo) {
  if (!colo || colo === 'N/A') return '未知地区';
  return REGION_NAMES[colo.toUpperCase()] || colo.toUpperCase();
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function escapeHTML(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeJSON(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
      ...SECURITY_HEADERS,
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
      'Access-Control-Allow-Origin': '*',
      ...SECURITY_HEADERS,
    },
  });
}

function textResponse(text, status, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    },
  });
}

function renderErrorPage(message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(CONFIG.brand)}</title><style>${renderStyles()}</style></head><body><main class="error-page"><span>${iconServerLarge()}</span><h1>观测台暂时不可用</h1><p>${escapeHTML(message)}</p></main></body></html>`;
}

function renderClientScript() {
  return `
  (function () {
    'use strict';

    var app = window.__CFSPEEDSYNC__;
    var activeFamily = app.initialFamily;
    var searchInput = document.getElementById('search-input');
    var sortSelect = document.getElementById('sort-select');
    var noResults = document.getElementById('no-results');
    var toast = document.getElementById('toast');
    var toastTimer;

    function updateSummary() {
      var data = app.families[activeFamily];
      document.getElementById('summary-count').textContent = String(data.count);
      document.getElementById('summary-speed').textContent = format(data.bestSpeed) + ' MB/s';
      document.getElementById('summary-latency').textContent = format(data.lowestLatency) + ' ms';
      var updated = document.getElementById('summary-updated');
      updated.textContent = formatUpdatedAt(data.updatedAt);
      updated.title = data.updatedAt || '';
      var heroSpeed = document.getElementById('hero-speed');
      var heroUpdated = document.getElementById('hero-updated');
      if (heroSpeed) heroSpeed.textContent = format(data.bestSpeed);
      if (heroUpdated) heroUpdated.textContent = data.updatedAt || '等待同步';
    }

    function format(value) {
      return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
    }

    function formatUpdatedAt(value) {
      if (!value) return '暂无数据';
      var looksLikeTimestamp = value.length >= 16 && value.charAt(4) === '-' && value.charAt(7) === '-' && value.charAt(10) === ' ';
      if (window.innerWidth <= 540 && looksLikeTimestamp) {
        return value.slice(5, 16);
      }
      return value;
    }

    function activePanel() {
      return document.getElementById('panel-' + activeFamily);
    }

    function applyView() {
      var panel = activePanel();
      if (!panel) return;
      var grid = panel.querySelector('.node-grid');
      if (!grid) return;
      var query = searchInput.value.trim().toLowerCase();
      var sortBy = sortSelect.value;
      var cards = Array.prototype.slice.call(grid.querySelectorAll('.node-card'));

      cards.sort(function (a, b) {
        var av = Number(a.dataset[sortBy]);
        var bv = Number(b.dataset[sortBy]);
        if (sortBy === 'speed') return bv - av || Number(a.dataset.latency) - Number(b.dataset.latency);
        return av - bv || Number(b.dataset.speed) - Number(a.dataset.speed);
      });

      var visible = 0;
      cards.forEach(function (card) {
        var matches = !query || card.dataset.search.indexOf(query) !== -1;
        card.hidden = !matches;
        if (matches) {
          visible += 1;
          card.querySelector('.rank-value').textContent = String(visible);
        }
        grid.appendChild(card);
      });

      noResults.hidden = visible !== 0 || cards.length === 0;
    }

    function setFamily(family) {
      activeFamily = family;
      document.querySelectorAll('.family-panel').forEach(function (panel) {
        var active = panel.dataset.family === family;
        panel.hidden = !active;
        panel.classList.toggle('active', active);
      });
      document.querySelectorAll('.family-button').forEach(function (button) {
        var active = button.dataset.family === family;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      updateSummary();
      applyView();
    }

    function showToast(label) {
      toast.querySelector('span').textContent = label;
      toast.classList.add('visible');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toast.classList.remove('visible'); }, 1800);
    }

    function copyText(value) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(value).then(function () { showToast('已复制 ' + value); });
        return;
      }
      var area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      showToast('已复制 ' + value);
    }

    document.addEventListener('click', function (event) {
      var familyButton = event.target.closest('.family-button');
      if (familyButton) setFamily(familyButton.dataset.family);

      var copyButton = event.target.closest('[data-copy-ip]');
      if (copyButton) copyText(copyButton.dataset.copyIp);
    });

    searchInput.addEventListener('input', applyView);
    sortSelect.addEventListener('change', applyView);
    window.addEventListener('resize', updateSummary);
    document.getElementById('refresh-button').addEventListener('click', function () {
      this.classList.add('spinning');
      location.reload();
    });

    updateSummary();
    applyView();
  }());`;
}

function renderLegacyStyles() {
  return `
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    color-scheme: light;
    --bg: #f7f8fa;
    --surface: #ffffff;
    --surface-subtle: #f0f2f5;
    --text: #171a1f;
    --muted: #68707c;
    --border: #dfe3e8;
    --border-strong: #c8cdd4;
    --blue: #1769e0;
    --blue-soft: #eaf2ff;
    --green: #07875d;
    --green-soft: #e8f7f1;
    --amber: #b96800;
    --amber-soft: #fff3df;
    --red: #c33b37;
    --shadow: 0 12px 32px rgba(26, 31, 39, 0.08);
  }
  html { min-width: 320px; background: var(--bg); }
  body {
    margin: 0;
    min-height: 100vh;
    color: var(--text);
    background: var(--bg);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 15px;
    line-height: 1.5;
  }
  button, input, select { font: inherit; letter-spacing: 0; }
  button, a { -webkit-tap-highlight-color: transparent; }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible {
    outline: 3px solid rgba(23, 105, 224, 0.24);
    outline-offset: 2px;
  }
  [hidden] { display: none !important; }
  .shell { width: min(1360px, calc(100% - 40px)); margin: 0 auto; }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
  .topbar { height: 72px; background: var(--surface); border-bottom: 1px solid var(--border); }
  .topbar-inner { height: 100%; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .brand { display: inline-flex; align-items: center; gap: 11px; color: var(--text); text-decoration: none; }
  .brand-mark {
    width: 38px; height: 38px; display: grid; place-items: center; color: white;
    background: #171a1f; border: 1px solid #171a1f; border-radius: 8px;
  }
  .brand-mark svg { width: 21px; height: 21px; }
  .brand > span:last-child { display: flex; flex-direction: column; }
  .brand strong { font-size: 16px; line-height: 1.25; letter-spacing: 0; }
  .brand small { color: var(--muted); font-size: 11px; line-height: 1.4; }
  .topbar-status {
    display: inline-flex; align-items: center; gap: 8px; color: var(--green);
    border: 1px solid #bfe8d8; background: var(--green-soft); border-radius: 999px;
    padding: 6px 10px; font-size: 12px; font-weight: 700;
  }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 4px rgba(7, 135, 93, 0.12); }
  .main { padding-top: 48px; padding-bottom: 72px; }
  .page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 30px; }
  .eyebrow { margin: 0 0 7px; color: var(--blue); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
  h1 { margin: 0; font-size: 34px; line-height: 1.12; letter-spacing: 0; }
  .subtitle { margin: 9px 0 0; color: var(--muted); }
  .domain-chip {
    min-width: 0; display: inline-flex; align-items: center; gap: 9px; padding: 9px 11px;
    border: 1px solid var(--border); border-radius: 7px; color: var(--text); background: var(--surface); cursor: pointer;
  }
  .domain-chip svg { width: 16px; height: 16px; color: var(--muted); flex: 0 0 auto; }
  .domain-chip code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scope-nav {
    display: flex; gap: 4px; overflow-x: auto; margin: 0 0 18px; padding: 4px;
    background: #e9ecf0; border-radius: 8px; scrollbar-width: thin;
  }
  .scope-link {
    flex: 0 0 auto; padding: 8px 14px; border: 1px solid transparent; border-radius: 6px;
    color: var(--muted); text-decoration: none; font-size: 13px; font-weight: 700;
  }
  .scope-link:hover { color: var(--text); }
  .scope-link.active { color: var(--text); background: var(--surface); border-color: var(--border); box-shadow: 0 1px 3px rgba(20, 24, 31, 0.08); }
  .summary {
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-bottom: 18px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  }
  .summary-item { min-width: 0; display: flex; align-items: center; gap: 12px; padding: 17px 18px; border-right: 1px solid var(--border); }
  .summary-item:last-child { border-right: 0; }
  .summary-icon { flex: 0 0 auto; width: 34px; height: 34px; display: grid; place-items: center; color: var(--blue); background: var(--blue-soft); border-radius: 7px; }
  .summary-icon svg { width: 17px; height: 17px; }
  .summary-item > span:last-child { min-width: 0; display: flex; flex-direction: column; }
  .summary-item small { color: var(--muted); font-size: 11px; }
  .summary-item strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; }
  #summary-updated { white-space: normal; line-height: 1.25; }
  .workspace { min-width: 0; }
  .toolbar { display: flex; align-items: center; gap: 9px; margin-bottom: 18px; }
  .segmented, .source-switch { display: inline-flex; padding: 3px; background: #e9ecf0; border-radius: 7px; }
  .family-button, .source-switch a {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px;
    padding: 6px 11px; color: var(--muted); background: transparent; border: 1px solid transparent;
    border-radius: 5px; text-decoration: none; font-size: 12px; font-weight: 800; cursor: pointer;
  }
  .family-button span { min-width: 19px; padding: 1px 5px; border-radius: 999px; color: var(--muted); background: rgba(104, 112, 124, 0.12); font-size: 10px; }
  .family-button.active, .source-switch a.active { color: var(--text); background: var(--surface); border-color: var(--border); box-shadow: 0 1px 3px rgba(20, 24, 31, 0.08); }
  .search { position: relative; flex: 1 1 260px; min-width: 180px; margin-left: auto; }
  .search svg { position: absolute; left: 11px; top: 50%; width: 16px; height: 16px; color: var(--muted); transform: translateY(-50%); pointer-events: none; }
  .search input {
    width: 100%; height: 40px; padding: 8px 12px 8px 35px; border: 1px solid var(--border);
    border-radius: 7px; color: var(--text); background: var(--surface);
  }
  .search input::placeholder { color: #9299a3; }
  .sort-select { position: relative; flex: 0 0 150px; }
  .sort-select select {
    width: 100%; height: 40px; padding: 8px 32px 8px 11px; appearance: none;
    border: 1px solid var(--border); border-radius: 7px; color: var(--text); background: var(--surface); cursor: pointer;
  }
  .sort-select svg { position: absolute; right: 10px; top: 50%; width: 15px; height: 15px; color: var(--muted); transform: translateY(-50%); pointer-events: none; }
  .icon-button, .copy-button {
    display: inline-grid; place-items: center; border: 1px solid var(--border); color: var(--muted); background: var(--surface); cursor: pointer;
  }
  .icon-button { flex: 0 0 40px; width: 40px; height: 40px; border-radius: 7px; }
  .icon-button:hover, .copy-button:hover { color: var(--blue); border-color: #a9c8f4; background: var(--blue-soft); }
  .icon-button svg, .copy-button svg { width: 16px; height: 16px; }
  .icon-button.spinning svg { animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .family-panel.active { animation: enter 0.22s ease-out; }
  @keyframes enter { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
  .node-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  .node-card {
    --tone: #68707c; --tone-soft: #f0f2f5;
    position: relative; min-width: 0; overflow: hidden; padding: 16px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 1px 2px rgba(20, 24, 31, 0.03); transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
  }
  .node-card::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 3px; background: var(--tone); }
  .node-card:hover { transform: translateY(-2px); border-color: var(--border-strong); box-shadow: var(--shadow); }
  .tone-blue { --tone: var(--blue); --tone-soft: var(--blue-soft); }
  .tone-green { --tone: var(--green); --tone-soft: var(--green-soft); }
  .tone-amber { --tone: var(--amber); --tone-soft: var(--amber-soft); }
  .card-topline { min-height: 27px; display: flex; align-items: center; gap: 7px; }
  .rank { display: inline-flex; align-items: baseline; gap: 1px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .rank b { color: var(--text); font-size: 13px; }
  .scope-tag { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 7px; border-radius: 5px; color: var(--tone); background: var(--tone-soft); font-size: 10px; font-weight: 800; }
  .copy-button { width: 28px; height: 28px; margin-left: auto; border-radius: 6px; }
  .address-row { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 14px; }
  .address-row code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 18px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .quality { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 10px; font-weight: 800; }
  .quality i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .quality.excellent i { background: var(--green); box-shadow: 0 0 0 3px rgba(7, 135, 93, 0.11); }
  .quality.good i { background: var(--blue); }
  .quality.attention i { background: var(--amber); }
  .location-row { display: flex; align-items: center; gap: 6px; margin-top: 7px; color: var(--muted); font-size: 11px; }
  .location-row svg { width: 13px; height: 13px; }
  .location-row strong { color: var(--text); font-weight: 700; }
  .location-row span { margin-left: auto; padding: 2px 5px; border: 1px solid var(--border); border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 20px; }
  .metrics > div { min-width: 0; }
  .metrics span { display: block; margin-bottom: 3px; color: var(--muted); font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .metrics strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 23px; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .metrics div:first-child strong { color: var(--tone); }
  .metrics small { margin-left: 4px; color: var(--muted); font-size: 10px; font-weight: 600; }
  .speed-track { height: 5px; overflow: hidden; margin-top: 17px; border-radius: 3px; background: var(--surface-subtle); }
  .speed-track i { display: block; height: 100%; border-radius: 3px; background: var(--tone); transition: width 0.4s ease; }
  .card-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; color: var(--muted); font-size: 10px; }
  .card-foot b { color: var(--text); font-weight: 700; }
  .empty-state, .no-results {
    min-height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 7px; color: var(--muted); text-align: center;
  }
  .empty-state svg, .no-results svg { width: 30px; height: 30px; margin-bottom: 5px; color: #9299a3; }
  .empty-state strong, .no-results strong { color: var(--text); font-size: 15px; }
  .empty-state span, .no-results span { font-size: 12px; }
  .footer { border-top: 1px solid var(--border); background: var(--surface); }
  .footer-inner { min-height: 68px; display: flex; align-items: center; gap: 20px; color: var(--muted); font-size: 11px; }
  .footer-inner span:nth-child(2) { margin-left: auto; }
  .footer a { color: var(--blue); text-decoration: none; font-weight: 700; }
  .toast {
    position: fixed; z-index: 20; left: 50%; bottom: 24px; display: flex; align-items: center; gap: 8px;
    max-width: calc(100% - 32px); padding: 10px 14px; color: white; background: #171a1f; border-radius: 7px;
    box-shadow: var(--shadow); opacity: 0; transform: translate(-50%, 12px); pointer-events: none; transition: opacity 0.2s ease, transform 0.2s ease;
  }
  .toast.visible { opacity: 1; transform: translate(-50%, 0); }
  .toast svg { width: 16px; height: 16px; color: #52d9a8; }
  .toast span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .error-page { min-height: 100vh; display: grid; place-content: center; justify-items: center; padding: 24px; text-align: center; }
  .error-page > span { color: var(--blue); }
  .error-page svg { width: 42px; height: 42px; }
  .error-page h1 { margin-top: 18px; font-size: 26px; }
  .error-page p { color: var(--muted); }
  @media (max-width: 1020px) {
    .node-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .toolbar { flex-wrap: wrap; }
    .search { order: 2; flex-basis: calc(100% - 159px); margin-left: 0; }
    .sort-select { order: 2; }
    .icon-button { order: 2; }
  }
  @media (max-width: 760px) {
    .shell { width: min(100% - 24px, 1360px); }
    .main { padding-top: 32px; padding-bottom: 52px; }
    .page-head { align-items: flex-start; flex-direction: column; margin-bottom: 24px; }
    h1 { font-size: 28px; }
    .domain-chip { max-width: 100%; }
    .summary { grid-template-columns: 1fr 1fr; }
    .summary-item:nth-child(2) { border-right: 0; }
    .summary-item:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
    .node-grid { grid-template-columns: 1fr; }
    .footer-inner { min-height: 90px; flex-wrap: wrap; justify-content: center; gap: 8px 16px; padding: 18px 0; text-align: center; }
    .footer-inner span:nth-child(2) { width: 100%; margin-left: 0; order: 3; }
  }
  @media (max-width: 540px) {
    .topbar { height: 64px; }
    .brand small { display: none; }
    .topbar-status { padding: 5px 8px; }
    .toolbar { align-items: stretch; }
    .segmented, .source-switch { flex: 1 1 auto; }
    .family-button, .source-switch a { flex: 1; white-space: nowrap; }
    .search { order: 3; flex: 1 1 100%; }
    .sort-select { order: 4; flex: 1 1 calc(100% - 49px); }
    .icon-button { order: 4; }
    .summary-item { padding: 14px 12px; gap: 9px; }
    .summary-icon { width: 30px; height: 30px; }
    .summary-item strong { font-size: 14px; }
    #summary-updated { font-size: 11px; overflow-wrap: anywhere; }
    .address-row code { font-size: 16px; }
    .quality { font-size: 9px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }`;
}

function renderStyles() {
  return `
  *, *::before, *::after { box-sizing: border-box; }
  :root {
    color-scheme: light;
    --ink: #12141b;
    --ink-soft: #232732;
    --canvas: #f1f3f5;
    --paper: #ffffff;
    --line: #dce0e5;
    --muted: #747985;
    --muted-light: #a5aab4;
    --blue: #3169f5;
    --mint: #b7ff59;
    --mint-deep: #0b8d68;
    --orange: #eb7650;
    --shadow: 0 16px 36px rgba(20, 23, 31, 0.08);
    --font-sans: "MiSans", "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei UI", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
    --font-display: "MiSans", "HarmonyOS Sans SC", "Segoe UI Variable Display", "PingFang SC", "Microsoft YaHei UI", sans-serif;
    --font-mono: "Cascadia Code", "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
  }
  html { min-width: 320px; background: var(--canvas); }
  body {
    min-width: 320px; margin: 0; min-height: 100vh; background: var(--canvas); color: var(--ink);
    font-family: var(--font-sans); font-size: 15px; line-height: 1.5; font-synthesis: none;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  button, input, select { font: inherit; }
  button, a { -webkit-tap-highlight-color: transparent; }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid rgba(49, 105, 245, 0.28); outline-offset: 3px; }
  [hidden] { display: none !important; }
  .shell { width: min(1280px, calc(100% - 48px)); margin: 0 auto; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

  .site-header { background: var(--ink); color: white; }
  .site-header-inner { height: 78px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .brand { display: inline-flex; align-items: center; gap: 11px; color: white; text-decoration: none; }
  .brand-mark { width: 36px; height: 36px; display: grid; place-items: center; color: var(--ink); background: var(--mint); border-radius: 7px; }
  .brand-mark svg { width: 20px; height: 20px; stroke-width: 2.4; }
  .brand > span:last-child { display: flex; flex-direction: column; gap: 1px; }
  .brand strong { font-family: var(--font-display); font-size: 17px; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; }
  .brand small { color: #aeb4c0; font-family: var(--font-mono); font-size: 9px; line-height: 1.2; letter-spacing: 0.08em; }
  .header-utility { display: flex; align-items: center; gap: 15px; }
  .api-link { color: #cbd0d9; font-family: var(--font-mono); font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-decoration: none; }
  .api-link:hover { color: var(--mint); }
  .topbar-status { display: inline-flex; align-items: center; gap: 7px; padding: 6px 9px; color: #dfffb8; background: rgba(183, 255, 89, 0.1); border: 1px solid rgba(183, 255, 89, 0.2); border-radius: 999px; font-size: 11px; font-weight: 700; }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 0 4px rgba(183, 255, 89, 0.1); }

  .main { padding: 0 0 82px; }
  .hero { min-height: 218px; display: flex; align-items: stretch; justify-content: space-between; gap: 30px; padding: 30px 44px 28px; color: white; background: var(--ink); border-radius: 0 0 20px 20px; position: relative; overflow: hidden; }
  .hero::after { content: ""; position: absolute; right: 24%; bottom: -42px; width: 86px; height: 86px; border: 1px solid rgba(183, 255, 89, 0.18); border-radius: 50%; pointer-events: none; }
  .hero-copy { position: relative; z-index: 1; display: flex; flex: 1 1 auto; flex-direction: column; justify-content: center; max-width: 650px; }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; margin: 0 0 10px; color: #aeb4c0; font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: 0.08em; }
  .eyebrow span { width: 8px; height: 8px; background: var(--mint); border-radius: 50%; }
  h1 { max-width: 650px; margin: 0; color: white; font-family: var(--font-display); font-size: clamp(34px, 3.5vw, 46px); font-weight: 800; line-height: 1.08; letter-spacing: -0.05em; }
  h1 em { color: var(--mint); font-style: normal; }
  .subtitle { max-width: 500px; margin: 8px 0 0; color: #b9bfca; font-size: 13px; }
  .hero-panel { position: relative; z-index: 1; flex: 0 0 218px; display: flex; flex-direction: column; justify-content: center; gap: 10px; padding: 8px 0 0 18px; border-left: 1px solid rgba(255, 255, 255, 0.18); }
  .hero-label, .hero-meta span { display: block; color: #aeb4c0; font-size: 11px; font-weight: 700; }
  .hero-number { display: flex; align-items: baseline; gap: 6px; margin-top: 1px; font-family: var(--font-display); font-size: 32px; font-weight: 800; line-height: 1.1; letter-spacing: -0.055em; }
  .hero-number span { color: var(--mint); }
  .hero-number small { color: #c4c9d1; font-family: var(--font-mono); font-size: 12px; font-weight: 700; letter-spacing: 0; }
  .hero-meta { padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.14); }
  .hero-meta strong { display: block; margin-top: 3px; color: white; font-family: var(--font-mono); font-size: 12px; font-weight: 600; }
  .domain-chip { display: inline-flex; align-items: center; gap: 8px; align-self: flex-start; max-width: 100%; padding: 0; color: #d9dee6; background: transparent; border: 0; cursor: pointer; }
  .domain-chip:hover { color: var(--mint); }
  .domain-chip svg { flex: 0 0 auto; width: 14px; height: 14px; }
  .domain-chip code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 11px; }
  .domain-chip > svg:last-child { width: 13px; height: 13px; opacity: 0.72; }

  .scope-deck { position: relative; z-index: 2; display: flex; align-items: center; gap: 28px; min-height: 70px; margin: -12px 32px 0; padding: 12px 22px; background: var(--paper); border-radius: 18px; box-shadow: var(--shadow); }
  .scope-deck-title { flex: 0 0 auto; min-width: 110px; display: flex; flex-direction: column; line-height: 1.2; }
  .scope-deck-title span { font-size: 14px; font-weight: 800; }
  .scope-deck-title small { margin-top: 4px; color: var(--muted); font-size: 10px; }
  .scope-nav { display: flex; flex: 1; align-items: center; gap: 5px; min-width: 0; overflow-x: auto; padding: 0; scrollbar-width: none; }
  .scope-nav::-webkit-scrollbar { display: none; }
  .scope-link { flex: 0 0 auto; padding: 9px 13px; color: var(--muted); border-bottom: 2px solid transparent; font-size: 13px; font-weight: 700; text-decoration: none; transition: color 0.18s ease, border-color 0.18s ease; }
  .scope-link:hover { color: var(--ink); }
  .scope-link.active { color: var(--ink); border-color: var(--blue); }
  .scope-nav-single { color: var(--muted); font-size: 13px; }

  .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 46px 0 56px; padding: 0 12px; overflow: hidden; background: var(--paper); border-radius: 18px; box-shadow: 0 10px 28px rgba(20, 23, 31, 0.045); }
  .summary-item { min-width: 0; padding: 19px 22px; border-right: 1px solid var(--line); }
  .summary-item:first-child { padding-left: 12px; }
  .summary-item:last-child { border-right: 0; }
  .summary-item small { display: block; color: var(--muted); font-size: 11px; font-weight: 700; }
  .summary-item strong { display: block; overflow: hidden; margin-top: 2px; color: var(--ink); font-family: var(--font-display); font-size: 23px; font-weight: 800; line-height: 1.2; letter-spacing: -0.03em; text-overflow: ellipsis; white-space: nowrap; }
  .summary-item:nth-child(2) strong { color: var(--blue); }
  .summary-item:nth-child(3) strong { color: var(--mint-deep); }
  #summary-updated { font-family: var(--font-mono); font-size: 13px; letter-spacing: -0.04em; }

  .workspace-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 21px; }
  .section-kicker { display: block; margin-bottom: 5px; color: var(--blue); font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: 0.08em; }
  h2 { margin: 0; font-family: var(--font-display); font-size: 30px; font-weight: 800; line-height: 1.15; letter-spacing: -0.045em; }
  .toolbar { display: flex; align-items: center; gap: 10px; padding: 13px 0 18px; border-top: 1px solid var(--line); }
  .segmented, .source-switch { display: inline-flex; align-items: center; gap: 2px; padding: 4px; background: #e3e6ea; border-radius: 12px; }
  .family-button, .source-switch a { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 6px 11px; color: var(--muted); background: transparent; border: 0; border-radius: 9px; font-size: 12px; font-weight: 800; text-decoration: none; cursor: pointer; }
  .family-button span { min-width: 18px; color: inherit; font-family: var(--font-mono); font-size: 10px; }
  .family-button.active, .source-switch a.active { color: white; background: var(--ink); box-shadow: 0 2px 5px rgba(18, 20, 27, 0.15); }
  .search { position: relative; flex: 1 1 250px; min-width: 180px; margin-left: auto; }
  .search svg { position: absolute; top: 50%; left: 12px; width: 16px; height: 16px; color: var(--muted); transform: translateY(-50%); pointer-events: none; }
  .search input { width: 100%; height: 42px; padding: 8px 13px 8px 37px; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 12px; }
  .search input::placeholder { color: #a1a6b0; }
  .sort-select { position: relative; flex: 0 0 136px; }
  .sort-select select { width: 100%; height: 42px; appearance: none; padding: 8px 31px 8px 11px; color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 12px; cursor: pointer; }
  .sort-select svg { position: absolute; top: 50%; right: 11px; width: 14px; height: 14px; color: var(--muted); transform: translateY(-50%); pointer-events: none; }
  .icon-button, .copy-button { display: inline-grid; place-items: center; color: var(--ink); background: transparent; border: 0; cursor: pointer; }
  .icon-button { flex: 0 0 42px; width: 42px; height: 42px; background: var(--paper); border: 1px solid var(--line); border-radius: 12px; }
  .icon-button:hover { color: var(--blue); border-color: #a8c0ff; }
  .icon-button svg, .copy-button svg { width: 17px; height: 17px; }
  .icon-button.spinning svg { animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .family-panel.active { animation: enter 0.28s ease-out; }
  @keyframes enter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

  .node-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
  .node-card { --tone: #737985; --tone-soft: #eff1f3; position: relative; min-width: 0; overflow: hidden; padding: 22px; background: var(--paper); border: 1px solid rgba(220, 224, 229, 0.72); border-radius: 18px; box-shadow: 0 8px 22px rgba(20, 23, 31, 0.045); transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease; }
  .node-card::before { content: ""; position: absolute; top: 21px; left: 0; width: 4px; height: 54px; background: var(--tone); border-radius: 0 4px 4px 0; }
  .node-card:hover { transform: translateY(-4px); border-color: transparent; box-shadow: 0 18px 34px rgba(20, 23, 31, 0.1); }
  .tone-blue { --tone: var(--blue); --tone-soft: #eaf0ff; }
  .tone-green { --tone: var(--mint-deep); --tone-soft: #e5f7f0; }
  .tone-amber { --tone: var(--orange); --tone-soft: #fff0e9; }
  .card-topline { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .rank { display: inline-flex; align-items: baseline; gap: 5px; color: var(--muted); }
  .rank span { font-size: 10px; font-weight: 700; }
  .rank b { color: var(--ink); font-family: var(--font-mono); font-size: 13px; font-weight: 700; }
  .card-actions { display: inline-flex; align-items: center; gap: 9px; min-width: 0; }
  .scope-tag { max-width: 132px; overflow: hidden; padding: 4px 8px; color: var(--tone); background: var(--tone-soft); border-radius: 999px; font-size: 10px; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
  .copy-button { width: 31px; height: 31px; color: var(--muted); border-radius: 10px; }
  .copy-button:hover { color: var(--ink); background: #eef0f3; }
  .address-row { min-width: 0; margin-top: 25px; }
  .address-row code { display: block; overflow: hidden; color: var(--ink); font-family: var(--font-mono); font-size: clamp(17px, 1.55vw, 22px); font-weight: 700; line-height: 1.2; letter-spacing: -0.055em; text-overflow: ellipsis; white-space: nowrap; }
  .location-row { display: flex; align-items: center; gap: 6px; margin-top: 10px; color: var(--muted); font-size: 11px; }
  .location-row > svg { width: 14px; height: 14px; }
  .location-row strong { color: var(--ink-soft); font-weight: 700; }
  .location-row > span:not(.quality) { padding: 2px 5px; color: var(--muted); font-family: var(--font-mono); font-size: 10px; background: #f0f2f4; border-radius: 3px; }
  .quality { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; font-size: 10px; font-weight: 700; }
  .quality i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  .quality.excellent { color: var(--mint-deep); }.quality.excellent i { background: var(--mint-deep); }.quality.good { color: var(--blue); }.quality.good i { background: var(--blue); }.quality.attention { color: var(--orange); }.quality.attention i { background: var(--orange); }
  .metrics { display: grid; grid-template-columns: 1.22fr 1fr; gap: 12px; margin-top: 27px; }
  .metrics > div { min-width: 0; }
  .metrics span { display: block; margin-bottom: 4px; color: var(--muted); font-size: 10px; font-weight: 700; }
  .metrics strong { display: block; overflow: hidden; color: var(--ink); font-family: var(--font-display); font-size: 28px; font-weight: 800; line-height: 1.05; letter-spacing: -0.055em; text-overflow: ellipsis; white-space: nowrap; }
  .metrics .speed-metric strong { color: var(--tone); }
  .metrics small { margin-left: 4px; color: var(--muted); font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: 0; }
  .speed-track { height: 6px; overflow: hidden; margin-top: 21px; background: #eceef1; border-radius: 999px; }
  .speed-track i { display: block; height: 100%; background: var(--tone); border-radius: 999px; transition: width 0.45s ease; }
  .card-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; color: var(--muted); font-size: 10px; }
  .card-foot b { color: var(--ink); font-family: var(--font-mono); font-weight: 700; }
  .empty-state, .no-results { min-height: 260px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; color: var(--muted); text-align: center; }
  .empty-state svg, .no-results svg { width: 30px; height: 30px; color: var(--muted-light); }
  .empty-state strong, .no-results strong { color: var(--ink); font-size: 15px; }.empty-state span, .no-results span { font-size: 12px; }

  .footer { margin-top: 78px; color: #aeb4c0; background: var(--ink); }
  .footer-inner { min-height: 76px; display: flex; align-items: center; gap: 19px; font-size: 11px; }
  .footer-inner span:first-child { color: white; font-family: var(--font-display); font-weight: 700; }
  .footer-inner i { display: inline-block; width: 4px; height: 4px; margin: 0 4px; vertical-align: middle; background: var(--mint); border-radius: 50%; }
  .footer-inner span:nth-child(2) { margin-left: auto; }
  .footer a { color: var(--mint); font-size: 11px; font-weight: 700; text-decoration: none; }
  .toast { position: fixed; z-index: 20; left: 50%; bottom: 24px; display: flex; align-items: center; gap: 8px; max-width: calc(100% - 32px); padding: 11px 14px; color: var(--ink); background: var(--mint); border-radius: 6px; box-shadow: var(--shadow); opacity: 0; transform: translate(-50%, 12px); pointer-events: none; transition: opacity 0.2s ease, transform 0.2s ease; }
  .toast.visible { opacity: 1; transform: translate(-50%, 0); }.toast svg { width: 16px; height: 16px; }.toast span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 800; }
  .error-page { min-height: 100vh; display: grid; place-content: center; justify-items: center; padding: 24px; color: var(--ink); text-align: center; }.error-page > span { color: var(--blue); }.error-page svg { width: 42px; height: 42px; }.error-page h1 { margin-top: 18px; color: var(--ink); font-size: 28px; }.error-page p { color: var(--muted); }

  @media (max-width: 1040px) { .hero { gap: 35px; padding: 56px 44px 48px; }.node-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.toolbar { flex-wrap: wrap; }.search { order: 2; flex-basis: calc(100% - 197px); margin-left: 0; }.sort-select, .icon-button { order: 2; } }
  @media (max-width: 760px) { .shell { width: min(100% - 28px, 1280px); }.site-header-inner { height: 66px; }.main { padding-bottom: 48px; }.hero { min-height: 0; flex-direction: column; gap: 18px; padding: 25px 25px 22px; border-radius: 0 0 18px 18px; }.hero::after { right: -32px; bottom: -38px; width: 78px; height: 78px; }.hero-panel { flex-basis: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 22px; padding: 12px 0 0; border-top: 1px solid rgba(255, 255, 255, 0.18); border-left: 0; }.hero-number { font-size: 30px; }.hero-meta { padding-top: 0; border-top: 0; }.domain-chip { grid-column: 1 / -1; }.scope-deck { align-items: flex-start; flex-direction: column; gap: 10px; margin: -10px 12px 0; padding: 13px 16px; border-radius: 16px; }.scope-deck-title { min-width: 0; flex-direction: row; align-items: baseline; gap: 10px; }.scope-deck-title small { margin-top: 0; }.scope-nav { width: 100%; }.summary { grid-template-columns: 1fr 1fr; margin: 38px 0 45px; padding: 0 10px; border-radius: 16px; }.summary-item { padding: 15px 0 15px 15px; border-bottom: 1px solid var(--line); }.summary-item:nth-child(odd) { padding-left: 4px; }.summary-item:nth-child(2) { border-right: 0; }.summary-item:nth-child(n+3) { border-bottom: 0; }.workspace-head { align-items: flex-start; flex-direction: column; gap: 14px; }.node-grid { grid-template-columns: 1fr; }.footer { margin-top: 54px; }.footer-inner { min-height: 106px; flex-wrap: wrap; justify-content: center; gap: 8px 16px; padding: 18px 0; text-align: center; }.footer-inner span:nth-child(2) { width: 100%; margin-left: 0; order: 3; } }
  @media (max-width: 540px) { .shell { width: calc(100% - 24px); }.brand small, .api-link { display: none; }.header-utility { gap: 0; }.topbar-status { padding: 5px 8px; }.hero { padding: 22px 22px 19px; }.hero h1 { font-size: 32px; }.eyebrow { margin-bottom: 8px; font-size: 9px; }.subtitle { margin-top: 9px; font-size: 12px; }.hero-panel { gap: 10px 16px; }.hero-number { font-size: 28px; }.hero-meta strong { font-size: 10px; }.summary-item strong { font-size: 20px; }#summary-updated { font-size: 11px; letter-spacing: -0.075em; }.toolbar { gap: 9px; }.segmented, .source-switch { flex: 1 1 auto; }.family-button, .source-switch a { flex: 1; }.search { order: 3; flex: 1 1 100%; }.sort-select { order: 4; flex: 1 1 calc(100% - 51px); }.icon-button { order: 4; }.node-card { padding: 20px; border-radius: 16px; }.node-card::before { top: 19px; height: 50px; }.metrics strong { font-size: 27px; }h2 { font-size: 28px; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
  `;
}

function svgIcon(paths, className = '') {
  return `<svg${className ? ` class="${className}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function iconActivity() { return svgIcon('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'); }
function iconServer() { return svgIcon('<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>'); }
function iconGauge() { return svgIcon('<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>'); }
function iconZap() { return svgIcon('<path d="M4 14a1 1 0 0 1-.78-1.63l9-11a.5.5 0 0 1 .87.45l-1.72 6.89A1 1 0 0 0 11.34 10H20a1 1 0 0 1 .78 1.63l-9 11a.5.5 0 0 1-.87-.45l1.72-6.89A1 1 0 0 0 12.66 14Z"/>'); }
function iconClock() { return svgIcon('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'); }
function iconSearch() { return svgIcon('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'); }
function iconSearchLarge() { return iconSearch(); }
function iconChevronDown() { return svgIcon('<path d="m6 9 6 6 6-6"/>'); }
function iconRefresh() { return svgIcon('<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>'); }
function iconCopy() { return svgIcon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'); }
function iconMapPin() { return svgIcon('<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'); }
function iconGlobe() { return svgIcon('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>'); }
function iconCheck() { return svgIcon('<path d="M20 6 9 17l-5-5"/>'); }
function iconServerLarge() { return iconServer(); }

function renderFavicon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#171a1f"/><path d="M9 32h11l7-19 9 38 8-19h11" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
