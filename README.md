# CFSpeedSync

[![Go Version](https://img.shields.io/github/go-mod/go-version/Lyxot/CloudflareSpeedTestDNS?style=flat-square&label=Go&color=00ADD8&logo=go)](https://github.com/Lyxot/CloudflareSpeedTestDNS)
[![Release](https://img.shields.io/github/v/release/Lyxot/CloudflareSpeedTestDNS?style=flat-square&label=Release&color=00ADD8&logo=github)](https://github.com/Lyxot/CloudflareSpeedTestDNS/releases/latest)
[![License](https://img.shields.io/github/license/Lyxot/CloudflareSpeedTestDNS?style=flat-square&label=License&color=00ADD8&logo=github)](LICENSE)

基于 [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 的 CDN 节点测速、优选 IP 和 DNS 同步工具。项目使用 Go 编写，支持 TCPing、HTTPing、下载测速、IPv4/IPv6 分离测速、Cloudflare Workers KV、阿里云 DNS、DNSPod（腾讯云 DNSPod）和 Cloudflare DNS。

测速结果可以保存为 CSV，也可以写入 Cloudflare KV，再通过仓库内的 Worker 页面展示。启用 Cron 后，程序会定期检查当前 IP；延迟或丢包超过阈值时自动重新测速并更新 DNS/KV。

## 功能概览

- TCP 延迟测速或 HTTP 延迟测速
- 下载速度测速，并按最低速度筛选
- 支持单个 IP、CIDR 网段、本地文件、远程 URL 和内联 IP 列表
- IPv4、IPv6 分开测速，也可以同时测速
- 延迟、丢包、测速线程、端口、测速数量等参数可配置
- 自动同步到阿里云 DNS、DNSPod 和 Cloudflare DNS
- 将结果写入 Cloudflare Workers KV，支持多个域名/线路前缀
- Cloudflare KV 优良库：复用历史优质 IP，减少每次全量扫描
- Cron 监控：周期性检查当前 IP，异常时自动刷新
- worker_atlas.js、worker_modern.js 等 Web 展示页面
- Windows、Linux、macOS 以及多种 ARM、MIPS、RISC-V、LoongArch 架构
- 所有程序时间统一使用北京时间（UTC+8）

## 工作流程

~~~text
读取 IP/CIDR
    ↓
延迟测速（TCP 或 HTTP）
    ↓
按延迟、丢包率过滤
    ↓
下载测速（可关闭）
    ↓
按下载速度排序并输出 CSV
    ↓
同步 DNS、Cloudflare KV 和优良库（按配置启用）
~~~

## 快速开始

### 下载发行版

1. 从 [Releases](https://github.com/Lyxot/CloudflareSpeedTestDNS/releases/latest) 下载对应系统和架构的压缩包。
2. 解压到单独目录。
3. 将 conf/config.example.toml 复制为同目录下的 config.toml。
4. 按需修改配置，并确认输入文件路径正确。
5. 执行程序。

Windows PowerShell：

~~~powershell
Copy-Item ./conf/config.example.toml ./config.toml
./cfstd-windows-x86_64.exe -c ./config.toml
~~~

Linux/macOS：

~~~bash
cp conf/config.example.toml config.toml
chmod +x ./cfstd-linux-x86_64
./cfstd-linux-x86_64 -c ./config.toml
~~~

文件名需要按实际下载的架构替换，例如 cfstd-macos-aarch64 或 cfstd-linux-armv7。如果当前目录存在 config.toml，可以省略 -c。没有配置文件时程序会使用内置默认值，但仍需要默认的 ip.txt。

### 从源码运行

要求 Go 1.24 或更高版本：

~~~bash
git clone https://github.com/Lyxot/CloudflareSpeedTestDNS.git
cd CloudflareSpeedTestDNS
cp conf/config.example.toml config.toml
go run . -c config.toml
~~~

Windows PowerShell：

~~~powershell
git clone https://github.com/Lyxot/CloudflareSpeedTestDNS.git
Set-Location ./CloudflareSpeedTestDNS
Copy-Item ./conf/config.example.toml ./config.toml
go run . -c ./config.toml
~~~

首次运行建议保持所有 DNS、KV 和 Cron 配置为 enable = false，确认测速结果正常后再逐项启用远程同步。

## 命令行参数

~~~text
-c <path>       指定 TOML 配置文件；不指定时读取当前目录的 config.toml
-debug          输出更多调试日志
-pgo            开启 CPU profile，生成 cpu.pprof
-v              打印版本、构建信息和 Go 版本
-u              检查 GitHub Releases 是否有新版本
-h              显示帮助
~~~

示例：

~~~bash
./cfstd -c config.toml -debug
./cfstd -v
./cfstd -u
~~~

## 配置教程

完整示例见 [conf/config.example.toml](conf/config.example.toml)，环境变量说明见 [conf/env.md](conf/env.md)。配置加载顺序是：

1. 读取 -c 指定的文件；未指定时尝试读取 config.toml。
2. 读取 CFSTD_* 环境变量，并覆盖 TOML 中的同名配置。
3. 应用程序默认值和运行参数。

### 输入 IP

#### 文件或 URL

~~~toml
ip_file = "ip.txt"
# 也可以使用远程 URL
# ip_file = "https://example.com/ipv4.txt"
~~~

每行可以写一个 IP 或 CIDR：

~~~text
104.16.0.0/13
172.64.0.0/13
1.1.1.1
~~~

程序自动识别本地路径和 http/https URL。默认情况下，每个 IPv4 /24 网段随机抽取地址；设置 test_all = true 才会遍历网段中的地址。IPv6 网段生成随机地址，单个 /128 地址直接测试。

#### 内联 IP

~~~toml
ip_text = "1.1.1.1,1.0.0.1,2606:4700:4700::1111"
~~~

ip_text 非空时优先于文件配置，多个地址或网段使用英文逗号分隔。

#### IPv4/IPv6 分离

~~~toml
ipv4_file = "ip.txt"
ipv6_file = "ipv6.txt"
~~~

- 只填写 ipv4_file：只测速 IPv4。
- 只填写 ipv6_file：只测速 IPv6。
- 同时填写两者：分别测速，并输出 result_ipv4.csv、result_ipv6.csv。
- 填写任意一个 ipv4_file/ipv6_file 后，ip_file 会被忽略。
- ip_text 优先级最高；设置后不会读取文件。

### 延迟测速

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

routines 是并发线程数，ping_times 是每个 IP 的探测次数，延迟单位为毫秒，丢包率范围为 0.0~1.0。httping = true 时使用 HTTPing；httping_code = 0 表示接受 200、301、302。cfcolo 可以填写 HKG,NRT,SJC 这类 Cloudflare 机场/地区码。

### 下载测速

~~~toml
test_count = 10
download_time = 10
url = "https://cf.xiu2.xyz/url"
min_speed = 0.0
disable_download = false
~~~

程序先进行延迟/丢包筛选，再对候选 IP 下载测速。test_count 是最终保留数量；设置 min_speed 后，程序会继续尝试候选 IP，直到达到数量或候选用尽。disable_download = true 时只保留延迟测速结果。

### 输出和重试

~~~toml
print_num = 10
dns_num = 1
min_num = 0
max_attempts = 10
output = "result.csv"
log_file = ""
~~~

print_num = 0 表示不在终端显示结果；dns_num 独立于显示数量；min_num > 0 时，符合条件的结果少于该数量会触发重试；output 为空字符串时不生成 CSV；log_file 非空时追加写入日志。

CSV 列为：IP 地址、已发送、已接收、丢包率、平均延迟、下载速度(MB/s)、地区码。结果按下载速度从高到低排序。

## DNS 自动同步

程序会把本轮结果中排名靠前的 dns_num 个地址同步到已启用的 DNS 服务。IPv4 使用 A 记录，IPv6 使用 AAAA 记录；同一记录名下不在目标列表中的旧记录会被清理。

### 阿里云 DNS

~~~toml
[alidns]
enable = true
accesskey_id = "你的 AccessKey ID"
accesskey_secret = "你的 AccessKey Secret"
domain = "example.com"
subdomain = "cf"
ttl = 600
~~~

最终记录名为 cf.example.com。建议在 RAM 中创建只管理目标域名 DNS 的子用户和 AccessKey，不要使用主账号密钥。

### DNSPod（腾讯云）

~~~toml
[dnspod]
enable = true
secret_id = "你的 SecretId"
secret_key = "你的 SecretKey"
domain = "example.com"
subdomain = "cf"
ttl = 600
~~~

请在腾讯云控制台创建最小权限的 API 密钥，并确认域名已经托管在 DNSPod。

### Cloudflare DNS

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

Token 至少需要目标 Zone 的 DNS 编辑权限。ttl = 1 表示自动 TTL。优选 IP 通常建议 proxied = false，避免将边缘 IP 再次代理。

## Cloudflare Workers KV 和 Worker 页面

KV 用来保存测速结果，Worker 用来读取并展示结果。启用 KV 至少需要：

~~~toml
[cfkv]
enable = true
api_token = "具有 Workers KV 写入权限的 Token"
account_id = "Cloudflare Account ID"
namespace_id = "KV Namespace ID"
domain = "example.com"
subdomain = "cf"
~~~

当 domain 和 subdomain 都填写时，KV key 使用以下前缀：

~~~text
cf.example.com:ipv4
cf.example.com:ipv4time
cf.example.com:ipv6
cf.example.com:ipv6time
cf.example.com:excellent_ipv4
cf.example.com:excellent_ipv6
~~~

不填写域名时使用无前缀 key：ipv4、ipv4time、ipv6、ipv6time。多个站点使用不同的 domain/subdomain 后，Worker 会自动发现线路并提供切换。

### 创建 KV

1. 在 Cloudflare Dashboard 的 Workers & Pages -> KV 创建 Namespace，记录 Namespace ID。
2. 在 My Profile -> API Tokens 创建 Token，授予目标 Account 的 Workers KV 读写权限。
3. 将 Account ID、Namespace ID 和 Token 写入 config.toml。
4. 运行一次测速，确认 KV 中出现 ipv4 或带前缀的 key。

### 部署 Atlas Worker

worker_atlas.js 使用 Modules 语法，支持 IPv4/IPv6 切换、线路切换、最新结果和优良库切换、搜索排序、复制 IP、/api/nodes JSON 接口、/healthz 健康检查，以及可选的管理员 DNS/优良库操作。

1. 创建 Cloudflare Worker，选择 Modules 模式。
2. 复制 [worker_atlas.js](worker_atlas.js) 的完整内容并部署。
3. 在 Settings -> Variables and Secrets -> KV bindings 中绑定 KV，变量名必须为 KV_NAMESPACE。
4. 如需页面管理按钮，增加以下变量或 Secrets：

   - ADMIN_TOKEN：页面管理操作使用的长随机令牌。
   - CF_API_TOKEN：修改 Cloudflare DNS 的 Token。
   - CF_ZONE_ID：默认 Zone ID。
   - DNS_RECORDS：可选的线路到 DNS 记录映射 JSON。
   - EXCELLENT_POOL_MAX_SIZE：可选，手动加入优良库的最大条数，默认 100。

5. 访问 Worker 域名、/healthz 和 /api/nodes 验证部署。

DNS_RECORDS 示例：

~~~json
{
  "cf.example.com": {
    "record": "cf.example.com",
    "zone_id": "your_zone_id",
    "proxied": false,
    "ttl": 60
  },
  "default": {
    "record": "cf.example.com",
    "zone_id": "your_zone_id"
  }
}
~~~

key 必须对应 KV key 中冒号前的线路前缀，例如 cf.example.com:ipv4 对应 cf.example.com；没有前缀时使用 default。不要把 Token 写进 Worker 源码，应该配置为 Secret。

### Worker 版本

| 文件 | 语法 | 说明 |
| --- | --- | --- |
| [worker_atlas.js](worker_atlas.js) | Modules | 推荐，功能最完整，带管理操作 |
| [worker_modern.js](worker_modern.js) | Modules | 现代卡片式页面 |
| [worker_new.js](worker_new.js) | Service Worker | 简洁深色页面 |
| [worker.js](worker.js) | Service Worker | 经典表格页面 |

Modules 版本都需要绑定名为 KV_NAMESPACE 的 KV。Service Worker 版本还要按文件顶部说明配置域名和检查间隔。

## 优良库

优良库依赖 cfkv，将符合条件的测速结果写入 KV，下次测速时复用：

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

- priority：优先测速优良库，结果不足时用普通 IP 段补充。
- only：只测速优良库，不补充普通 IP。
- mixed：优良库和普通 IP 段合并测速，优良库 IP 排在前面。

入库必须同时满足速度、延迟和丢包率。auto_remove_slow = true 时，不再达标的旧 IP 会被移除；IPv4 和 IPv6 优良库分别计数。

## 定时监控

~~~toml
[cron]
enable = true
latency_threshold = 200
loss_rate_threshold = 0.1
check_interval = 30
test_interval = 24
~~~

启用后程序启动时先完整测速；之后每 check_interval 分钟检查当前 IP，延迟或丢包超阈值时立即重测并同步；每 test_interval 小时无条件完整刷新一次。Cron 模式是前台常驻进程，适合 systemd、Docker 或 Windows 任务计划。

## Docker

仓库提供 Dockerfile 和 docker-compose.yml，Compose 默认使用 lyxot/cfstd:latest：

~~~bash
docker compose up -d
docker compose logs -f cfstd
~~~

编辑 Compose 中的 CFSTD_* 环境变量即可配置。生产环境建议固定镜像版本、使用 .env 或 Docker Secret 保存密钥，并挂载持久化目录保存配置、输入文件、CSV 和日志。

从源码构建镜像时，Dockerfile 要求构建上下文中存在 release-assets，且其中包含各架构产物和 config.example.toml；仅执行 docker build . 不会自动生成这些文件。

## 环境变量

所有 TOML 字段都可以转换为 CFSTD_ 前缀的大写蛇形名称：

~~~bash
CFSTD_TEST_COUNT=20
CFSTD_MAX_DELAY=180
CFSTD_CFKV_ENABLE=true
CFSTD_CFKV_API_TOKEN=...
CFSTD_CRON_ENABLE=true
~~~

嵌套字段使用下划线连接，例如 cloudflare.api_token 对应 CFSTD_CLOUDFLARE_API_TOKEN，excellent_pool.max_size 对应 CFSTD_EXCELLENT_POOL_MAX_SIZE。完整列表见 [conf/env.md](conf/env.md)。

## 从源码编译

当前平台：

~~~bash
go build -ldflags "-s -w" -o cfstd .
~~~

Windows 编译全部平台：

~~~powershell
powershell -ExecutionPolicy Bypass -File ./build.ps1
~~~

产物位于 dist/，包括 Windows、Linux、macOS、ARM、MIPS、RISC-V 和 LoongArch 架构。构建脚本设置 CGO_ENABLED=0，生成不依赖本机 C 运行库的 Go 程序。

## 故障排查

### 找不到配置或输入文件

确认程序当前工作目录，以及 -c、ip_file、ipv4_file、ipv6_file 使用的路径。相对路径相对于进程启动目录，而不是可执行文件目录。

### 结果数量为零

检查输入文件和 CIDR 是否合法，机器是否能访问目标端口/测速 URL，max_delay、max_loss_rate、min_speed 是否过于严格，以及 IPv6 是否真的有公网出口。调试运行：

~~~bash
./cfstd -c config.toml -debug
~~~

### DNS 没有更新

确认对应区块 enable = true、凭证权限正确、域名和 Zone ID 正确、dns_num > 0，并且本轮结果中存在对应 IP 版本。程序会在日志中输出具体的 API 错误。

### KV 页面为空

确认程序已成功写入 KV，Worker 绑定变量名严格为 KV_NAMESPACE，并检查 Worker 与 KV 属于同一个 Account。先访问 /api/nodes，接口错误通常比页面更明确。

### 延迟异常低或所有 IP 结果相同

关闭透明代理、VPN 和路由器代理功能后重测。代理可能让请求并未真正连接到待测 IP。

## 安全建议

- 不要把 Cloudflare、阿里云或 DNSPod 密钥提交到 Git。
- API Token 使用最小权限和最小 Zone 范围。
- Worker 的 ADMIN_TOKEN、CF_API_TOKEN 使用 Secrets，不要写入 JavaScript 源码。
- DNS_RECORDS 不应包含任何 API Token。
- 公开日志前确认没有泄露敏感信息。

## 相关文件

| 文件 | 说明 |
| --- | --- |
| [conf/config.example.toml](conf/config.example.toml) | 完整 TOML 配置示例 |
| [conf/env.md](conf/env.md) | 环境变量列表 |
| [ip.txt](ip.txt) | 默认 IP/CIDR 输入文件 |
| [ipv6.txt](ipv6.txt) | IPv6 输入示例 |
| [worker_atlas.js](worker_atlas.js) | 推荐 Worker 页面 |
| [docker-compose.yml](docker-compose.yml) | Docker Compose 示例 |
| [build.ps1](build.ps1) | 多平台交叉编译脚本 |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | 发布版本说明 |

## 致谢

- [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest)：核心测速思路和部分实现基础。
- [IonRh/Cloudflare-BestIP](https://github.com/IonRh/Cloudflare-BestIP)：项目界面和功能设计参考。

## 开源协议

本项目使用 [GPL-3.0](LICENSE) 开源协议。
