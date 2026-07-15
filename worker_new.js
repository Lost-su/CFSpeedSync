const CDN = 'Cloudflare';
const domain = 'cname.example.com';
const wildcardDomain = true;
const checkInterval = 30;
const testInterval = 24;

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    const selectedPrefix = url.searchParams.get('prefix') || '';
    const availablePrefixes = await getAvailablePrefixes();

    let ipv4Data, ipv6Data, ipv4time, ipv6time;

    if (selectedPrefix) {
      const kvPrefix = selectedPrefix + ':';
      ipv4Data = await KV_NAMESPACE.get(kvPrefix + 'ipv4');
      ipv6Data = await KV_NAMESPACE.get(kvPrefix + 'ipv6');
      ipv4time = await KV_NAMESPACE.get(kvPrefix + 'ipv4time');
      ipv6time = await KV_NAMESPACE.get(kvPrefix + 'ipv6time');
    } else {
      const allData = await getAllData(availablePrefixes);
      ipv4Data = allData.ipv4Data;
      ipv6Data = allData.ipv6Data;
      ipv4time = allData.ipv4time;
      ipv6time = allData.ipv6time;
    }

    const enableIPv4 = !!ipv4Data;
    const enableIPv6 = !!ipv6Data;
    const ipv4timeStr = ipv4time || '未知';
    const ipv6timeStr = ipv6time || '未知';

    const ipv4Rows = enableIPv4 ? parseRows(ipv4Data) : [];
    const ipv6Rows = enableIPv6 ? parseRows(ipv6Data) : [];

    const html = buildHTML({
      enableIPv4, enableIPv6,
      ipv4Rows, ipv6Rows,
      ipv4timeStr, ipv6timeStr,
      availablePrefixes, selectedPrefix,
    });

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      status: 200,
    });
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
}

async function getAvailablePrefixes() {
  try {
    const listResult = await KV_NAMESPACE.list();
    const keys = listResult.keys.map(k => k.name);
    const prefixes = new Set();
    keys.forEach(key => {
      if (key.includes(':')) {
        const [prefix, suffix] = key.split(':');
        if (['ipv4','ipv4time','ipv6','ipv6time'].includes(suffix)) {
          prefixes.add(prefix);
        }
      }
    });
    return Array.from(prefixes).sort();
  } catch (e) {
    return [];
  }
}

async function getAllData(prefixes) {
  try {
    let allIPv4 = [], allIPv6 = [];
    let latestIPv4Time = null, latestIPv6Time = null;

    const defv4 = await KV_NAMESPACE.get('ipv4');
    const defv6 = await KV_NAMESPACE.get('ipv6');
    const defv4t = await KV_NAMESPACE.get('ipv4time');
    const defv6t = await KV_NAMESPACE.get('ipv6time');
    if (defv4) { allIPv4.push(defv4); latestIPv4Time = defv4t; }
    if (defv6) { allIPv6.push(defv6); latestIPv6Time = defv6t; }

    for (const prefix of prefixes) {
      const p = prefix + ':';
      const v4 = await KV_NAMESPACE.get(p + 'ipv4');
      const v6 = await KV_NAMESPACE.get(p + 'ipv6');
      const v4t = await KV_NAMESPACE.get(p + 'ipv4time');
      const v6t = await KV_NAMESPACE.get(p + 'ipv6time');
      if (v4) { allIPv4.push(v4); if (!latestIPv4Time || (v4t && v4t > latestIPv4Time)) latestIPv4Time = v4t; }
      if (v6) { allIPv6.push(v6); if (!latestIPv6Time || (v6t && v6t > latestIPv6Time)) latestIPv6Time = v6t; }
    }

    return {
      ipv4Data: allIPv4.length > 0 ? allIPv4.join('&') : null,
      ipv6Data: allIPv6.length > 0 ? allIPv6.join('&') : null,
      ipv4time: latestIPv4Time,
      ipv6time: latestIPv6Time,
    };
  } catch (e) {
    return { ipv4Data: null, ipv6Data: null, ipv4time: null, ipv6time: null };
  }
}

function speedClass(v) {
  return v >= 20 ? 'speed-high' : v >= 8 ? 'speed-mid' : 'speed-low';
}

function parseRows(raw) {
  if (!raw) return [];
  return raw.split('&')
    .map(r => r.split(','))
    .filter(c => c.length === 7);
}

function renderRows(rows) {
  if (rows.length === 0) {
    return `<tr><td colspan="7" class="empty">暂无数据</td></tr>`;
  }
  return rows.map((c, i) => {
    const loss = parseFloat(c[3]);
    const spd  = parseFloat(c[5]);
    const lossClass = loss > 5 ? 'bad' : 'good';
    const spdClass  = speedClass(spd);
    const rank = i === 0 ? '<span class="crown">👑</span>' : `<span class="rank">${i + 1}</span>`;
    return `<tr>
      <td>${rank}</td>
      <td class="mono">${c[0]}</td>
      <td><span class="tag tag-cdn">${CDN}</span></td>
      <td><span class="tag ${c[6] === 'N/A' ? 'tag-na' : 'tag-dc'}">${c[6]}</span></td>
      <td><span class="tag ${lossClass}">${c[3]}%</span></td>
      <td class="delay">${c[4]} <em>ms</em></td>
      <td class="${spdClass}">${c[5]} <em>MB/s</em></td>
    </tr>`;
  }).join('');
}

const ISP_NAMES = { cm: '移动', cu: '联通', ct: '电信', wjt: '天威' };
function friendlyName(prefix) {
  if (!prefix) return '全部';
  const sub = prefix.split('.')[0];
  return ISP_NAMES[sub] || prefix;
}

function buildHTML({ enableIPv4, enableIPv6, ipv4Rows, ipv6Rows, ipv4timeStr, ipv6timeStr, availablePrefixes, selectedPrefix }) {
  const ipv4Table = renderRows(ipv4Rows);
  const ipv6Table = renderRows(ipv6Rows);
  const defaultTab = enableIPv4 ? 'ipv4' : 'ipv6';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Best ${CDN}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0f1117; --surface: #1a1d27; --surface2: #22263a; --border: #2e3350;
    --text: #e2e8f0; --muted: #7c85a2; --accent: #6366f1; --accent2: #818cf8;
    --green: #34d399; --yellow: #fbbf24; --red: #f87171; --blue: #60a5fa;
    --radius: 12px; --radius-sm: 6px; --shadow: 0 4px 24px rgba(0,0,0,.4);
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: var(--bg); color: var(--text); min-height: 100vh;
    padding: 24px 16px 48px;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 32px; flex-wrap: wrap; gap: 12px;
  }
  .logo {
    display: flex; align-items: center; gap: 10px;
    font-size: 1.25rem; font-weight: 700; letter-spacing: -.3px;
  }
  .logo-icon {
    width: 36px; height: 36px;
    background: linear-gradient(135deg, var(--accent), #a78bfa);
    border-radius: 10px; display: flex; align-items: center; justify-content: center;
    font-size: 18px;
  }
  .badge-live {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px;
    background: rgba(52,211,153,.12); border: 1px solid rgba(52,211,153,.25);
    border-radius: 20px; font-size: .75rem; color: var(--green);
  }
  .badge-live::before {
    content: ''; width: 7px; height: 7px; border-radius: 50%;
    background: var(--green); animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  .isp-bar {
    display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px;
  }
  .isp-btn {
    padding: 7px 20px; border-radius: 8px; border: 1px solid var(--border);
    background: var(--surface); color: var(--muted); font-size: .88rem;
    font-weight: 500; cursor: pointer; transition: all .18s;
  }
  .isp-btn:hover { color: var(--text); border-color: var(--accent2); }
  .isp-btn.active {
    background: var(--accent); border-color: var(--accent);
    color: #fff; box-shadow: 0 0 12px rgba(99,102,241,.35);
  }
  .tab-bar {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 16px; flex-wrap: wrap;
  }
  .tabs {
    display: inline-flex; background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 3px; gap: 3px;
  }
  .tab-btn {
    padding: 6px 18px; border-radius: 6px; border: none; cursor: pointer;
    font-size: .88rem; font-weight: 500; color: var(--muted);
    background: transparent; transition: all .18s;
  }
  .tab-btn.active { background: var(--accent); color: #fff; }
  .tab-btn:hover:not(.active) { color: var(--text); }
  .time-chip {
    margin-left: auto; font-size: .78rem; color: var(--muted);
    background: var(--surface); border: 1px solid var(--border);
    padding: 5px 12px; border-radius: 20px; white-space: nowrap;
  }
  .time-chip span { color: var(--text); }
  .table-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow);
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; animation: fadeUp .25s ease; }
  @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:none} }
  .overflow { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; min-width: 600px; }
  thead tr { background: var(--surface2); border-bottom: 1px solid var(--border); }
  th {
    padding: 12px 16px; text-align: left; font-size: .78rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: .06em; color: var(--muted); white-space: nowrap;
  }
  td {
    padding: 11px 16px; font-size: .87rem;
    border-bottom: 1px solid rgba(46,51,80,.5); vertical-align: middle;
  }
  tr:last-child td { border-bottom: none; }
  tbody tr { transition: background .15s; }
  tbody tr:hover { background: var(--surface2); }
  .mono { font-family: 'JetBrains Mono','Fira Code','Courier New',monospace; font-size: .85rem; }
  em { font-style: normal; color: var(--muted); font-size: .8rem; }
  .rank {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; background: var(--surface2);
    border: 1px solid var(--border); border-radius: 6px;
    font-size: .78rem; color: var(--muted); font-weight: 600;
  }
  .crown { font-size: 1rem; }
  .tag {
    display: inline-block; padding: 2px 9px; border-radius: 20px;
    font-size: .75rem; font-weight: 500; white-space: nowrap;
  }
  .tag-cdn { background: rgba(99,102,241,.15); color: var(--accent2); border: 1px solid rgba(99,102,241,.3); }
  .tag-dc  { background: rgba(96,165,250,.12);  color: var(--blue);    border: 1px solid rgba(96,165,250,.25); }
  .tag-na  { background: rgba(248,113,113,.12); color: var(--red);     border: 1px solid rgba(248,113,113,.25); }
  .good    { background: rgba(52,211,153,.12);  color: var(--green);   border: 1px solid rgba(52,211,153,.25); }
  .bad     { background: rgba(248,113,113,.12); color: var(--red);     border: 1px solid rgba(248,113,113,.25); }
  .speed-high { color: var(--green); font-weight: 600; }
  .speed-mid  { color: var(--blue);  font-weight: 500; }
  .speed-low  { color: var(--muted); }
  .delay      { color: var(--yellow); }
  .empty { text-align: center; padding: 56px 16px; color: var(--muted); font-size: .9rem; }
  footer {
    margin-top: 32px; text-align: center; font-size: .78rem;
    color: var(--muted); line-height: 1.8;
  }
  footer a { color: var(--accent2); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  @media (max-width: 640px) {
    th:nth-child(3), td:nth-child(3) { display: none; }
    .time-chip { font-size: .72rem; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">
      <div class="logo-icon">⚡</div>
      Best ${CDN}
    </div>
    <span class="badge-live">实时监控中</span>
  </header>

  ${availablePrefixes.length > 0 ? `
  <div class="isp-bar">
    <button class="isp-btn${selectedPrefix === '' ? ' active' : ''}" onclick="switchDomain('')">全部</button>
    ${availablePrefixes.map(p => `<button class="isp-btn${selectedPrefix === p ? ' active' : ''}" onclick="switchDomain('${p}')">${friendlyName(p)}</button>`).join('')}
  </div>` : ''}

  <div class="tab-bar">
    <div class="tabs">
      ${enableIPv4 ? `<button class="tab-btn${defaultTab === 'ipv4' ? ' active' : ''}" onclick="showTab('ipv4')" id="btn-ipv4">IPv4</button>` : ''}
      ${enableIPv6 ? `<button class="tab-btn${defaultTab === 'ipv6' ? ' active' : ''}" onclick="showTab('ipv6')" id="btn-ipv6">IPv6</button>` : ''}
    </div>
    <div class="time-chip" id="time-chip" data-ipv4="${ipv4timeStr}" data-ipv6="${ipv6timeStr}">
      更新：<span id="time-val">${defaultTab === 'ipv4' ? ipv4timeStr : ipv6timeStr}</span>
    </div>
  </div>

  <div class="table-card">
    ${enableIPv4 ? `
    <div class="tab-panel${defaultTab === 'ipv4' ? ' active' : ''}" id="panel-ipv4">
      <div class="overflow"><table>
        <thead><tr><th>#</th><th>IP 地址</th><th>CDN</th><th>数据中心</th><th>丢包率</th><th>延迟</th><th>下载速度</th></tr></thead>
        <tbody>${ipv4Table}</tbody>
      </table></div>
    </div>` : ''}
    ${enableIPv6 ? `
    <div class="tab-panel${defaultTab === 'ipv6' ? ' active' : ''}" id="panel-ipv6">
      <div class="overflow"><table>
        <thead><tr><th>#</th><th>IP 地址</th><th>CDN</th><th>数据中心</th><th>丢包率</th><th>延迟</th><th>下载速度</th></tr></thead>
        <tbody>${ipv6Table}</tbody>
      </table></div>
    </div>` : ''}
  </div>

  <footer>
    <p>© ${new Date().getFullYear()} Best ${CDN} &nbsp;·&nbsp; 本站不提供任何 CDN 服务，严禁用于违法用途</p>
  </footer>
</div>
<script>
  function showTab(name) {
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    const panel = document.getElementById('panel-' + name);
    const btn   = document.getElementById('btn-' + name);
    if (panel) panel.classList.add('active');
    if (btn)   btn.classList.add('active');
    const chip = document.getElementById('time-chip');
    const val  = document.getElementById('time-val');
    if (chip && val) val.textContent = chip.dataset[name] || '未知';
  }
  function switchDomain(prefix) {
    const u = new URL(location.href);
    prefix ? u.searchParams.set('prefix', prefix) : u.searchParams.delete('prefix');
    location.href = u.toString();
  }
</script>
</body>
</html>`;
}