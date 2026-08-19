/**
 * CFSpeedSync Atlas UI
 * Cloudflare Worker (Modules syntax)
 * Required KV binding: KV_NAMESPACE
 */

const CONFIG = Object.freeze({
  brand: 'CFSpeedSync',
  provider: 'Cloudflare',
  kvBinding: 'KV_NAMESPACE',
  checkIntervalMinutes: 30,
  refreshIntervalHours: 24,
});

const DATA_SUFFIXES = Object.freeze([
  'ipv4', 'ipv4time', 'ipv6', 'ipv6time',
  'excellent_ipv4', 'excellent_ipv6',
]);

const REGION_NAMES = Object.freeze({
  HKG: '香港', NRT: '东京', KIX: '大阪', SIN: '新加坡', TPE: '台北',
  ICN: '首尔', SJC: '圣何塞', LAX: '洛杉矶', SEA: '西雅图',
  FRA: '法兰克福', LHR: '伦敦', AMS: '阿姆斯特丹', CDG: '巴黎',
  SYD: '悉尼', KUL: '吉隆坡', BKK: '曼谷', MNL: '马尼拉',
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

    const url = new URL(request.url);
    if (request.method === 'POST' && ['/api/admin/dns', '/api/admin/pool'].includes(url.pathname)) {
      return handleAdminRequest(request, env, url.pathname);
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return textResponse('Method not allowed', 405, { Allow: 'GET, HEAD, OPTIONS' });
    }

    if (url.pathname === '/favicon.svg') return faviconResponse();
    if (url.pathname === '/healthz') return jsonResponse({ ok: true, service: CONFIG.brand });
    if (!['/', '/api/nodes'].includes(url.pathname)) return textResponse('Not found', 404);

    const kv = env[CONFIG.kvBinding];
    if (!kv || typeof kv.get !== 'function' || typeof kv.list !== 'function') {
      const message = `Missing KV binding: ${CONFIG.kvBinding}`;
      return url.pathname === '/api/nodes'
        ? jsonResponse({ error: message }, 503)
        : htmlResponse(renderError(message), 503);
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
          ui: 'atlas',
          provider: CONFIG.provider,
          generated_at: new Date().toISOString(),
          selected_prefix: selectedPrefix || null,
          source: selectedSource,
          available_prefixes: index.prefixes,
          data: snapshot,
        });
      }

      return htmlResponse(renderPage({ index, selectedPrefix, selectedSource, snapshot }));
    } catch (error) {
      console.error('Atlas Worker error', error);
      return url.pathname === '/api/nodes'
        ? jsonResponse({ error: 'Unable to read node data' }, 500)
        : htmlResponse(renderError('无法读取节点数据'), 500);
    }
  },
};

async function handleAdminRequest(request, env, pathname) {
  if (!env.ADMIN_TOKEN) return privateJsonResponse({ error: 'Worker 未配置 ADMIN_TOKEN' }, 503);
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!timingSafeEqual(token, String(env.ADMIN_TOKEN))) {
    return privateJsonResponse({ error: '管理员令牌无效' }, 401);
  }

  const kv = env[CONFIG.kvBinding];
  if (!kv || typeof kv.get !== 'function') {
    return privateJsonResponse({ error: `缺少 KV 绑定：${CONFIG.kvBinding}` }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return privateJsonResponse({ error: '请求数据不是有效 JSON' }, 400);
  }

  const family = payload?.family;
  const ip = String(payload?.ip || '').trim();
  const scope = String(payload?.scope || '').trim();
  if (!['ipv4', 'ipv6'].includes(family) || !ip || scope.length > 253) {
    return privateJsonResponse({ error: 'IP、版本或线路参数无效' }, 400);
  }
  if ((family === 'ipv4' && !ip.includes('.')) || (family === 'ipv6' && !ip.includes(':'))) {
    return privateJsonResponse({ error: 'IP 地址与版本不匹配' }, 400);
  }

  try {
    if (pathname === '/api/admin/pool') {
      if (typeof kv.put !== 'function') return privateJsonResponse({ error: 'KV 绑定不支持写入' }, 503);
      const result = await addNodeToExcellentPool(kv, scope, family, ip, env);
      return privateJsonResponse(result);
    }

    const known = await findKnownNode(kv, scope, family, ip);
    if (!known) return privateJsonResponse({ error: '该 IP 不在当前测速结果或优良库中' }, 404);
    const result = await updateCloudflareDNS(env, scope, family, ip);
    return privateJsonResponse(result);
  } catch (error) {
    if (!error.status || error.status >= 500) console.error('Atlas admin action failed', error);
    return privateJsonResponse({ error: error.message || '管理操作失败' }, error.status || 500);
  }
}

function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

async function addNodeToExcellentPool(kv, scope, family, ip, env) {
  const rawLatest = await kv.get(scopedKey(scope, family));
  const node = parseLatestRows(rawLatest, scope).find((row) => row.ip === ip);
  if (!node) throw httpError('该 IP 不在对应线路的最新测速结果中', 404);

  const poolKey = scopedKey(scope, `excellent_${family}`);
  const rawPool = await kv.get(poolKey);
  let entries = [];
  if (rawPool) {
    try {
      const parsed = JSON.parse(rawPool);
      if (Array.isArray(parsed)) entries = parsed.filter((item) => item && typeof item === 'object');
    } catch {
      throw httpError(`优良库 ${poolKey} 的 JSON 数据损坏`, 500);
    }
  }

  const entry = {
    ip: node.ip,
    speed: node.speed,
    delay: Math.round(node.latency),
    loss_rate: node.loss / 100,
    packets: node.packets,
    received: node.received,
    colo: node.colo,
    added_time: beijingNow(),
  };
  const existingIndex = entries.findIndex((item) => item.ip === ip);
  const updated = existingIndex >= 0;
  if (updated) entries[existingIndex] = { ...entries[existingIndex], ...entry };
  else entries.push(entry);

  entries.sort((a, b) => finiteNumber(b.speed) - finiteNumber(a.speed));
  const maxSize = Math.max(1, Math.min(1000, Math.trunc(finiteNumber(env.EXCELLENT_POOL_MAX_SIZE || 100))));
  entries = entries.slice(0, maxSize);
  await kv.put(poolKey, JSON.stringify(entries));

  return {
    ok: true,
    action: updated ? 'updated' : 'added',
    key: poolKey,
    count: entries.length,
    message: updated ? `${ip} 已更新到优良库` : `${ip} 已加入优良库`,
  };
}

async function findKnownNode(kv, scope, family, ip) {
  const [latest, pool] = await Promise.all([
    kv.get(scopedKey(scope, family)),
    kv.get(scopedKey(scope, `excellent_${family}`)),
  ]);
  return parseLatestRows(latest, scope).find((row) => row.ip === ip)
    || parsePoolRows(pool, scope).find((row) => row.ip === ip)
    || null;
}

async function updateCloudflareDNS(env, scope, family, ip) {
  if (!env.CF_API_TOKEN) throw httpError('Worker 未配置 CF_API_TOKEN', 503);
  const target = resolveDnsTarget(env, scope);
  const type = family === 'ipv4' ? 'A' : 'AAAA';
  const base = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(target.zoneId)}/dns_records`;
  const headers = { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' };

  let existing = null;
  if (target.recordId) {
    const response = await fetch(`${base}/${encodeURIComponent(target.recordId)}`, { headers });
    const data = await response.json();
    if (!response.ok || !data.success) throw cloudflareError(data, response.status);
    existing = data.result;
  } else {
    const query = new URLSearchParams({ type, name: target.record });
    const response = await fetch(`${base}?${query.toString()}`, { headers });
    const data = await response.json();
    if (!response.ok || !data.success) throw cloudflareError(data, response.status);
    existing = data.result?.[0] || null;
  }

  if (existing && existing.type !== type) {
    throw httpError(`配置的 DNS 记录类型为 ${existing.type}，不能写入 ${type}`, 409);
  }

  const body = {
    type,
    name: target.record,
    content: ip,
    ttl: target.ttl ?? existing?.ttl ?? 1,
    proxied: target.proxied ?? existing?.proxied ?? false,
  };
  const endpoint = existing ? `${base}/${encodeURIComponent(existing.id)}` : base;
  const response = await fetch(endpoint, {
    method: existing ? 'PUT' : 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw cloudflareError(data, response.status);

  return {
    ok: true,
    action: existing ? 'updated' : 'created',
    record: target.record,
    type,
    ip,
    message: `${target.record} 已解析到 ${ip}`,
  };
}

function resolveDnsTarget(env, scope) {
  let mappings = {};
  if (env.DNS_RECORDS) {
    try {
      mappings = JSON.parse(env.DNS_RECORDS);
    } catch {
      throw httpError('DNS_RECORDS 不是有效 JSON', 503);
    }
  }
  const key = scope || 'default';
  const configured = mappings[key];
  const item = typeof configured === 'string' ? { record: configured } : (configured || {});
  const record = String(item.record || scope || '').trim();
  const zoneId = String(item.zone_id || item.zoneId || env.CF_ZONE_ID || '').trim();
  if (!record) throw httpError(`线路 ${key} 未配置 DNS 记录名`, 409);
  if (!zoneId) throw httpError(`线路 ${key} 未配置 zone_id，且没有 CF_ZONE_ID`, 409);
  return {
    record,
    zoneId,
    recordId: String(item.record_id || item.recordId || '').trim(),
    ttl: item.ttl == null ? undefined : Math.max(1, Math.trunc(finiteNumber(item.ttl))),
    proxied: typeof item.proxied === 'boolean' ? item.proxied : undefined,
  };
}

function cloudflareError(data, status) {
  const message = data?.errors?.map((item) => item.message).filter(Boolean).join('; ')
    || `Cloudflare API 请求失败 (${status})`;
  return httpError(message, status >= 400 && status < 500 ? status : 502);
}

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function beijingNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

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
    if (key.endsWith(marker)) return { prefix: key.slice(0, -marker.length), suffix };
  }
  return null;
}

async function loadSnapshot(kv, index, selectedPrefix, source) {
  const scopes = selectedPrefix ? [selectedPrefix] : ['', ...index.prefixes];
  const [ipv4, ipv6] = await Promise.all([
    loadFamily(kv, index.keys, scopes, source, 'ipv4'),
    loadFamily(kv, index.keys, scopes, source, 'ipv6'),
  ]);
  return { ipv4, ipv6 };
}

async function loadFamily(kv, keySet, scopes, source, family) {
  const dataSuffix = source === 'pool' ? `excellent_${family}` : family;
  const timeSuffix = `${family}time`;
  const available = scopes.filter((scope) => keySet.has(scopedKey(scope, dataSuffix)));
  if (!available.length) return { rows: [], updatedAt: null };

  if (source === 'pool') {
    const values = await Promise.all(available.map((scope) => kv.get(scopedKey(scope, dataSuffix))));
    const rows = [];
    let updatedAt = null;
    values.forEach((value, index) => {
      const parsed = parsePoolRows(value, available[index]);
      rows.push(...parsed);
      for (const row of parsed) {
        if (row.addedAt && (!updatedAt || row.addedAt > updatedAt)) updatedAt = row.addedAt;
      }
    });
    return { rows: sortRows(rows, 'speed'), updatedAt };
  }

  const values = await Promise.all(available.flatMap((scope) => [
    kv.get(scopedKey(scope, dataSuffix)),
    keySet.has(scopedKey(scope, timeSuffix))
      ? kv.get(scopedKey(scope, timeSuffix))
      : Promise.resolve(null),
  ]));
  const rows = [];
  let updatedAt = null;
  available.forEach((scope, index) => {
    rows.push(...parseLatestRows(values[index * 2], scope));
    const time = values[index * 2 + 1];
    if (time && (!updatedAt || time > updatedAt)) updatedAt = time;
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
      ip: fields[0], packets: fields[1], received: fields[2], loss: fields[3],
      latency: fields[4], speed: fields[5], colo: fields[6], scope, addedAt: null,
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
      return [normalizeRow({
        ip: item.ip,
        packets: item.packets,
        received: item.received,
        loss: rawLoss <= 1 ? rawLoss * 100 : rawLoss,
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
  const initialFamily = snapshot.ipv4.rows.length ? 'ipv4' : 'ipv6';
  const appData = {
    initialFamily,
    families: {
      ipv4: summarize(snapshot.ipv4),
      ipv6: summarize(snapshot.ipv6),
    },
  };

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f2f4f7">
  <meta name="description" content="${escapeHTML(CONFIG.provider)} 优选 IP Atlas 控制台">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <title>${escapeHTML(CONFIG.brand)} · Atlas</title>
  <style>${renderStyles()}</style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/" aria-label="${escapeHTML(CONFIG.brand)} 首页">
      <span class="brand-mark">${iconRadar()}</span>
      <span><strong>${escapeHTML(CONFIG.brand)}</strong><small>ATLAS / 04</small></span>
    </a>
    <div class="topbar-meta">
      <a href="/api/nodes">API</a>
      <span class="online"><i></i>数据在线</span>
    </div>
  </header>

  <main class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-title"><span>NETWORKS</span><strong>线路</strong></div>
      ${renderScopeNav(index.prefixes, selectedPrefix, selectedSource)}
      ${renderSourceSwitch(index.hasPool, selectedPrefix, selectedSource)}
      <div class="sidebar-note">
        <span>探测周期</span><strong>${CONFIG.checkIntervalMinutes} min</strong>
        <span>强制刷新</span><strong>${CONFIG.refreshIntervalHours} h</strong>
      </div>
    </aside>

    <section class="content">
      <header class="content-head">
        <div>
          <span class="kicker">EDGE NODE DIRECTORY</span>
          <h1>优选节点</h1>
          <p>${escapeHTML(selectedPrefix ? friendlyScope(selectedPrefix) : '全部线路')} · ${selectedSource === 'pool' ? '优良库' : '最新测速结果'}</p>
        </div>
        <div class="family-switch" aria-label="IP 版本">
          ${renderFamilyButton('ipv4', 'IPv4', snapshot.ipv4.rows.length, initialFamily)}
          ${renderFamilyButton('ipv6', 'IPv6', snapshot.ipv6.rows.length, initialFamily)}
        </div>
      </header>

      <section class="metric-strip" aria-label="数据摘要">
        ${renderMetric('节点', 'metric-count', '0', 'COUNT')}
        ${renderMetric('最快速度', 'metric-speed', '0 MB/s', 'THROUGHPUT')}
        ${renderMetric('最低延迟', 'metric-latency', '0 ms', 'LATENCY')}
        ${renderMetric('同步时间', 'metric-updated', '暂无数据', 'UPDATED')}
      </section>

      <div class="toolbar">
        <label class="search">${iconSearch()}<span class="sr-only">搜索节点</span><input id="search-input" type="search" placeholder="搜索 IP、地区或线路" autocomplete="off"></label>
        <label class="sort"><span class="sr-only">节点排序</span><select id="sort-select" aria-label="节点排序"><option value="speed">速度优先</option><option value="latency">延迟优先</option><option value="loss">丢包优先</option></select>${iconChevron()}</label>
        <button class="refresh" id="refresh-button" type="button" title="刷新数据" aria-label="刷新数据">${iconRefresh()}</button>
      </div>

      <section class="directory" aria-label="节点列表">
        <div class="list-head"><span>#</span><span>节点 / 地区</span><span>下载速度</span><span>延迟</span><span>丢包</span><span>操作</span></div>
        ${renderFamilyPanel('ipv4', snapshot.ipv4, initialFamily, selectedPrefix, selectedSource)}
        ${renderFamilyPanel('ipv6', snapshot.ipv6, initialFamily, selectedPrefix, selectedSource)}
        <div class="no-results" id="no-results" hidden>${iconSearch()}<strong>没有匹配的节点</strong></div>
      </section>
    </section>
  </main>

  <footer><span>${escapeHTML(CONFIG.brand)} Atlas</span><span>${escapeHTML(CONFIG.provider)} edge data</span></footer>
  <div class="toast" id="toast" role="status" aria-live="polite">${iconCheck()}<span>IP 已复制</span></div>
  <script>window.__ATLAS__=${safeJSON(appData)};</script>
  <script>${renderClientScript()}</script>
</body>
</html>`;
}

function renderScopeNav(prefixes, selectedPrefix, source) {
  const items = [scopeLink('', '全部线路', 'ALL', selectedPrefix, source)];
  items.push(...prefixes.map((prefix) => scopeLink(prefix, friendlyScope(prefix), scopeCode(prefix), selectedPrefix, source)));
  return `<nav class="network-nav" aria-label="网络线路">${items.join('')}</nav>`;
}

function scopeLink(prefix, label, code, selectedPrefix, source) {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  if (source === 'pool') params.set('source', 'pool');
  const href = params.size ? `/?${params.toString()}` : '/';
  const active = prefix === selectedPrefix;
  return `<a href="${escapeHTML(href)}" class="network-link${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}><span>${escapeHTML(code)}</span><strong>${escapeHTML(label)}</strong>${iconArrow()}</a>`;
}

function renderSourceSwitch(hasPool, selectedPrefix, selectedSource) {
  if (!hasPool) return '';
  const latest = new URLSearchParams();
  const pool = new URLSearchParams({ source: 'pool' });
  if (selectedPrefix) {
    latest.set('prefix', selectedPrefix);
    pool.set('prefix', selectedPrefix);
  }
  return `<div class="source-switch"><span>数据集</span><div><a href="${latest.size ? `/?${escapeHTML(latest.toString())}` : '/'}" class="${selectedSource === 'latest' ? 'active' : ''}">最新</a><a href="/?${escapeHTML(pool.toString())}" class="${selectedSource === 'pool' ? 'active' : ''}">优良库</a></div></div>`;
}

function renderFamilyButton(family, label, count, activeFamily) {
  if (!count) return '';
  const active = family === activeFamily;
  return `<button class="family-button${active ? ' active' : ''}" type="button" data-family="${family}" aria-pressed="${active}">${label}<span>${count}</span></button>`;
}

function renderMetric(label, id, value, code) {
  return `<div class="metric"><span>${code}</span><small>${label}</small><strong id="${id}">${escapeHTML(value)}</strong></div>`;
}

function renderFamilyPanel(family, data, activeFamily, selectedPrefix, selectedSource) {
  const active = family === activeFamily;
  const maxSpeed = Math.max(0, ...data.rows.map((row) => row.speed));
  const rows = data.rows.map((row, index) => renderNodeRow(row, index, maxSpeed, selectedPrefix, selectedSource, family)).join('');
  return `<div class="family-panel${active ? ' active' : ''}" id="panel-${family}" data-family="${family}"${active ? '' : ' hidden'}>${rows || renderEmpty(family)}</div>`;
}

function renderNodeRow(row, index, maxSpeed, selectedPrefix, selectedSource, family) {
  const width = maxSpeed ? Math.max(3, Math.min(100, row.speed / maxSpeed * 100)) : 0;
  const tone = operatorTone(row.scope);
  const scope = row.scope ? friendlyScope(row.scope) : '默认';
  const search = `${row.ip} ${row.colo} ${regionLabel(row.colo)} ${scope}`.toLowerCase();
  const state = row.loss <= 0 && row.latency < 100 ? 'excellent' : row.loss <= 1 && row.latency < 180 ? 'good' : 'watch';
  return `<article class="node-row ${tone}" data-search="${escapeHTML(search)}" data-speed="${row.speed}" data-latency="${row.latency}" data-loss="${row.loss}">
    <div class="rank"><span class="rank-value">${String(index + 1).padStart(2, '0')}</span></div>
    <div class="identity"><code>${escapeHTML(row.ip)}</code><div>${iconPin()}<span>${escapeHTML(regionLabel(row.colo))}</span><b>${escapeHTML(row.colo)}</b>${selectedPrefix ? '' : `<em>${escapeHTML(scope)}</em>`}</div></div>
    <div class="throughput"><strong>${formatNumber(row.speed)}<small>MB/s</small></strong><div><i style="width:${width.toFixed(2)}%"></i></div></div>
    <div class="latency"><strong>${formatNumber(row.latency)}</strong><span>ms</span></div>
    <div class="loss"><i class="${state}"></i><strong>${formatNumber(row.loss)}%</strong><small>${row.received}/${row.packets}</small></div>
    <div class="node-actions">
      <button class="action dns-action" type="button" data-admin-action="dns" data-ip="${escapeHTML(row.ip)}" data-family="${family}" data-scope="${escapeHTML(row.scope)}" title="设为对应域名的 DNS 解析" aria-label="将 ${escapeHTML(row.ip)} 设为 DNS 解析">${iconGlobe()}</button>
      ${selectedSource === 'latest' ? `<button class="action pool-action" type="button" data-admin-action="pool" data-ip="${escapeHTML(row.ip)}" data-family="${family}" data-scope="${escapeHTML(row.scope)}" title="加入对应线路优良库" aria-label="将 ${escapeHTML(row.ip)} 加入优良库">${iconPlus()}</button>` : ''}
      <button class="copy" type="button" data-copy-ip="${escapeHTML(row.ip)}" title="复制 IP" aria-label="复制 ${escapeHTML(row.ip)}">${iconCopy()}</button>
    </div>
  </article>`;
}

function renderEmpty(family) {
  return `<div class="empty">${iconRadar()}<strong>暂无 ${family.toUpperCase()} 数据</strong><span>当前 KV 中没有对应结果</span></div>`;
}

function summarize(data) {
  const latencies = data.rows.map((row) => row.latency).filter((value) => value > 0);
  return {
    count: data.rows.length,
    bestSpeed: data.rows.length ? Math.max(...data.rows.map((row) => row.speed)) : 0,
    lowestLatency: latencies.length ? Math.min(...latencies) : 0,
    updatedAt: data.updatedAt || null,
  };
}

function friendlyScope(prefix) {
  if (!prefix) return '默认';
  const code = prefix.split('.')[0].toLowerCase();
  const names = {
    ct: '中国电信', dx: '中国电信', telecom: '中国电信',
    cm: '中国移动', yd: '中国移动', mobile: '中国移动',
    cu: '中国联通', lt: '中国联通', unicom: '中国联通', wjt: '天威视讯',
  };
  return names[code] || prefix;
}

function scopeCode(prefix) {
  if (!prefix) return 'ALL';
  return prefix.split('.')[0].slice(0, 4).toUpperCase();
}

function operatorTone(prefix) {
  const code = (prefix || '').split('.')[0].toLowerCase();
  if (['ct', 'dx', 'telecom'].includes(code)) return 'tone-blue';
  if (['cm', 'yd', 'mobile'].includes(code)) return 'tone-green';
  if (['cu', 'lt', 'unicom'].includes(code)) return 'tone-coral';
  return 'tone-neutral';
}

function regionLabel(colo) {
  if (!colo || colo === 'N/A') return '未知地区';
  return REGION_NAMES[colo.toUpperCase()] || colo.toUpperCase();
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function escapeHTML(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function safeJSON(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120', ...SECURITY_HEADERS } });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30, stale-while-revalidate=120', ...SECURITY_HEADERS } });
}

function privateJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
    },
  });
}

function textResponse(text, status, extraHeaders = {}) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS, ...extraHeaders } });
}

function faviconResponse() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#151821"/><circle cx="32" cy="32" r="18" fill="none" stroke="#ff6045" stroke-width="5"/><circle cx="32" cy="32" r="5" fill="#1db78a"/><path d="M32 8v12M56 32H44M32 56V44M8 32h12" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...SECURITY_HEADERS } });
}

function renderError(message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(CONFIG.brand)}</title><style>${renderStyles()}</style></head><body><main class="error">${iconRadar()}<h1>Atlas 暂不可用</h1><p>${escapeHTML(message)}</p></main></body></html>`;
}

function renderClientScript() {
  return `(function(){'use strict';
  var app=window.__ATLAS__,activeFamily=app.initialFamily;
  var search=document.getElementById('search-input'),sort=document.getElementById('sort-select'),empty=document.getElementById('no-results'),toast=document.getElementById('toast'),timer;
  function fmt(value){return Number(value).toLocaleString('en-US',{maximumFractionDigits:2});}
  function compactTime(value){if(!value)return '暂无数据';return window.innerWidth<=600&&value.length>=16?value.slice(5,16):value;}
  function updateMetrics(){var data=app.families[activeFamily];document.getElementById('metric-count').textContent=String(data.count);document.getElementById('metric-speed').textContent=fmt(data.bestSpeed)+' MB/s';document.getElementById('metric-latency').textContent=fmt(data.lowestLatency)+' ms';var updated=document.getElementById('metric-updated');updated.textContent=compactTime(data.updatedAt);updated.title=data.updatedAt||'';}
  function panel(){return document.getElementById('panel-'+activeFamily);}
  function applyView(){var current=panel();if(!current)return;var query=search.value.trim().toLowerCase(),sortBy=sort.value,rows=Array.prototype.slice.call(current.querySelectorAll('.node-row'));
    rows.sort(function(a,b){var av=Number(a.dataset[sortBy]),bv=Number(b.dataset[sortBy]);return sortBy==='speed'?bv-av||Number(a.dataset.latency)-Number(b.dataset.latency):av-bv||Number(b.dataset.speed)-Number(a.dataset.speed);});
    var visible=0;rows.forEach(function(row){var show=!query||row.dataset.search.indexOf(query)!==-1;row.hidden=!show;if(show){visible+=1;row.querySelector('.rank-value').textContent=String(visible).padStart(2,'0');}current.appendChild(row);});empty.hidden=visible!==0||rows.length===0;}
  function setFamily(family){activeFamily=family;document.querySelectorAll('.family-panel').forEach(function(item){var active=item.dataset.family===family;item.hidden=!active;item.classList.toggle('active',active);});document.querySelectorAll('.family-button').forEach(function(button){var active=button.dataset.family===family;button.classList.toggle('active',active);button.setAttribute('aria-pressed',active?'true':'false');});updateMetrics();applyView();}
  function showToast(text,isError){toast.querySelector('span').textContent=text;toast.classList.toggle('error-toast',!!isError);toast.classList.add('visible');clearTimeout(timer);timer=setTimeout(function(){toast.classList.remove('visible');},2600);}
  function copy(value){if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(value).then(function(){showToast('已复制 '+value);});return;}var area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();document.execCommand('copy');area.remove();showToast('已复制 '+value);}
  function getAdminToken(){var token='';try{token=sessionStorage.getItem('atlas_admin_token')||'';}catch(error){}if(!token){token=window.prompt('请输入 Atlas 管理员令牌')||'';if(token){try{sessionStorage.setItem('atlas_admin_token',token);}catch(error){}}}return token;}
  async function runAdminAction(button){var action=button.dataset.adminAction;if(action==='dns'&&!window.confirm('确认将 '+button.dataset.ip+' 设置为对应域名的 DNS 解析吗？'))return;var token=getAdminToken();if(!token)return;button.disabled=true;button.classList.add('loading');try{var response=await fetch('/api/admin/'+action,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({ip:button.dataset.ip,family:button.dataset.family,scope:button.dataset.scope||''})});var data=await response.json();if(!response.ok){if(response.status===401){try{sessionStorage.removeItem('atlas_admin_token');}catch(error){}}throw new Error(data.error||'操作失败');}button.classList.add('done');if(action==='pool')button.disabled=true;showToast(data.message||'操作成功');}catch(error){button.disabled=false;showToast(error.message||'操作失败',true);}finally{button.classList.remove('loading');}}
  document.addEventListener('click',function(event){var family=event.target.closest('.family-button');if(family)setFamily(family.dataset.family);var adminButton=event.target.closest('[data-admin-action]');if(adminButton)runAdminAction(adminButton);var copyButton=event.target.closest('[data-copy-ip]');if(copyButton)copy(copyButton.dataset.copyIp);});
  search.addEventListener('input',applyView);sort.addEventListener('change',applyView);window.addEventListener('resize',updateMetrics);document.getElementById('refresh-button').addEventListener('click',function(){this.classList.add('spinning');location.reload();});updateMetrics();applyView();}());`;
}

function renderStyles() {
  return `
  *,*::before,*::after{box-sizing:border-box} :root{color-scheme:light;--ink:#151821;--muted:#747a87;--line:#e1e5ea;--canvas:#f2f4f7;--paper:#fff;--blue:#294fe8;--green:#0d9b72;--coral:#ef6045;--font:"Segoe UI Variable Text","Aptos","PingFang SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;--display:"Segoe UI Variable Display","Aptos Display","PingFang SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;--mono:"JetBrains Mono","Cascadia Mono","SFMono-Regular","Roboto Mono",Consolas,monospace}
  html{min-width:320px;background:var(--canvas)}body{margin:0;min-width:320px;min-height:100vh;color:var(--ink);background:var(--canvas);font-family:var(--font);font-size:14px;line-height:1.5;font-synthesis:none;-webkit-font-smoothing:antialiased}button,input,select{font:inherit}a,button{-webkit-tap-highlight-color:transparent}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid rgba(41,79,232,.22);outline-offset:2px}[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .topbar{height:68px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;background:var(--paper);border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none}.brand-mark{width:36px;height:36px;display:grid;place-items:center;color:#fff;background:var(--ink);border-radius:10px}.brand-mark svg{width:20px;height:20px}.brand>span:last-child{display:flex;flex-direction:column}.brand strong{font-size:15px;font-weight:850;line-height:1.15;letter-spacing:-.02em}.brand small{color:var(--coral);font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.08em}.topbar-meta{display:flex;align-items:center;gap:16px}.topbar-meta>a{color:var(--ink);font-family:var(--mono);font-size:10px;font-weight:700;text-decoration:none}.online{display:flex;align-items:center;gap:7px;color:var(--green);font-size:11px;font-weight:750}.online i{width:7px;height:7px;background:var(--green);border-radius:50%;box-shadow:0 0 0 4px rgba(13,155,114,.1)}
  .app-shell{min-height:calc(100vh - 68px);display:grid;grid-template-columns:240px minmax(0,1fr);gap:0}.sidebar{padding:32px 20px;background:#e9edf1;border-right:1px solid #d9dee4}.sidebar-title{display:flex;flex-direction:column;margin:0 8px 20px}.sidebar-title span,.kicker{color:var(--coral);font-family:var(--mono);font-size:9px;font-weight:800;letter-spacing:.1em}.sidebar-title strong{font-size:23px;letter-spacing:-.05em}.network-nav{display:flex;flex-direction:column;gap:5px}.network-link{display:grid;grid-template-columns:38px minmax(0,1fr) 16px;align-items:center;gap:7px;min-height:48px;padding:8px 10px;color:var(--muted);border-radius:12px;text-decoration:none}.network-link>span{font-family:var(--mono);font-size:9px;font-weight:700}.network-link strong{overflow:hidden;font-size:12px;font-weight:750;text-overflow:ellipsis;white-space:nowrap}.network-link svg{width:14px;height:14px;opacity:0}.network-link:hover{color:var(--ink);background:rgba(255,255,255,.55)}.network-link.active{color:#fff;background:var(--ink);box-shadow:0 8px 18px rgba(21,24,33,.12)}.network-link.active svg{opacity:1}.source-switch{margin:28px 8px 0;padding-top:20px;border-top:1px solid #d3d8de}.source-switch>span{display:block;margin-bottom:8px;color:var(--muted);font-size:10px;font-weight:700}.source-switch>div{display:flex;padding:3px;background:#dce1e6;border-radius:10px}.source-switch a{flex:1;padding:6px;color:var(--muted);border-radius:8px;font-size:10px;font-weight:750;text-align:center;text-decoration:none}.source-switch a.active{color:var(--ink);background:#fff}.sidebar-note{display:grid;grid-template-columns:1fr auto;gap:7px 10px;margin:28px 8px 0;padding-top:20px;color:var(--muted);border-top:1px solid #d3d8de;font-size:10px}.sidebar-note strong{color:var(--ink);font-family:var(--mono);font-size:10px}
  .content{min-width:0;padding:38px clamp(24px,4vw,64px) 64px}.content-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px}.content-head h1{margin:3px 0 0;font-size:42px;line-height:1.05;letter-spacing:-.065em}.content-head p{margin:8px 0 0;color:var(--muted);font-size:12px}.family-switch{display:flex;gap:5px;padding:4px;background:#e2e6ea;border-radius:12px}.family-button{display:flex;align-items:center;gap:7px;min-height:36px;padding:7px 12px;color:var(--muted);background:transparent;border:0;border-radius:9px;font-size:11px;font-weight:800;cursor:pointer}.family-button span{font-family:var(--mono);font-size:9px}.family-button.active{color:#fff;background:var(--ink)}
  .metric-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:30px 0 26px;overflow:hidden;color:#fff;background:var(--ink);border-radius:16px}.metric{position:relative;min-width:0;padding:18px 20px;border-right:1px solid rgba(255,255,255,.12)}.metric:last-child{border-right:0}.metric>span{display:block;color:#8f96a3;font-family:var(--mono);font-size:8px;letter-spacing:.08em}.metric small{display:block;margin-top:7px;color:#b7bdc7;font-size:10px}.metric strong{display:block;overflow:hidden;margin-top:1px;font-size:20px;line-height:1.2;text-overflow:ellipsis;white-space:nowrap}.metric:nth-child(2) strong{color:#71a0ff}.metric:nth-child(3) strong{color:#42d1a5}#metric-updated{font-family:var(--mono);font-size:11px;letter-spacing:-.04em}
  .toolbar{display:flex;gap:9px;margin-bottom:12px}.search{position:relative;flex:1}.search svg{position:absolute;top:50%;left:13px;width:16px;height:16px;color:var(--muted);transform:translateY(-50%)}.search input{width:100%;height:42px;padding:8px 12px 8px 38px;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:12px}.search input::placeholder{color:#a0a6b0}.sort{position:relative;flex:0 0 138px}.sort select{width:100%;height:42px;appearance:none;padding:8px 32px 8px 12px;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:12px}.sort svg{position:absolute;top:50%;right:11px;width:15px;height:15px;color:var(--muted);transform:translateY(-50%);pointer-events:none}.refresh,.copy,.action{display:grid;place-items:center;color:var(--muted);background:var(--paper);border:1px solid var(--line);cursor:pointer}.refresh{width:42px;height:42px;border-radius:12px}.refresh:hover,.copy:hover,.action:hover{color:var(--blue);border-color:#b4c2ff}.refresh svg,.copy svg,.action svg{width:16px;height:16px}.refresh.spinning svg,.action.loading svg{animation:spin .7s linear infinite}.action.done{color:var(--green);background:#e9f8f3;border-color:#bce8d9}.action:disabled{cursor:default;opacity:.72}@keyframes spin{to{transform:rotate(360deg)}}
  .directory{min-width:0;overflow:hidden;background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 10px 28px rgba(20,24,33,.045)}.list-head,.node-row{display:grid;grid-template-columns:54px minmax(210px,1.45fr) minmax(170px,1fr) 96px 88px 112px;align-items:center;gap:14px}.list-head{min-height:38px;padding:0 16px;color:#9298a3;background:#f7f8fa;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:8px;letter-spacing:.06em}.node-row{--tone:#737a87;min-height:86px;padding:12px 16px;border-bottom:1px solid var(--line);transition:background .16s ease}.node-row:last-child{border-bottom:0}.node-row:hover{background:#fafbfc}.tone-blue{--tone:var(--blue)}.tone-green{--tone:var(--green)}.tone-coral{--tone:var(--coral)}.rank span{font-family:var(--mono);font-size:13px;font-weight:800}.identity{min-width:0}.identity code{display:block;overflow:hidden;color:var(--ink);font-family:var(--mono);font-size:15px;font-weight:750;letter-spacing:-.04em;text-overflow:ellipsis;white-space:nowrap}.identity>div{display:flex;align-items:center;gap:5px;margin-top:7px;color:var(--muted);font-size:9px}.identity svg{width:12px;height:12px}.identity b,.identity em{padding:2px 5px;border-radius:4px;font-family:var(--mono);font-size:8px;font-style:normal}.identity b{background:#eef1f4}.identity em{color:var(--tone);background:#f4f5f7}.throughput strong{display:block;color:var(--tone);font-size:18px;line-height:1.1}.throughput small{margin-left:4px;color:var(--muted);font-family:var(--mono);font-size:8px}.throughput>div{height:4px;margin-top:8px;overflow:hidden;background:#e9ecf0;border-radius:99px}.throughput i{display:block;height:100%;background:var(--tone);border-radius:99px}.latency strong{font-size:17px}.latency span{margin-left:3px;color:var(--muted);font-family:var(--mono);font-size:8px}.loss{display:grid;grid-template-columns:8px 1fr;align-items:center;gap:3px}.loss>i{width:7px;height:7px;background:var(--muted);border-radius:50%}.loss>i.excellent{background:var(--green)}.loss>i.good{background:var(--blue)}.loss>i.watch{background:var(--coral)}.loss strong{font-size:12px}.loss small{grid-column:2;color:var(--muted);font-family:var(--mono);font-size:8px}.node-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px}.copy,.action{width:32px;height:32px;border-radius:9px}.family-panel.active{animation:enter .22s ease}@keyframes enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}.empty,.no-results{min-height:220px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--muted)}.empty svg,.no-results svg{width:28px;height:28px}.empty strong,.no-results strong{color:var(--ink)}.empty span{font-size:10px}
  footer{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;color:#8e94a0;background:var(--ink);font-family:var(--mono);font-size:9px}.toast{position:fixed;z-index:20;right:22px;bottom:20px;display:flex;align-items:center;gap:8px;max-width:calc(100% - 44px);padding:10px 13px;color:#fff;background:var(--ink);border-radius:12px;box-shadow:0 14px 28px rgba(21,24,33,.2);opacity:0;transform:translateY(10px);pointer-events:none;transition:.2s}.toast.visible{opacity:1;transform:none}.toast.error-toast{background:#a9342b}.toast svg{width:15px;height:15px;color:#42d1a5}.toast span{overflow:hidden;font-size:11px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.error{min-height:100vh;display:grid;place-content:center;justify-items:center;padding:24px;text-align:center}.error>svg{width:42px;height:42px;color:var(--coral)}.error h1{font-size:28px}.error p{color:var(--muted)}
  body,button,input,select{letter-spacing:0}.brand strong,.sidebar-title strong,.content-head h1,.metric strong,.throughput strong,.latency strong,.loss strong,.error h1{font-family:var(--display);letter-spacing:0}.brand strong{font-weight:700}.brand small,.sidebar-title span,.kicker,.metric>span,.list-head,#metric-updated{letter-spacing:0}.sidebar-title strong{font-weight:700}.network-link strong,.source-switch a,.family-button{font-weight:600}.content-head h1{font-size:40px;font-weight:700;line-height:1.12}.metric strong{font-weight:700}.rank span{font-weight:600}.identity code{font-family:var(--mono);font-size:14px;font-weight:600;letter-spacing:0}.throughput strong,.latency strong,.loss strong{font-weight:700;font-variant-numeric:tabular-nums}.throughput small,.latency span,.loss small{letter-spacing:0}
  @media(max-width:980px){.app-shell{grid-template-columns:1fr}.sidebar{padding:16px 20px;border-right:0;border-bottom:1px solid #d9dee4}.sidebar-title{display:none}.network-nav{flex-direction:row;overflow-x:auto;scrollbar-width:none}.network-nav::-webkit-scrollbar{display:none}.network-link{flex:0 0 auto;grid-template-columns:30px auto;min-height:40px}.network-link svg{display:none}.source-switch{display:flex;align-items:center;gap:12px;margin:12px 0 0;padding:12px 0 0}.source-switch>span{margin:0}.source-switch>div{width:150px}.sidebar-note{display:none}.content{padding:30px 24px 54px}.list-head,.node-row{grid-template-columns:46px minmax(170px,1.35fr) minmax(130px,1fr) 76px 66px 104px;gap:9px}}
  @media(max-width:720px){.topbar{height:62px;padding:0 16px}.brand-mark{width:34px;height:34px}.topbar-meta>a{display:none}.content{padding:25px 14px 44px}.content-head{align-items:flex-start;flex-direction:column}.content-head h1{font-size:34px}.family-switch{align-self:stretch}.family-button{flex:1}.metric-strip{grid-template-columns:1fr 1fr;border-radius:14px}.metric{padding:14px 15px}.metric:nth-child(2){border-right:0}.metric:nth-child(-n+2){border-bottom:1px solid rgba(255,255,255,.12)}.metric strong{font-size:18px}.toolbar{flex-wrap:wrap}.search{flex-basis:100%}.sort{flex:1}.directory{overflow:visible;background:transparent;border:0;border-radius:0;box-shadow:none}.list-head{display:none}.family-panel{display:grid;gap:10px}.node-row{grid-template-columns:38px minmax(0,1fr) auto;grid-template-areas:"rank identity actions" ". speed speed" ". latency loss";gap:12px 9px;min-height:0;padding:16px;background:var(--paper);border:1px solid var(--line);border-radius:14px;box-shadow:0 8px 18px rgba(20,24,33,.04)}.node-row:hover{background:var(--paper)}.rank{grid-area:rank}.identity{grid-area:identity}.node-actions{grid-area:actions}.throughput{grid-area:speed}.latency{grid-area:latency}.loss{grid-area:loss;justify-self:end}.throughput strong{font-size:22px}.latency strong{font-size:20px}.copy,.action{width:30px;height:30px}.no-results{background:var(--paper);border-radius:14px}footer{height:auto;min-height:66px;gap:12px;padding:16px;text-align:center}.toast{right:14px;bottom:14px}}
  @media(max-width:440px){.sidebar{padding:13px 12px}.network-link{padding:7px 9px}.content-head p{font-size:11px}.metric strong{font-size:16px}#metric-updated{font-size:10px}.identity code{font-size:14px}}
  @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
  `;
}

function svg(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

function iconRadar() { return svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M22 12h-3M12 22v-3M2 12h3"/>'); }
function iconArrow() { return svg('<path d="m9 18 6-6-6-6"/>'); }
function iconSearch() { return svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'); }
function iconChevron() { return svg('<path d="m6 9 6 6 6-6"/>'); }
function iconRefresh() { return svg('<path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/>'); }
function iconPin() { return svg('<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'); }
function iconCopy() { return svg('<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'); }
function iconCheck() { return svg('<path d="M20 6 9 17l-5-5"/>'); }
function iconGlobe() { return svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/>'); }
function iconPlus() { return svg('<circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/>'); }
