# CFSpeedSync

[![Go Version](https://img.shields.io/github/go-mod/go-version/Lost-su/CFSpeedSync?style=flat-square&label=Go&color=00ADD8&logo=go)](https://github.com/Lost-su/CFSpeedSync)
[![Release](https://img.shields.io/github/v/release/Lost-su/CFSpeedSync?style=flat-square&label=Release&color=2F81F7&logo=github)](https://github.com/Lost-su/CFSpeedSync/releases)
[![License](https://img.shields.io/github/license/Lost-su/CFSpeedSync?style=flat-square&label=License&color=3FB950&logo=opensourceinitiative)](LICENSE)

> Cloudflare 节点测速、优选 IP、DNS/KV 同步与 Worker 可视化工具。

CFSpeedSync 基于 [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 开发。本地程序负责测速和同步，Cloudflare Worker 负责从 KV 读取数据并展示页面。

**快速导航：** [五分钟部署](#quick-deploy) · [安装运行](#install) · [核心配置](#configuration) · [KV 与 Worker](#worker) · [DNS 同步](#dns) · [优良库与定时监控](#automation) · [故障排查](#troubleshooting)

---

<a id="quick-deploy"></a>

## 1. 五分钟部署：KV + Worker

这是最短的完整使用路径，适合第一次部署：

~~~text
本地运行 CFSpeedSync
        ↓
测速结果写入 Cloudflare KV
        ↓
Worker 读取 KV
        ↓
浏览器查看测速结果
~~~

### 1.1 创建 Cloudflare KV

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)。
2. 进入 **Workers & Pages -> KV**，部分新版控制台位于 **Storage & Databases -> KV**。
3. 创建一个 Namespace，例如 <code>CFSpeedSync</code>。
4. 记录该 KV 的 **Namespace ID**。
5. 在 Cloudflare Account 首页记录 **Account ID**。

### 1.2 创建 KV API Token

1. 进入 **My Profile -> API Tokens -> Create Token**。
2. 选择 **Create Custom Token**。
3. 添加权限：**Account -> Workers KV Storage -> Edit**。
4. 在 Account Resources 中选择自己的 Cloudflare 账号。
5. 创建并保存 Token。该 Token 只会完整显示一次。

> 基础展示只需要 KV 权限，不需要 DNS 编辑权限。

### 1.3 配置本地程序

解压 [Releases](https://github.com/Lost-su/CFSpeedSync/releases) 中下载的程序，将 <code>config.example.toml</code> 复制为 <code>config.toml</code>，然后修改其中的 <code>[cfkv]</code>：

~~~toml
[cfkv]
enable = true
api_token = "你的 KV API Token"
account_id = "你的 Account ID"
namespace_id = "你的 KV Namespace ID"

# 可选：用于区分不同域名或线路
domain = "example.com"
subdomain = "cf"
~~~

如果只需要一组默认数据，可以将 <code>domain</code> 和 <code>subdomain</code> 都设置为空字符串：

~~~toml
domain = ""
subdomain = ""
~~~

首次使用时，其他远程功能保持关闭即可：

~~~toml
[alidns]
enable = false

[dnspod]
enable = false

[cloudflare]
enable = false

[excellent_pool]
enable = false

[cron]
enable = false
~~~

### 1.4 运行一次测速

| 系统 | 命令 |
| --- | --- |
| Windows x64 | <code>.\cfstd-windows-x86_64.exe -c .\config.toml</code> |
| Linux x64 | <code>chmod +x ./cfstd-linux-x86_64</code><br><code>./cfstd-linux-x86_64 -c ./config.toml</code> |
| macOS Apple Silicon | <code>chmod +x ./cfstd-macos-aarch64</code><br><code>./cfstd-macos-aarch64 -c ./config.toml</code> |

看到“同步到 Cloudflare KV 成功”后，打开 Cloudflare KV 检查数据。根据输入的 IP 类型，通常会出现：

~~~text
ipv4
ipv4time
ipv6
ipv6time
~~~

配置了域名前缀时，key 会变成：

~~~text
cf.example.com:ipv4
cf.example.com:ipv4time
cf.example.com:ipv6
cf.example.com:ipv6time
~~~

### 1.5 部署 Worker 页面

1. 在 Cloudflare Dashboard 进入 **Workers & Pages**。
2. 创建一个 Worker，使用 **Modules / ES Modules** 模式，并打开在线代码编辑器。
3. 删除默认代码，复制 [worker_atlas.js](worker_atlas.js) 的全部内容。
4. 保存并部署。
5. 打开 Worker 的 **Settings -> Bindings**。
6. 添加 **KV Namespace Binding**：

   - Variable name：<code>KV_NAMESPACE</code>
   - KV namespace：选择前面创建的 Namespace

7. 保存并重新部署 Worker。
8. 访问 Cloudflare 分配的 <code>workers.dev</code> 域名。

> 只查看测速结果时，Worker 仅需要 <code>KV_NAMESPACE</code>。不需要配置 <code>ADMIN_TOKEN</code>、<code>CF_API_TOKEN</code> 或 <code>CF_ZONE_ID</code>。

### 1.6 快速验收

| 检查地址 | 正常结果 |
| --- | --- |
| Worker 首页 | 显示 IPv4/IPv6、速度、延迟和更新时间 |
| <code>/healthz</code> | 返回服务健康信息 |
| <code>/api/nodes</code> | 返回 JSON 格式的节点数据 |

如果页面提示 <code>Missing KV binding: KV_NAMESPACE</code>，说明 KV 绑定名称错误，或者绑定后没有重新部署。如果页面可以打开但没有数据，请确认本地程序和 Worker 使用的是同一个 KV Namespace。

---

<a id="overview"></a>

## 2. 项目说明

### 2.1 主要功能

| 分类 | 功能 |
| --- | --- |
| 测速 | TCPing、HTTPing、下载测速、延迟和丢包筛选 |
| 输入 | 单个 IP、CIDR、本地文件、远程 URL、内联 IP |
| 协议 | IPv4、IPv6，以及 IPv4/IPv6 分离测速 |
| 输出 | 终端结果、CSV 文件、日志文件、Cloudflare KV |
| DNS | 阿里云 DNS、DNSPod、Cloudflare DNS |
| 自动化 | 优良库复用、异常检测、定时刷新 |
| Web | 多线路切换、搜索、排序、JSON API、健康检查 |
| 平台 | Windows、Linux、macOS、ARM、MIPS、RISC-V、LoongArch |

### 2.2 工作流程

~~~text
读取 IP/CIDR
    ↓
延迟测速（TCP 或 HTTP）
    ↓
按延迟和丢包率过滤
    ↓
下载测速（可关闭）
    ↓
按速度排序并输出 CSV
    ↓
同步 DNS、KV 和优良库（按配置启用）
~~~

程序写入 KV 的时间统一使用北京时间（UTC+8）。

---

<a id="install"></a>

## 3. 安装与运行

### 3.1 下载发行版

1. 打开 [Releases](https://github.com/Lost-su/CFSpeedSync/releases)。
2. 下载与系统和架构对应的压缩包。
3. 解压后，将 <code>config.example.toml</code> 复制为 <code>config.toml</code>。
4. 修改配置并运行程序。

常见文件名：

| 系统 | 架构 | 文件名 |
| --- | --- | --- |
| Windows | x64 | <code>cfstd-windows-x86_64.exe</code> |
| Windows | ARM64 | <code>cfstd-windows-arm64.exe</code> |
| Linux | x64 | <code>cfstd-linux-x86_64</code> |
| Linux | ARM64 | <code>cfstd-linux-aarch64</code> |
| macOS | Intel | <code>cfstd-macos-x86_64</code> |
| macOS | Apple Silicon | <code>cfstd-macos-aarch64</code> |

如果当前目录存在 <code>config.toml</code>，可以省略 <code>-c</code>。没有配置文件时程序会使用内置默认值，但仍需要默认的 <code>ip.txt</code>。

### 3.2 从源码运行

要求 Go 1.24 或更高版本：

~~~bash
git clone https://github.com/Lost-su/CFSpeedSync.git
cd CFSpeedSync
cp conf/config.example.toml config.toml
go run . -c config.toml
~~~

Windows PowerShell：

~~~powershell
git clone https://github.com/Lost-su/CFSpeedSync.git
Set-Location ./CFSpeedSync
Copy-Item ./conf/config.example.toml ./config.toml
go run . -c ./config.toml
~~~

### 3.3 命令行参数

| 参数 | 说明 |
| --- | --- |
| <code>-c &lt;path&gt;</code> | 指定 TOML 配置文件 |
| <code>-debug</code> | 输出更多调试日志 |
| <code>-pgo</code> | 开启 CPU profile，生成 <code>cpu.pprof</code> |
| <code>-v</code> | 打印版本、构建信息和 Go 版本 |
| <code>-u</code> | 检查 GitHub Releases 是否有新版本 |
| <code>-h</code> | 显示帮助 |

~~~bash
./cfstd -c config.toml -debug
./cfstd -v
./cfstd -u
~~~

---

<a id="configuration"></a>

## 4. 核心配置

完整示例见 [conf/config.example.toml](conf/config.example.toml)，环境变量列表见 [conf/env.md](conf/env.md)。

配置加载顺序：

1. 读取 <code>-c</code> 指定的文件；未指定时读取当前目录的 <code>config.toml</code>。
2. 使用 <code>CFSTD_*</code> 环境变量覆盖 TOML 配置。
3. 应用命令行参数，例如 <code>-debug</code>。

### 4.1 IP 数据来源

#### 本地文件或远程 URL

~~~toml
ip_file = "ip.txt"

# 也可以直接使用 URL
# ip_file = "https://example.com/ipv4.txt"
~~~

输入文件每行填写一个 IP 或 CIDR：

~~~text
104.16.0.0/13
172.64.0.0/13
1.1.1.1
~~~

默认情况下，每个 IPv4 <code>/24</code> 网段随机抽取地址；设置 <code>test_all = true</code> 后才会遍历网段地址。IPv6 网段会生成随机地址，单个 <code>/128</code> 地址直接测试。

#### 直接填写 IP

~~~toml
ip_text = "1.1.1.1,1.0.0.1,2606:4700:4700::1111"
~~~

多个地址或网段使用英文逗号分隔。<code>ip_text</code> 非空时优先于文件配置。

#### IPv4/IPv6 分离测速

~~~toml
ipv4_file = "ip.txt"
ipv6_file = "ipv6.txt"
~~~

| 配置方式 | 行为 |
| --- | --- |
| 只填写 <code>ipv4_file</code> | 只测速 IPv4 |
| 只填写 <code>ipv6_file</code> | 只测速 IPv6 |
| 两者都填写 | 分别测速，输出 <code>result_ipv4.csv</code> 和 <code>result_ipv6.csv</code> |
| 填写任意分离文件 | <code>ip_file</code> 被忽略 |
| 填写 <code>ip_text</code> | 优先使用内联数据，不读取文件 |

### 4.2 延迟测速

~~~toml
routines = 200
ping_times = 4
tcp_port = 443
max_delay = 9999
min_delay = 0
max_loss_rate = 1.0

httping = false
httping_code = 0
cfcolo = ""
~~~

| 配置 | 单位/范围 | 说明 |
| --- | --- | --- |
| <code>routines</code> | 线程数 | 延迟测速并发数 |
| <code>ping_times</code> | 次 | 每个 IP 的探测次数 |
| <code>tcp_port</code> | 端口 | 默认 443 |
| <code>min_delay</code> | ms | 平均延迟下限 |
| <code>max_delay</code> | ms | 平均延迟上限 |
| <code>max_loss_rate</code> | 0.0~1.0 | 允许的最大丢包率 |
| <code>httping</code> | true/false | true 使用 HTTPing，false 使用 TCPing |
| <code>httping_code</code> | HTTP 状态码 | 0 表示接受 200、301、302 |
| <code>cfcolo</code> | 地区码 | 例如 HKG,NRT,SJC |

### 4.3 下载测速

~~~toml
test_count = 10
download_time = 10
url = "https://cf.xiu2.xyz/url"
min_speed = 0.0
disable_download = false
~~~

程序先完成延迟和丢包筛选，再对候选 IP 下载测速：

- <code>test_count</code>：最终保留的下载测速结果数量。
- <code>download_time</code>：单个 IP 的下载测速时间，单位为秒。
- <code>min_speed</code>：最低下载速度，单位为 MB/s。
- <code>disable_download = true</code>：跳过下载测速，只保留延迟结果。

### 4.4 输出与重试

~~~toml
print_num = 10
dns_num = 1
min_num = 0
max_attempts = 10
output = "result.csv"
log_file = ""
~~~

| 配置 | 说明 |
| --- | --- |
| <code>print_num</code> | 终端显示数量；0 表示不显示 |
| <code>dns_num</code> | 同步到 DNS 的结果数量，与显示数量独立 |
| <code>min_num</code> | 少于此数量时判定本轮结果不足；0 表示不限制 |
| <code>max_attempts</code> | 结果不足时的最大尝试次数 |
| <code>output</code> | CSV 输出路径；空字符串表示不输出 |
| <code>log_file</code> | 日志文件路径；空字符串表示不写文件 |

CSV 包含 IP 地址、发包数、收包数、丢包率、平均延迟、下载速度和地区码。

---

<a id="worker"></a>

## 5. Cloudflare KV 与 Worker

### 5.1 KV key 结构

配置域名和子域名：

~~~toml
[cfkv]
domain = "example.com"
subdomain = "cf"
~~~

程序会写入：

~~~text
cf.example.com:ipv4
cf.example.com:ipv4time
cf.example.com:ipv6
cf.example.com:ipv6time
cf.example.com:excellent_ipv4
cf.example.com:excellent_ipv6
~~~

不同的 <code>domain/subdomain</code> 会形成不同线路。Worker 会自动发现这些前缀，并在页面中提供线路切换。

### 5.2 Worker 版本

| 文件 | 语法 | 用途 |
| --- | --- | --- |
| [worker_atlas.js](worker_atlas.js) | Modules | 推荐，功能最完整，支持管理操作 |
| [worker_modern.js](worker_modern.js) | Modules | 现代卡片式页面 |
| [worker_new.js](worker_new.js) | Service Worker | 简洁深色页面 |
| [worker.js](worker.js) | Service Worker | 经典表格页面 |

Modules 版本需要将 KV 绑定为 <code>KV_NAMESPACE</code>。Service Worker 版本还需要按文件顶部说明配置页面参数。

### 5.3 Atlas 管理功能

基础展示不需要下面的变量。只有需要在页面中修改 Cloudflare DNS，或者手动把节点加入优良库时才配置：

| 变量 | 类型 | 说明 |
| --- | --- | --- |
| <code>ADMIN_TOKEN</code> | Secret | 页面管理操作的管理员令牌 |
| <code>CF_API_TOKEN</code> | Secret | 具有目标 Zone DNS 编辑权限的 Token |
| <code>CF_ZONE_ID</code> | Variable | 默认 Cloudflare Zone ID |
| <code>EXCELLENT_POOL_MAX_SIZE</code> | Variable | 手动加入优良库的最大条数，默认 100 |

不要将 Token 直接写入 Worker 源码。

---

<a id="dns"></a>

## 6. DNS 自动同步

程序会将排名靠前的 <code>dns_num</code> 个地址同步到已启用的 DNS 服务。IPv4 使用 A 记录，IPv6 使用 AAAA 记录。

<details>
<summary><strong>阿里云 DNS 配置</strong></summary>

~~~toml
[alidns]
enable = true
accesskey_id = "你的 AccessKey ID"
accesskey_secret = "你的 AccessKey Secret"
domain = "example.com"
subdomain = "cf"
ttl = 600
~~~

最终记录名为 <code>cf.example.com</code>。建议使用只允许管理目标域名 DNS 的 RAM 子用户。

</details>

<details>
<summary><strong>DNSPod 配置</strong></summary>

~~~toml
[dnspod]
enable = true
secret_id = "你的 SecretId"
secret_key = "你的 SecretKey"
domain = "example.com"
subdomain = "cf"
ttl = 600
~~~

请确认域名已托管在 DNSPod，并使用最小权限的腾讯云 API 密钥。

</details>

<details>
<summary><strong>Cloudflare DNS 配置</strong></summary>

~~~toml
[cloudflare]
enable = true
api_token = "你的 Cloudflare API Token"
zone_id = "目标域名的 Zone ID"
domain = "example.com"
subdomain = "cf"
proxied = false
ttl = 1
~~~

Token 需要目标 Zone 的 DNS 编辑权限。<code>ttl = 1</code> 表示自动 TTL。优选 IP 通常建议设置 <code>proxied = false</code>。

</details>

---

<a id="automation"></a>

## 7. 优良库与定时监控

### 7.1 优良库

优良库依赖 <code>[cfkv]</code>。程序会把符合标准的节点保存到 KV，后续测速时优先复用：

~~~toml
[excellent_pool]
enable = true
use_mode = "priority"
min_speed = 20.0
max_delay = 150
max_loss_rate = 0.0
max_size = 100
auto_remove_slow = true
~~~

| 模式 | 行为 |
| --- | --- |
| <code>priority</code> | 优先测速优良库，结果不足时使用普通 IP 段补充 |
| <code>only</code> | 只测速优良库，不使用普通 IP 段 |
| <code>mixed</code> | 优良库和普通 IP 段合并测速 |

节点必须同时满足速度、延迟和丢包率条件。开启 <code>auto_remove_slow</code> 后，不再达标的旧节点会被移除。

### 7.2 定时监控

~~~toml
[cron]
enable = true
latency_threshold = 200
loss_rate_threshold = 0.1
check_interval = 30
test_interval = 24
~~~

启用后：

1. 程序启动时执行一次完整测速。
2. 每 <code>check_interval</code> 分钟检查当前 IP。
3. 延迟或丢包超过阈值时立即重新测速并同步。
4. 每 <code>test_interval</code> 小时无条件完整刷新一次。

Cron 模式是前台常驻进程，适合配合 systemd、Docker 或 Windows 任务计划使用。

---

## 8. 环境变量与源码编译

### 8.1 环境变量

TOML 字段可以转换为 <code>CFSTD_</code> 前缀的大写蛇形环境变量：

~~~bash
CFSTD_TEST_COUNT=20
CFSTD_MAX_DELAY=180
CFSTD_CFKV_ENABLE=true
CFSTD_CFKV_API_TOKEN=...
CFSTD_CRON_ENABLE=true
~~~

嵌套字段使用下划线连接：

| TOML 配置 | 环境变量 |
| --- | --- |
| <code>cloudflare.api_token</code> | <code>CFSTD_CLOUDFLARE_API_TOKEN</code> |
| <code>cfkv.namespace_id</code> | <code>CFSTD_CFKV_NAMESPACE_ID</code> |
| <code>excellent_pool.max_size</code> | <code>CFSTD_EXCELLENT_POOL_MAX_SIZE</code> |
| <code>cron.check_interval</code> | <code>CFSTD_CRON_CHECK_INTERVAL</code> |

完整列表见 [conf/env.md](conf/env.md)。

### 8.2 编译当前平台

~~~bash
go build -ldflags "-s -w" -o cfstd .
~~~

### 8.3 Windows 编译全部平台

~~~powershell
powershell -ExecutionPolicy Bypass -File ./build.ps1
~~~

产物位于 <code>dist/</code>，构建脚本使用 <code>CGO_ENABLED=0</code>。

---

<a id="troubleshooting"></a>

## 9. 故障排查

| 问题 | 检查方法 |
| --- | --- |
| 找不到配置文件 | 检查当前工作目录和 <code>-c</code> 路径 |
| 找不到 IP 文件 | 检查 <code>ip_file</code>、<code>ipv4_file</code>、<code>ipv6_file</code> 的相对路径 |
| 测速结果为零 | 放宽 <code>max_delay</code>、<code>max_loss_rate</code> 和 <code>min_speed</code> |
| IPv6 没有结果 | 确认运行环境具备可用的公网 IPv6 出口 |
| KV 没有数据 | 检查 Token 权限、Account ID、Namespace ID 和运行日志 |
| Worker 页面为空 | 确认 Worker 和本地程序使用同一个 KV Namespace |
| Missing KV binding | KV 绑定名称必须是 <code>KV_NAMESPACE</code>，绑定后重新部署 |
| DNS 没有更新 | 检查服务是否启用、凭证权限、域名、Zone ID 和 <code>dns_num</code> |
| 所有 IP 延迟相同 | 关闭透明代理、VPN 或路由器代理后重新测速 |

调试运行：

~~~bash
./cfstd -c config.toml -debug
~~~

Worker 接口排查：

~~~text
https://你的-worker.workers.dev/healthz
https://你的-worker.workers.dev/api/nodes
~~~

---

## 10. 安全建议

- 不要将 Cloudflare、阿里云或 DNSPod 密钥提交到 Git。
- API Token 应使用最小权限，并限制到实际使用的 Account 或 Zone。
- Worker 的 <code>ADMIN_TOKEN</code> 和 <code>CF_API_TOKEN</code> 应配置为 Secret。
- 不要把任何 API Token 直接写入 Worker JavaScript 文件。
- 公开日志前确认其中不包含敏感信息。

---

## 11. 项目文件

| 文件 | 说明 |
| --- | --- |
| [conf/config.example.toml](conf/config.example.toml) | 完整 TOML 配置示例 |
| [conf/env.md](conf/env.md) | 环境变量列表 |
| [ip.txt](ip.txt) | 默认 IPv4/IP 段输入文件 |
| [ipv6.txt](ipv6.txt) | IPv6 输入文件 |
| [worker_atlas.js](worker_atlas.js) | 推荐的 Worker 页面 |
| [worker_modern.js](worker_modern.js) | 现代版 Worker 页面 |
| [docker-compose.yml](docker-compose.yml) | Docker Compose 示例 |
| [build.ps1](build.ps1) | 多平台交叉编译脚本 |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | 发布说明 |

## 致谢

- [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest)：核心测速思路和实现基础。
- [IonRh/Cloudflare-BestIP](https://github.com/IonRh/Cloudflare-BestIP)：项目功能和界面设计参考。

## 开源协议

本项目使用 [GPL-3.0](LICENSE) 开源协议。
