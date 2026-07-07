const CDN = 'Cloudflare'; // 服务商
const domain = 'cname.example.com'; // 优选域名
const wildcardDomain = true; // 是否支持泛域名
const checkInterval = 30; // 检测间隔 单位：分钟
const testInterval = 24; // 强制刷新间隔 单位：小时

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// 将时间字符串转换为北京时间 (UTC+8)
function convertToBeijingTime(timeStr) {
  if (!timeStr || timeStr === '未知') {
    return '未知';
  }

  try {
    // 输入格式为 "2006-01-02 15:04:05"
    // 先假设这是UTC时间，解析它
    const parts = timeStr.split(' ');
    if (parts.length !== 2) {
      return timeStr;
    }

    const dateParts = parts[0].split('-');
    const timeParts = parts[1].split(':');

    if (dateParts.length !== 3 || timeParts.length !== 3) {
      return timeStr;
    }

    // 创建UTC时间
    const utcDate = new Date(Date.UTC(
      parseInt(dateParts[0]),
      parseInt(dateParts[1]) - 1,
      parseInt(dateParts[2]),
      parseInt(timeParts[0]),
      parseInt(timeParts[1]),
      parseInt(timeParts[2])
    ));

    // 转换为北京时间 (UTC+8)
    const beijingDate = new Date(utcDate.getTime() + 8 * 60 * 60 * 1000);

    // 格式化输出
    const year = beijingDate.getUTCFullYear();
    const month = String(beijingDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(beijingDate.getUTCDate()).padStart(2, '0');
    const hours = String(beijingDate.getUTCHours()).padStart(2, '0');
    const minutes = String(beijingDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(beijingDate.getUTCSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  } catch (error) {
    // 如果解析失败，返回原始字符串
    return timeStr;
  }
}

async function handleRequest(request) {
  try {
    // 解析URL参数，获取用户选择的域名前缀
    const url = new URL(request.url);
    const selectedPrefix = url.searchParams.get('prefix') || '';

    // 获取所有可用的域名配置列表
    const availablePrefixes = await getAvailablePrefixes();

    let ipv4Data, ipv6Data, ipv4time, ipv6time;

    if (selectedPrefix) {
      // 如果选择了特定前缀，只获取该前缀的数据
      const kvPrefix = selectedPrefix + ':';
      ipv6Data = await KV_NAMESPACE.get(kvPrefix + 'ipv6');
      ipv4Data = await KV_NAMESPACE.get(kvPrefix + 'ipv4');
      ipv6time = await KV_NAMESPACE.get(kvPrefix + 'ipv6time');
      ipv4time = await KV_NAMESPACE.get(kvPrefix + 'ipv4time');
    } else {
      // 如果选择默认（无前缀），获取所有数据并合并
      const allData = await getAllData(availablePrefixes);
      ipv4Data = allData.ipv4Data;
      ipv6Data = allData.ipv6Data;
      ipv4time = allData.ipv4time;
      ipv6time = allData.ipv6time;
    }

    // 时间已经是北京时间，直接使用
    const ipv4timeBeijing = ipv4time || '未知';
    const ipv6timeBeijing = ipv6time || '未知';

    const enableIPv4 = !!ipv4Data;
    const enableIPv6 = !!ipv6Data;

    // 生成 HTML 页面
    const html = `
      <!DOCTYPE html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Best ${CDN}</title>
          <script src="https://cdn.tailwindcss.com"></script>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif; background-color: #fafafa; color: #333; }
            .tab-container { display: inline-flex; padding: 4px; background-color: #f3f4f6; border-radius: 9999px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
            .tab-btn { padding: 8px 20px; border-radius: 9999px; font-size: 0.9rem; font-weight: 500; color: #4b5563; background-color: transparent; transition: all 0.2s ease; border: none; cursor: pointer; outline: none; }
            .tab-btn.active { background-color: white; color: #1f2937; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
            .tab-content { width: 100%; }
            .card { background-color: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); overflow: hidden; }
            .info-card { background-color: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); padding: 16px; margin-bottom: 16px; }
            table { width: 100%; border-collapse: collapse; }
            thead { background-color: #f9fafb; border-bottom: 1px solid #e5e7eb; }
            th { padding: 12px 16px; text-align: left; font-weight: 500; font-size: 0.875rem; color: #374151; }
            td { padding: 12px 16px; border-bottom: 1px solid #f3f4f6; font-size: 0.875rem; }
            tr:hover { background-color: #f9fafb; }
            .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 500; }
            .badge-success { background-color: #d1fae5; color: #047857; }
            .badge-error { background-color: #fee2e2; color: #b91c1c; }
            .fade-in { animation: fadeIn 0.3s ease-in-out; }
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
            .footer { margin-top: 20px; text-align: center; color: #9ca3af; font-size: 0.75rem; }
            .time-badge { display: inline-block; padding: 2px 8px; background-color: #f3f4f6; border-radius: 4px; font-size: 0.75rem; color: #6b7280; margin-left: 10px; }
            .icon { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; margin-right: 8px; flex-shrink: 0; }
            .info-title { display: flex; align-items: center; margin-bottom: 8px; font-weight: 500; color: #111827; }
            .code-block { background-color: #f3f4f6; padding: 8px 12px; border-radius: 4px; font-family: monospace; margin-top: 8px; }
          </style>
        </head>
        <body>
          <div class="container">
            <!-- 标题居中 -->
            <div class="text-center mb-6">
              <h1 class="text-xl font-medium text-gray-900">Best ${CDN}</h1>
            </div>

            <!-- 域名选择器 -->
            ${availablePrefixes.length > 0 ? `
              <div class="mb-6">
                <div class="card" style="padding: 16px;">
                  <label for="domain-selector" class="block text-sm font-medium text-gray-700 mb-2">选择域名配置：</label>
                  <select id="domain-selector" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" onchange="handleDomainChange(this.value)">
                    <option value="">默认（无前缀）</option>
                    ${availablePrefixes.map(prefix => `
                      <option value="${prefix}" ${selectedPrefix === prefix ? 'selected' : ''}>${prefix}</option>
                    `).join('')}
                  </select>
                </div>
              </div>
            ` : ''}

            <!-- 使用说明和注意事项 -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <div class="info-card">
                <h2 class="info-title">
                  <span class="icon bg-blue-500 text-white text-xs">使</span>
                  使用说明
                </h2>
                <p class="text-sm text-gray-600">
                  本站维护公共CNAME域名: <span class="code-block">${wildcardDomain ? '*.' : ''}${domain}</span>，支持 ${enableIPv4 ? 'IPv4' : ''} ${enableIPv4 && enableIPv6 ? '与' : ''} ${enableIPv6 ? 'IPv6' : ''}。
                </p>
                ${wildcardDomain ? `
                    <p class="text-sm text-gray-600 mt-2">
                      可自定义 CNAME 地址来避免劫持蜘蛛情况的发生。
                    </p>
                    <p class="text-sm text-gray-600 mt-2">
                      例如: 自定义<span class="code-block">xxxxx.${domain}</span>
                    </p>
                  ` : ''
      }
              </div>
              
              <div class="info-card">
                <h2 class="info-title">
                  <span class="icon bg-yellow-500 text-white text-xs">注</span>
                  注意事项
                </h2>
                <p class="text-sm text-gray-600">
                  提供 ${CDN} 优选节点 IP，每${checkInterval}分钟检测一次，数据波动较大时更新。
                </p>
                <p class="text-sm text-gray-600 mt-2">
                  当检测无变化时，${testInterval}小时强制刷新解析。本站不提供任何CDN服务。
                </p>
                <p class="text-sm text-gray-600 mt-2">
                  严禁用户从事任何违法犯罪活动或被他人网络信息犯罪行为!!!
                </p>
                <p class="text-sm text-gray-600 mt-2">
                  本站使用项目：<a href="https://github.com/Lyxot/CloudflareSpeedTestDNS" class="underline hover:text-blue-700" target="_blank">CloudflareSpeedTestDNS</a>
                </p>
              </div>
            </div>
            
            <!-- 标签切换 + 更新时间（左对齐，时间在右侧） -->
            <div class="flex items-center mb-6">
              <div class="tab-container">
                ${enableIPv4 ? `<button onclick="showTab('ipv4')" class="tab-btn active" id="ipv4-tab">IPv4</button>` : ''}
                ${enableIPv6 ? `<button onclick="showTab('ipv6')" class="tab-btn ${!enableIPv4 ? 'active' : ''}" id="ipv6-tab">IPv6</button>` : ''}
              </div>
              <div class="time-badge" id="update-time-display" data-ipv4-time="${ipv4timeBeijing || '未知'}" data-ipv6-time="${ipv6timeBeijing || '未知'}">
                更新时间: <span id="update-time">${(enableIPv4 && ipv4timeBeijing) || (enableIPv6 && ipv6timeBeijing) || '未知'}</span>
              </div>
            </div>
        
            <!-- 表格卡片 -->
            <div class="card mb-6">
              <!-- IPv4 表格 -->
              ${enableIPv4 ? `
                <div id="ipv4-content" class="tab-content">
                  ${ipv4Data ? `
                    <div class="overflow-x-auto">
                      <table>
                        <thead>
                          <tr>
                            <th>IP 地址</th>
                            <th>CDN</th>
                            <th>数据中心</th>
                            <th>丢包率</th>
                            <th>平均延迟</th>
                            <th>下载速度</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${ipv4Data.split('&').map(row => {
        const cols = row.split(',');
        if (cols.length === 7) {
          return `
                                <tr>
                                  <td class="font-mono">${cols[0]}</td>
                                  <td>
                                    <span class="badge badge-success">${CDN}</span>
                                  </td>
                                  <td>
                                    <span class="badge ${cols[6] === 'N/A' ? 'badge-error' : 'badge-success'}">${cols[6]}</span>
                                  </td>
                                  <td>
                                    <span class="badge ${parseFloat(cols[3]) > 5 ? 'badge-error' : 'badge-success'}">${cols[3]}%</span>
                                  </td>
                                  <td>${cols[4]} <span class="text-gray-400">ms</span></td>
                                  <td>
                                    <span class="${parseFloat(cols[5]) > 10 ? 'text-green-600' : parseFloat(cols[5]) > 5 ? 'text-blue-600' : 'text-gray-600'} font-medium">${cols[5]}</span>
                                    <span class="text-gray-400">MB/s</span>
                                  </td>
                                </tr>
                              `;
        }
        return '';
      }).join('')}
                        </tbody>
                      </table>
                    </div>
                  ` : '<div class="py-16 text-center text-gray-500"><svg class="w-12 h-12 mx-auto text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg><p>暂无 IPv4 数据</p></div>'}
                </div>
              ` : ''}
        
              <!-- IPv6 表格 -->
              ${enableIPv6 ? `
                <div id="ipv6-content" class="tab-content hidden">
                  ${ipv6Data ? `
                    <div class="overflow-x-auto">
                      <table>
                        <thead>
                          <tr>
                            <th>IP 地址</th>
                            <th>CDN</th>
                            <th>数据中心</th>
                            <th>丢包率</th>
                            <th>平均延迟</th>
                            <th>下载速度</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${ipv6Data.split('&').map(row => {
        const cols = row.split(',');
        if (cols.length === 7) {
          return `
                                <tr>
                                  <td class="font-mono">${cols[0]}</td>
                                  <td>
                                    <span class="badge badge-success">${CDN}</span>
                                  </td>
                                  <td>
                                    <span class="badge ${cols[6] === 'N/A' ? 'badge-error' : 'badge-success'}">${cols[6]}</span>
                                  </td>
                                  <td>
                                    <span class="badge ${parseFloat(cols[3]) > 5 ? 'badge-error' : 'badge-success'}">${cols[3]}%</span>
                                  </td>
                                  <td>${cols[4]} <span class="text-gray-400">ms</span></td>
                                  <td>
                                    <span class="${parseFloat(cols[5]) > 10 ? 'text-green-600' : parseFloat(cols[5]) > 5 ? 'text-blue-600' : 'text-gray-600'} font-medium">${cols[5]}</span>
                                    <span class="text-gray-400">MB/s</span>
                                  </td>
                                </tr>
                              `;
        }
        return '';
      }).join('')}
                        </tbody>
                      </table>
                    </div>
                  ` : '<div class="py-16 text-center text-gray-500"><svg class="w-12 h-12 mx-auto text-gray-300 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg><p>暂无 IPv6 数据</p></div>'}
                </div>
              ` : ''}
            </div>
            
            <!-- 页脚 -->
            <div class="footer">
              <p>© ${new Date().getFullYear()} Best ${CDN}</p>
            </div>
          </div>
        
          <!-- 标签切换的 JavaScript -->
          <script>
            // 域名选择器变化处理
            function handleDomainChange(prefix) {
              const url = new URL(window.location.href);
              if (prefix) {
                url.searchParams.set('prefix', prefix);
              } else {
                url.searchParams.delete('prefix');
              }
              window.location.href = url.toString();
            }

            // 初始显示IPv4标签
            document.addEventListener('DOMContentLoaded', function() {
              const enableIPv4 = ${enableIPv4};
              const enableIPv6 = ${enableIPv6};

              if (enableIPv4) {
                showTab('ipv4');
              } else if (enableIPv6) {
                showTab('ipv6');
              }
            });
            
            function showTab(tabName) {
              // 隐藏所有 tab 内容
              document.querySelectorAll('.tab-content').forEach(content => {
                if (content) {
                  content.classList.add('hidden');
                  content.classList.remove('fade-in');
                }
              });
              
              // 显示选中的 tab 内容
              const activeContent = document.getElementById(tabName + '-content');
              if (activeContent) {
                activeContent.classList.remove('hidden');
                
                // 应用淡入动画
                setTimeout(() => {
                  activeContent.classList.add('fade-in');
                }, 10);
              }
    
              // 更新 tab 按钮样式
              document.querySelectorAll('.tab-btn').forEach(btn => {
                if (btn) {
                  btn.classList.remove('active');
                }
              });
              const activeTab = document.getElementById(tabName + '-tab');
              if (activeTab) {
                activeTab.classList.add('active');
              }
              
              // 更新时间显示
              const updateTimeDisplay = document.getElementById('update-time-display');
              if (updateTimeDisplay) {
                const updateTimeEl = document.getElementById('update-time');
                if (updateTimeEl) {
                  const time = tabName === 'ipv4' ? updateTimeDisplay.dataset.ipv4Time : updateTimeDisplay.dataset.ipv6Time;
                  updateTimeEl.textContent = time || '未知';
                }
              }
            }
          </script>
        </body>
      </html>
    `;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
      status: 200
    });
  } catch (error) {
    return new Response(`错误：${error.message}`, { status: 500 });
  }
}

// 获取所有可用的域名前缀列表
async function getAvailablePrefixes() {
  try {
    // 列出KV中所有的key
    const listResult = await KV_NAMESPACE.list();
    const keys = listResult.keys.map(k => k.name);

    // 提取所有唯一的前缀
    const prefixes = new Set();
    keys.forEach(key => {
      // 检查是否包含冒号（说明有前缀）
      if (key.includes(':')) {
        const prefix = key.split(':')[0];
        // 只添加有效的前缀（以ipv4、ipv4time、ipv6、ipv6time结尾的key）
        const suffix = key.split(':')[1];
        if (suffix === 'ipv4' || suffix === 'ipv4time' || suffix === 'ipv6' || suffix === 'ipv6time') {
          prefixes.add(prefix);
        }
      }
    });

    return Array.from(prefixes).sort();
  } catch (error) {
    console.error('获取前缀列表失败:', error);
    return [];
  }
}

// 获取所有域名配置的数据并合并
async function getAllData(prefixes) {
  try {
    let allIPv4Data = [];
    let allIPv6Data = [];
    let latestIPv4Time = null;
    let latestIPv6Time = null;

    // 首先获取无前缀的数据
    const defaultIPv4 = await KV_NAMESPACE.get('ipv4');
    const defaultIPv6 = await KV_NAMESPACE.get('ipv6');
    const defaultIPv4Time = await KV_NAMESPACE.get('ipv4time');
    const defaultIPv6Time = await KV_NAMESPACE.get('ipv6time');

    if (defaultIPv4) {
      allIPv4Data.push(defaultIPv4);
      latestIPv4Time = defaultIPv4Time;
    }
    if (defaultIPv6) {
      allIPv6Data.push(defaultIPv6);
      latestIPv6Time = defaultIPv6Time;
    }

    // 遍历所有前缀，获取数据
    for (const prefix of prefixes) {
      const kvPrefix = prefix + ':';

      const ipv4 = await KV_NAMESPACE.get(kvPrefix + 'ipv4');
      const ipv6 = await KV_NAMESPACE.get(kvPrefix + 'ipv6');
      const ipv4time = await KV_NAMESPACE.get(kvPrefix + 'ipv4time');
      const ipv6time = await KV_NAMESPACE.get(kvPrefix + 'ipv6time');

      if (ipv4) {
        allIPv4Data.push(ipv4);
        // 更新最新时间
        if (!latestIPv4Time || (ipv4time && ipv4time > latestIPv4Time)) {
          latestIPv4Time = ipv4time;
        }
      }

      if (ipv6) {
        allIPv6Data.push(ipv6);
        // 更新最新时间
        if (!latestIPv6Time || (ipv6time && ipv6time > latestIPv6Time)) {
          latestIPv6Time = ipv6time;
        }
      }
    }

    // 合并所有数据，用&连接
    const ipv4Data = allIPv4Data.length > 0 ? allIPv4Data.join('&') : null;
    const ipv6Data = allIPv6Data.length > 0 ? allIPv6Data.join('&') : null;

    return {
      ipv4Data,
      ipv6Data,
      ipv4time: latestIPv4Time,
      ipv6time: latestIPv6Time
    };
  } catch (error) {
    console.error('获取所有数据失败:', error);
    return {
      ipv4Data: null,
      ipv6Data: null,
      ipv4time: null,
      ipv6time: null
    };
  }
}