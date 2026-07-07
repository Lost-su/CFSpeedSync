# CFSpeedSync

[![Go Version](https://img.shields.io/github/go-mod/go-version/yourusername/CFSpeedSync.svg?style=flat-square&label=Go&color=00ADD8&logo=go)](https://github.com/yourusername/CFSpeedSync/)
[![Release Version](https://img.shields.io/github/v/release/yourusername/CFSpeedSync.svg?style=flat-square&label=Release&color=00ADD8&logo=github)](https://github.com/yourusername/CFSpeedSync/releases/latest)
[![GitHub license](https://img.shields.io/github/license/yourusername/CFSpeedSync.svg?style=flat-square&label=License&color=00ADD8&logo=github)](https://github.com/yourusername/CFSpeedSync/)
[![GitHub Star](https://img.shields.io/github/stars/yourusername/CFSpeedSync.svg?style=flat-square&label=Star&color=00ADD8&logo=github)](https://github.com/yourusername/CFSpeedSync/)

> 🚀 **基于 [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 的增强版本**

一个强大的 CDN 测速工具，支持对 **Cloudflare 等 CDN 服务商** 进行延迟测速、优选 IP 同步到 DNS 解析，并提供持续监控功能。支持多域名配置分类管理，通过 Cloudflare Workers 展示测速结果。

## ✨ 主要特性

- 🔍 **智能测速**：支持 TCPing 和 HTTPing 两种测速模式
- 📊 **多维度筛选**：基于延迟、丢包率、下载速度等多重条件筛选最优 IP
- 🔄 **自动同步**：支持阿里云 DNS、DNSPod、Cloudflare DNS 服务商
- 🗂️ **多域名管理**：支持为不同域名配置独立的测速结果，KV 数据按域名前缀分类存储
- 🌐 **Web 展示**：配合 Cloudflare Workers 提供优雅的 Web 界面，支持域名切换查看
- 📈 **持续监控**：定时检测优选 IP 质量，自动更新解析记录
- 🌐 **多协议支持**：同时支持 IPv4 和 IPv6 地址测速
- 🕐 **时区统一**：所有平台（Windows/Linux/macOS）统一使用北京时间（UTC+8）
- 📝 **日志记录**：完整的操作日志，支持文件输出

## 🎯 新增功能

### 多域名配置支持

在配置文件的 `[cfkv]` 部分新增 `domain` 和 `subdomain` 字段：

```toml
[cfkv]
enable = true
api_token = "your_api_token"
account_id = "your_account_id"
namespace_id = "your_namespace_id"
domain = "example.com"           # 域名
subdomain = "cf"                 # 子域名
```

上传到 KV 时会使用 `subdomain.domain:` 作为前缀（如 `cf.example.com:ipv4`），实现多域名数据隔离。

### Web 界面展示

配合 [worker.js](worker.js) 部署到 Cloudflare Workers，提供：
- 域名选择下拉菜单，动态切换查看不同配置的测速结果
- 默认选项自动合并所有域名配置的数据
- 实时显示更新时间（北京时间）
- 响应式设计，支持移动端访问

### 跨平台时区统一

所有平台编译的版本统一使用 `time.FixedZone("CST", 8*3600)` 强制北京时间，避免不同系统时区设置导致的时间不一致问题。

## 🚀 快速开始

### 📥 下载安装

1. 从 [GitHub Releases](https://github.com/yourusername/CFSpeedSync/releases) 下载对应系统的可执行文件
2. 解压到任意目录
3. 双击运行 `cfstd.exe`（Windows）或 `./cfstd`（Linux/macOS），开始测速

**支持平台**：
- Windows: x86_64, x86, ARM64
- Linux: x86_64, x86, aarch64, armv7, arm, loongarch64, riscv64, mips, mips64, mipsle, mips64le
- macOS: x86_64 (Intel), aarch64 (Apple Silicon)

<details>
<summary><code><strong>🐧 Linux/macOS 用户点击查看详细安装步骤</strong></code></summary>

> 💡 以下命令仅为示例，请根据实际版本号调整下载链接

``` bash
# 如果是第一次使用，则建议创建新文件夹（后续更新时，跳过该步骤）
mkdir cfspeedsync

# 进入文件夹（后续更新，只需要从这里重复下面的下载、解压命令即可）
cd cfspeedsync

# 下载压缩包（自行根据需求替换 URL 中 [版本号] 和 [文件名]）
wget -N https://github.com/yourusername/CFSpeedSync/releases/download/v1.0.0/cfstd-linux-x86_64

# 赋予执行权限
chmod +x cfstd-linux-x86_64

# 运行（默认配置）
./cfstd-linux-x86_64

# 运行（指定配置文件）
./cfstd-linux-x86_64 -c config.toml
```

</details>

### 📊 测速结果示例

测速完成后，程序会显示**延迟最低、速度最快的 IP 地址**。以下是典型输出示例：

``` bash
IP 地址           已发送  已接收  丢包率  平均延迟  下载速度(MB/s)  地区码
104.27.200.69     4      4       0.00   146.23    28.64          LAX
172.67.60.78      4      4       0.00   139.82    15.02          SEA
104.25.140.153    4      4       0.00   146.49    14.90          SJC
104.27.192.65     4      4       0.00   140.28    14.07          LAX
172.67.62.214     4      4       0.00   139.29    12.71          LAX
104.27.207.5      4      4       0.00   145.92    11.95          LAX
172.67.54.193     4      4       0.00   146.71    11.55          LAX
104.22.66.8       4      4       0.00   147.42    11.11          SEA
104.27.197.63     4      4       0.00   131.29    10.26          FRA
172.67.58.91      4      4       0.00   140.19    9.14           SJC
...

# ⚠️  注意事项：
# - 如果延迟显示异常低（如 0.xx），请检查是否开启了代理软件
# - 在路由器上运行时，请确保关闭路由器内的代理功能
# - 每次测速结果可能不同，这是正常现象（随机选择 IP 段中的地址）

# 📋 测速流程：
# 1. 延迟测速 → 2. 延迟排序 → 3. 下载测速 → 4. 速度排序 → 5. 输出结果
```

> 🎯 **测速结果第一行即为最优 IP**（延迟最低 + 速度最快）

完整结果将保存为 `result.csv` 文件，可用 Excel、记事本等软件打开查看：

```
IP 地址,已发送,已接收,丢包率,平均延迟,下载速度(MB/s),地区码
104.27.200.69,4,4,0.00,146.23,28.64,LAX
```

## ⚙️ 进阶配置

默认配置适合大多数用户，如需更精确的测速结果，可通过配置文件或环境变量自定义参数。详细配置说明请参考[示例配置文件](conf/config.example.toml)或[环境变量说明](conf/env.md)。

### 🖥️ 命令行参数
```text
参数：
    -c config.toml
        指定TOML配置文件；默认为config.toml，不存在时使用默认参数
    -debug
        调试输出模式；会在一些非预期情况下输出更多日志以便判断原因；(默认 关闭)
    -v
        打印程序版本
    -u
        检查版本更新
    -h
        打印帮助说明
```

### 🌐 IPv4/IPv6 分离测速

通过以下配置项可分别指定 IPv4 和 IPv6 的测速数据：

- `ipv4_file`：IPv4 段数据文件路径
- `ipv6_file`：IPv6 段数据文件路径

> ⚠️ 当指定了任意一个文件时，`ip_file` 配置将失效

**同时指定两个文件时**：
- 将分别对 IPv4 和 IPv6 进行测速
- 结果文件会自动分离：`result.csv` → `result_ipv4.csv` + `result_ipv6.csv`

### 🔄 DNS 自动同步

#### 阿里云 DNS
修改 config 中的 `alidns` 部分：

```toml
[alidns]
enable = true                    # 是否启用阿里云 DNS
accesskey_id = "your_key_id"     # 阿里云 AccessKey ID
accesskey_secret = "your_secret" # 阿里云 AccessKey Secret
domain = "example.com"           # 域名
subdomain = "cf"                 # 子域名
ttl = 600                        # TTL 值
```

> 🔑 **获取 AccessKey**：[阿里云 RAM 控制台](https://ram.console.aliyun.com/profile/access-keys)

#### DNSPod DNS
修改 config 中的 `dnspod` 部分：

```toml
[dnspod]
enable = true                    # 是否启用 DNSPod DNS
secret_id = "your_secret_id"     # DNSPod Secret ID
secret_key = "your_secret_key"   # DNSPod Secret Key
domain = "example.com"           # 域名
subdomain = "cf"                 # 子域名
ttl = 600                        # TTL 值
```

> 🔑 **获取 API 密钥**：[DNSPod 控制台](https://console.dnspod.cn/account/token/apikey)
> 
> ⚠️ 需要使用腾讯云 API 密钥

#### Cloudflare DNS
修改 config 中的 `cloudflare` 部分：

```toml
[cloudflare]
enable = true                    # 是否启用 Cloudflare DNS
api_token = "your_api_token"     # Cloudflare API Token
zone_id = "your_zone_id"         # Cloudflare 域名的 Zone ID
domain = "example.com"           # 域名
subdomain = "cf"                 # 子域名
proxied = false                  # 是否开启 Cloudflare 代理
ttl = 1                          # TTL 值（1为自动）
```

> 🔑 **获取 API Token**：[Cloudflare 控制台](https://dash.cloudflare.com/profile/api-tokens)
> 
> 📝 **创建步骤**：创建令牌 → 使用模板 → 编辑区域 DNS → 区域资源：`包括` `账户的所有区域` `xxx's Account`

#### Cloudflare Workers KV
修改 config 中的 `cfkv` 部分：

```toml
[cfkv]
enable = true                      # 是否启用 Cloudflare KV
api_token = "your_api_token"       # Cloudflare API Token
account_id = "your_account_id"     # Cloudflare Account ID
namespace_id = "your_namespace_id" # Cloudflare KV Namespace ID
domain = "example.com"             # 域名（可选）
subdomain = "cf"                   # 子域名（可选）
```

> 🔑 **获取 API Token**：[Cloudflare 控制台](https://dash.cloudflare.com/profile/api-tokens)
> 
> 📝 **创建步骤**：创建令牌 → 创建自定义令牌 → 权限：`帐户` `Workers KV 存储` `编辑` → 帐户资源：`包括` `xxx's Account`

**KV 数据格式**：

如果配置了 `domain` 和 `subdomain`，数据将使用前缀存储（如 `cf.example.com:ipv4`）：
- `{prefix}ipv4`：`IP`,`已发送`,`已接收`,`丢包率`,`平均延迟`,`下载速度`,`数据中心`&...
- `{prefix}ipv4time`：更新时间（北京时间）
- `{prefix}ipv6`：`IP`,`已发送`,`已接收`,`丢包率`,`平均延迟`,`下载速度`,`数据中心`&...
- `{prefix}ipv6time`：更新时间（北京时间）

如果未配置域名，则直接使用 `ipv4`、`ipv4time`、`ipv6`、`ipv6time` 作为 key。

> 💡 **推荐搭配 Cloudflare Workers 使用**
<details>
<summary><code><strong>🚀 点击查看 Cloudflare Workers 部署步骤</strong></code></summary>

1. **访问 [Cloudflare Dashboard](https://dash.cloudflare.com)**

2. **创建 KV 存储**：
   - 进入"存储和数据库" → "KV"
   - 点击"创建命名空间"
   - 记录 Namespace ID 并填入配置文件

3. **创建 Workers**：
   - 进入"Workers 和 Pages" → "创建"
   - 选择"创建 Worker"
   - 部署后点击"编辑代码"
   - 复制 [worker.js](worker.js) 或 [worker copy.js](worker%20copy.js) 内容
   - 修改顶部的配置变量：
     ```javascript
     const CDN = 'Cloudflare';              // 服务商名称
     const domain = 'cf.example.com';       // 优选域名
     const wildcardDomain = true;           // 是否支持泛域名
     const checkInterval = 30;              // 检测间隔（分钟）
     const testInterval = 24;               // 强制刷新间隔（小时）
     ```
   - 点击"部署"

4. **绑定 Workers KV**：
   - 在 Worker 页面，进入"设置" → "变量"
   - 向下滚动到"KV 命名空间绑定"
   - 点击"添加绑定"
   - 变量名称：`KV_NAMESPACE`
   - KV 命名空间：选择刚创建的命名空间
   - 点击"保存并部署"

5. **访问 Worker**：
   - 在 Worker 页面可以看到分配的域名（如 `your-worker.workers.dev`）
   - 访问该域名即可看到测速结果展示页面
   - 可以在页面上选择不同的域名配置查看对应的测速数据

</details>

### 📈 持续监控

修改 config 中的 `cron` 部分：

```toml
[cron]
enable = true                    # 是否启用定时任务
latency_threshold = 200          # 延迟阈值（毫秒）
loss_rate_threshold = 0.1        # 丢包率阈值
check_interval = 30              # 检测间隔（分钟）
test_interval = 24               # 强制刷新间隔（小时）
```

> 🔄 **监控机制**：
- 每隔 `test_interval` 小时重新测速并更新 DNS 记录
- 每隔 `check_interval` 分钟检测优选 IP 的延迟、丢包率
- 当延迟或丢包率超过阈值时自动重新测速并更新 DNS 记录

## 🏗️ 多域名配置示例

假设你有多个网站需要 CDN 优选：

**配置文件 1**（`config_site1.toml`）：
```toml
[cfkv]
enable = true
api_token = "your_token"
account_id = "your_account_id"
namespace_id = "your_namespace_id"
domain = "example.com"
subdomain = "www"
```

**配置文件 2**（`config_site2.toml`）：
```toml
[cfkv]
enable = true
api_token = "your_token"
account_id = "your_account_id"
namespace_id = "your_namespace_id"
domain = "example.com"
subdomain = "blog"
```

分别运行：
```bash
./cfstd -c config_site1.toml
./cfstd -c config_site2.toml
```

KV 中会存储：
- `www.example.com:ipv4`、`www.example.com:ipv4time` 等
- `blog.example.com:ipv4`、`blog.example.com:ipv4time` 等

在 Worker 页面可以通过下拉菜单切换查看不同站点的测速结果。

## 🙏 致谢

本项目基于以下优秀项目开发：

- **[XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest)** - 核心测速功能
- **[IonRh/Cloudflare-BestIP](https://github.com/IonRh/Cloudflare-BestIP)** - 项目灵感来源

****

## 🔧 从源码编译

### 单平台编译

```bash
go build -ldflags "-s -w" -o cfstd
```

### 全平台编译

使用提供的 PowerShell 脚本一键编译所有平台版本：

```bash
# Windows
powershell -ExecutionPolicy Bypass -File build.ps1

# 输出目录: dist/
# 包含 16 个平台的可执行文件
```

支持的平台：
- Windows: amd64, 386, arm64
- Linux: amd64, 386, arm64, arm (v7), loong64, riscv64, mips, mips64, mipsle, mips64le
- macOS: amd64, arm64

> 💡 编译时会自动剥离调试信息（`-s -w`）以减小文件体积

## 📄 开源协议

本项目采用 GPL-3.0 开源协议。

## 🌟 Star History

如果这个项目对你有帮助，欢迎给个 Star ⭐
