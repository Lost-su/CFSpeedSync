package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime"
	"runtime/pprof"
	"sort"
	"strings"
	"time"

	"github.com/Lyxot/CloudflareSpeedTestDNS/conf"
	"github.com/Lyxot/CloudflareSpeedTestDNS/ddns"
	"github.com/Lyxot/CloudflareSpeedTestDNS/task"
	"github.com/Lyxot/CloudflareSpeedTestDNS/utils"
)

var (
	version    string
	gitCommit  string
	configFile string
)

func init() {
	// 注入自定义 DNS 解析器，解决 Android/Termux 等环境下 /etc/resolv.conf 不可用的问题
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "udp", "8.8.8.8:53")
		},
	}

	// 解决 Android/Termux 找不到系统根证书的问题
	http.DefaultTransport = &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}

	var printVersion, checkUpdateFlag, debugFlag, pgoFlag bool
	var help = `CloudflareSpeedTestDNS ` + version + `-` + gitCommit + `
测试各个 CDN 或网站所有 IP 的延迟和速度，获取最快 IP (IPv4+IPv6)！
https://github.com/Lyxot/CloudflareSpeedTestDNS

参数：
    -c config.toml
        指定TOML配置文件；默认为config.toml，不存在时使用默认参数
    -debug
        调试输出模式；会在一些非预期情况下输出更多日志以便判断原因；(默认 关闭)
	-pgo
		开启 CPU 性能分析
    -v
        打印程序版本
    -u
        检查版本更新
    -h
        打印帮助说明
`
	flag.BoolVar(&debugFlag, "debug", false, "调试输出模式")
	flag.BoolVar(&pgoFlag, "pgo", false, "开启 CPU 性能分析")
	flag.StringVar(&configFile, "c", "", "指定TOML配置文件")
	flag.BoolVar(&printVersion, "v", false, "打印程序版本")
	flag.BoolVar(&checkUpdateFlag, "u", false, "检查版本更新")
	flag.Usage = func() { fmt.Print(help) }
	flag.Parse()

	if pgoFlag {
		pgo()
	}

	if printVersion {
		fmt.Printf("CloudflareSpeedTestDNS version %s, build %s, %s\n", version, gitCommit, runtime.Version())
		endPrint()
		os.Exit(0)
	}

	if checkUpdateFlag {
		fmt.Println("检查版本更新中...")
		versionNew, err := checkUpdate()
		if err != nil {
			_, _ = utils.Red.Printf("检查版本更新失败: %v", err)
		} else if versionNew != "" && versionNew != version {
			_, _ = utils.Yellow.Printf("*** 发现新版本 [%s]！请前往 [https://github.com/Lyxot/CloudflareSpeedTestDNS/releases/latest] 更新！ ***", versionNew)
		} else {
			_, _ = utils.Green.Println("当前为最新版本 [" + version + "]！")
		}
		fmt.Printf("\n")
		endPrint()
		os.Exit(0)
	}

	var config *conf.Config
	var err error

	if configFile != "" {
		// 如果指定了配置文件，则加载它
		config, err = conf.LoadConfig(configFile)
		if err != nil {
			utils.LogFatal("加载配置文件失败: %v", err)
		}
	} else {
		// 如果未指定配置文件，则尝试加载默认的 config.toml
		config, err = conf.LoadConfig("config.toml")
		if err != nil {
			utils.LogWarn("加载配置文件 [config.toml] 失败: %v，改用默认配置", err)
			config = conf.CreateDefaultConfig()
		}
	}

	conf.LoadEnvConfig(config)
	conf.ApplyConfig(config)

	// 如果通过命令行指定了 -debug，则覆盖配置文件中的设置
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "debug" {
			utils.Debug = debugFlag
		}
	})

	// 初始化日志文件
	if err := utils.InitLogFile(); err != nil {
		utils.LogFatal("初始化日志文件失败: %v", err)
	}

	if task.MinSpeed > 0 && config.MaxDelay == 9999 {
		utils.LogWarn("配置了 min_speed 参数时，建议搭配 max_delay 参数，以避免因凑不够 test_count 数量而一直测速...")
	}
}

func main() {
	utils.LogInfo("# Lyxot/CloudflareSpeedTestDNS %s-%s", version, gitCommit)
	if conf.EnableCron {
		cron() // 定时任务
	} else {
		_, _ = speedTest() // 开始测速
	}
	endPrint() // 根据情况选择退出方式（针对 Windows）
}

func cron() {
	utils.LogInfo("定时任务已启用")
	ipData, _ := speedTest()

	// 设置定时器
	testTicker := time.NewTicker(conf.TestInterval)
	checkTicker := time.NewTicker(conf.CheckInterval)

	for {
		select {
		case <-testTicker.C:
			utils.LogInfo("强制刷新任务开始...")
			testResult, err := speedTest()
			if err == nil {
				ipData = testResult
			} else {
				utils.LogWarn("新一轮测速未获取到符合条件的IP，继续使用上次结果")
			}
			checkTicker.Reset(conf.CheckInterval)
		case <-checkTicker.C:
			utils.LogInfo("开始检查延迟和丢包率...")
			// 拼接 IP 段数据
			ipText := ""
			for _, ip := range ipData {
				ipText += ip + ","
			}
			// 保存原始设置
			origIPText := task.IPText
			origMaxDelay := utils.InputMaxDelay
			origMaxLossRate := utils.InputMaxLossRate

			task.IPText = ipText
			utils.InputMaxDelay = conf.LatencyThreshold
			utils.InputMaxLossRate = conf.LossRateThreshold
			pingData := task.NewPing().Run().FilterDelay().FilterLossRate()

			// 恢复原始设置
			task.IPText = origIPText
			utils.InputMaxDelay = origMaxDelay
			utils.InputMaxLossRate = origMaxLossRate

			if len(pingData) != len(ipData) {
				utils.LogInfo("延迟或丢包率超过阈值，开始新一轮测速...")
				testResult, err := speedTest()
				if err == nil {
					ipData = testResult
				} else {
					utils.LogWarn("新一轮测速未获取到符合条件的IP，继续使用上次结果")
				}
				testTicker.Reset(conf.TestInterval)
			} else {
				utils.LogInfo("延迟和丢包率在阈值范围内")
			}
		}
	}
}

func speedTest() ([]string, error) {
	var ipData []string
	var err error
	if task.IsBothMode() {
		// 保存原始文件设置
		origIPv4File := task.IPv4File
		origIPv6File := task.IPv6File
		originOutput := utils.Output

		// 测试IPv4
		utils.LogInfo("[IPv4] 开始测试IPv4...")
		task.IPv6File = ""
		utils.Output = utils.GetFilenameWithSuffix(originOutput, "ipv4")
		ipv4SpeedData, testErr := singleSpeedTest("IPv4", "ipv4")
		if testErr == nil {
			ipData = append(ipData, ddnsSync(ipv4SpeedData)...)
		} else {
			err = testErr
		}

		// 测试IPv6
		utils.LogInfo("[IPv6] 开始测试IPv6...")
		task.IPv4File = ""
		task.IPv6File = origIPv6File
		utils.Output = utils.GetFilenameWithSuffix(originOutput, "ipv6")
		ipv6SpeedData, testErr := singleSpeedTest("IPv6", "ipv6")
		if testErr == nil {
			ipData = append(ipData, ddnsSync(ipv6SpeedData)...)
		} else {
			err = errors.Join(err, testErr)
		}

		// 恢复原始文件设置
		task.IPv4File = origIPv4File
		task.IPv6File = origIPv6File
		utils.Output = originOutput
	} else {
		poolVer := "ip"
		ipVer := "IP"
		if task.IsIPv4Mode() {
			poolVer = "ipv4"
			ipVer = "IPv4"
		} else if task.IsIPv6Mode() {
			poolVer = "ipv6"
			ipVer = "IPv6"
		}
		speedData, testErr := singleSpeedTest(ipVer, poolVer)
		if testErr == nil {
			ipData = ddnsSync(speedData)
		} else {
			err = testErr
		}
	}
	return ipData, err
}

func singleSpeedTest(ipVersion string, poolVersion string) (utils.DownloadSpeedSet, error) {
	// 保存原始 IPText，优良库注入后需要恢复
	origIPText := task.IPText
	origIPFile := task.IPFile
	origIPv4File := task.IPv4File
	origIPv6File := task.IPv6File

	poolLoaded := false
	var poolEntries []ddns.ExcellentEntry

	if poolVersion != "" && !conf.EnableExcellentPool {
		utils.LogInfo("[优良库] 未启用，如需开启请在配置文件中设置 [excellent_pool] enable = true")
	} else if conf.EnableExcellentPool && !conf.EnableCFKV {
		utils.LogWarn("[优良库] 已启用优良库但 [cfkv] 未启用，优良库功能不生效")
	} else if conf.EnableExcellentPool && conf.EnableCFKV && poolVersion != "" {
		utils.LogInfo("[优良库] 已启用 (模式: %s, 入库标准: 速度≥%.1f MB/s, 延迟≤%d ms, 丢包率≤%.2f)",
			conf.ExcellentPoolUseMode, conf.ExcellentPoolMinSpeed, conf.ExcellentPoolMaxDelay, conf.ExcellentPoolMaxLoss)
		entries, err := ddns.LoadExcellentPool(poolVersion)
		if err != nil {
			utils.LogWarn("[优良库] 读取优良库失败，使用常规测速: %v", err)
		} else if len(entries) > 0 {
			poolEntries = entries
			poolLoaded = true
		} else {
			utils.LogInfo("[优良库] 优良库为空（首次运行或已清空），使用常规测速")
		}
	}

	var speedData utils.DownloadSpeedSet
	var err error

	switch {
	case poolLoaded && conf.ExcellentPoolUseMode == "only":
		// 仅用模式：只测优良库 IP
		utils.LogInfo("[优良库] 仅用模式：使用优良库中 %d 个 %s 进行测速", len(poolEntries), ipVersion)
		task.IPText = ddns.ExcellentEntriesToIPText(poolEntries)
		task.IPFile = ""
		task.IPv4File = ""
		task.IPv6File = ""
		speedData, err = runSpeedTest(ipVersion)

	case poolLoaded && conf.ExcellentPoolUseMode == "mixed":
		// 混合模式：优良库 IP + 原始 IP 段合并，优良库 IP 优先（放前面）
		utils.LogInfo("[优良库] 混合模式：优先测试优良库中 %d 个 %s", len(poolEntries), ipVersion)
		poolText := ddns.ExcellentEntriesToIPText(poolEntries)
		if origIPText != "" {
			task.IPText = poolText + "," + origIPText
		} else {
			task.IPText = poolText
			// 混合模式下原有文件来源不变，IPText 已包含优良库，文件里的 IP 也会被加载
			// 但 loadIPRanges 优先读 IPText，所以需要将文件 IP 也追加进来
			// 通过保持文件变量不变，让 loadIPRanges 走文件路径，会忽略 IPText
			// 因此将文件 IP 手动追加到 IPText
			task.IPText = poolText + "," + loadFileIPsAsText(origIPFile, origIPv4File, origIPv6File)
			task.IPFile = ""
			task.IPv4File = ""
			task.IPv6File = ""
		}
		speedData, err = runSpeedTest(ipVersion)

	case poolLoaded: // priority 模式（默认）
		// 优先模式：先测优良库，不够再用常规 IP 段补充
		utils.LogInfo("[优良库] 优先模式：先测试优良库中 %d 个 %s", len(poolEntries), ipVersion)
		task.IPText = ddns.ExcellentEntriesToIPText(poolEntries)
		task.IPFile = ""
		task.IPv4File = ""
		task.IPv6File = ""
		wantCount := task.TestCount // 保存下载测速会修改 task.TestCount，需在此先记录
		speedData, err = runSpeedTest(ipVersion)

		if err != nil || len(speedData) < wantCount {
			utils.LogInfo("[优良库] 优良库结果不足(%d/%d)，使用常规IP段补充测速...", len(speedData), wantCount)
			task.IPText = origIPText
			task.IPFile = origIPFile
			task.IPv4File = origIPv4File
			task.IPv6File = origIPv6File
			task.TestCount = wantCount // 恢复原始数量，避免被上一轮下载测速截断限制补充数
			extraData, extraErr := runSpeedTest(ipVersion)
			if extraErr == nil {
				// 合并结果（优良库结果在前，补充结果追加），去重后按速度重排并截断到目标数量
				seen := make(map[string]struct{}, len(speedData))
				combined := make(utils.DownloadSpeedSet, 0, len(speedData)+len(extraData))
				for _, d := range speedData {
					seen[d.IP.String()] = struct{}{}
					combined = append(combined, d)
				}
				for _, d := range extraData {
					if _, dup := seen[d.IP.String()]; dup {
						continue
					}
					seen[d.IP.String()] = struct{}{}
					combined = append(combined, d)
				}
				sort.Slice(combined, func(i, j int) bool {
					return combined[i].DownloadSpeed > combined[j].DownloadSpeed
				})
				if wantCount > 0 && len(combined) > wantCount {
					combined = combined[:wantCount]
				}
				speedData = combined
				err = nil
			} else if len(speedData) == 0 {
				err = extraErr
			}
		}

	default:
		// 优良库未启用或未加载，走原有逻辑
		speedData, err = runSpeedTest(ipVersion)
	}

	// 恢复原始设置
	task.IPText = origIPText
	task.IPFile = origIPFile
	task.IPv4File = origIPv4File
	task.IPv6File = origIPv6File

	if err != nil {
		return speedData, err
	}

	utils.ExportCsv(speedData)
	speedData.Print()

	// 更新优良库
	if conf.EnableExcellentPool && conf.EnableCFKV && poolVersion != "" {
		var ipDataForPool []utils.IPData
		if poolVersion == "ipv4" {
			ipDataForPool = speedData.FilterIPv4()
		} else if poolVersion == "ipv6" {
			ipDataForPool = speedData.FilterIPv6()
		} else {
			ipDataForPool = append(speedData.FilterIPv4(), speedData.FilterIPv6()...)
		}
		if updateErr := ddns.UpdateExcellentPool(poolVersion, ipDataForPool); updateErr != nil {
			utils.LogError("[优良库] 更新优良库失败: %v", updateErr)
		}
	}

	return speedData, nil
}

// runSpeedTest 执行一轮延迟+下载测速，含重试逻辑
func runSpeedTest(ipVersion string) (utils.DownloadSpeedSet, error) {
	var speedData utils.DownloadSpeedSet
	for i := 0; i < conf.MaxAttempts; i++ {
		pingData := task.NewPing().Run().FilterDelay().FilterLossRate()
		speedData = task.TestDownloadSpeed(pingData)
		if len(speedData) >= conf.MinNum {
			return speedData, nil
		}
		if i < conf.MaxAttempts-1 {
			utils.LogWarn("符合条件的%s数量[%d]少于设定的最小数量[%d]，将在15秒后开始新一轮测试...", ipVersion, len(speedData), conf.MinNum)
			time.Sleep(15 * time.Second)
		} else {
			utils.LogWarn("符合条件的%s数量[%d]少于设定的最小数量[%d]，已达到最大重试次数[%d]，测试结束。", ipVersion, len(speedData), conf.MinNum, conf.MaxAttempts)
			return speedData, fmt.Errorf("符合条件的%s数量少于设定的最小数量", ipVersion)
		}
	}
	return speedData, nil
}

// loadFileIPsAsText 将文件/IPText 中的 IP 段读取并拼接为逗号分隔字符串（用于 mixed 模式）
func loadFileIPsAsText(ipFile, ipv4File, ipv6File string) string {
	var filename string
	if ipv4File != "" {
		filename = ipv4File
	} else if ipv6File != "" {
		filename = ipv6File
	} else if ipFile != "" {
		filename = ipFile
	}
	if filename == "" {
		return ""
	}
	f, err := os.Open(filename)
	if err != nil {
		utils.LogWarn("[优良库] 读取IP文件失败: %v", err)
		return ""
	}
	defer f.Close()
	var lines []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, ",")
}

func ddnsSync(speedData utils.DownloadSpeedSet) []string {
	if len(speedData) == 0 {
		return []string{}
	}

	// 根据结果类型分类
	var ipv4Results []string
	var ipv6Results []string
	for i := 0; i < conf.DnsNum && i < len(speedData); i++ {
		ip := speedData[i].IP.String()
		if task.IsIPv4(ip) {
			ipv4Results = append(ipv4Results, ip)
		} else {
			ipv6Results = append(ipv6Results, ip)
		}
	}

	// 如果启用了阿里云DNS，则同步结果
	if conf.EnableAliDNS {
		utils.LogInfo("开始同步结果到阿里云DNS...")
		if err := ddns.SyncDNSRecords(ipv4Results, ipv6Results); err != nil {
			utils.LogError("同步到阿里云DNS失败: %v", err)
		} else {
			utils.LogInfo("同步到阿里云DNS成功!")
		}
	}

	// 如果启用了DNSPod DNS，则同步结果
	if conf.EnableDNSPod {
		utils.LogInfo("开始同步结果到DNSPod DNS...")
		if err := ddns.SyncDNSPodRecords(ipv4Results, ipv6Results); err != nil {
			utils.LogError("同步到DNSPod DNS失败: %v", err)
		} else {
			utils.LogInfo("同步到DNSPod DNS成功!")
		}
	}

	// 如果启用了Cloudflare DNS，则同步结果
	if conf.EnableCloudflare {
		utils.LogInfo("开始同步结果到Cloudflare DNS...")
		if err := ddns.SyncCloudflareRecords(ipv4Results, ipv6Results); err != nil {
			utils.LogError("同步到Cloudflare DNS失败: %v", err)
		} else {
			utils.LogInfo("同步到Cloudflare DNS成功!")
		}
	}

	// 如果启用了Cloudflare KV，则同步结果
	if conf.EnableCFKV {
		utils.LogInfo("开始同步结果到Cloudflare KV...")
		if err := ddns.SyncCloudflareKV(speedData.FilterIPv4(), speedData.FilterIPv6()); err != nil {
			utils.LogError("同步到Cloudflare KV失败: %v", err)
		} else {
			utils.LogInfo("同步到Cloudflare KV成功!")
		}

		// 同步当前启用的DNS记录信息，供worker.js动态展示
		var dnsRecords []ddns.DNSRecord
		if conf.EnableAliDNS {
			dnsRecords = append(dnsRecords, ddns.DNSRecord{Provider: "AliDNS", Domain: ddns.AliDNSConfig.Domain, Subdomain: ddns.AliDNSConfig.Subdomain})
		}
		if conf.EnableDNSPod {
			dnsRecords = append(dnsRecords, ddns.DNSRecord{Provider: "DNSPod", Domain: ddns.DNSPodConfig.Domain, Subdomain: ddns.DNSPodConfig.Subdomain})
		}
		if conf.EnableCloudflare {
			dnsRecords = append(dnsRecords, ddns.DNSRecord{Provider: "Cloudflare DNS", Domain: ddns.CloudflareConfig.Domain, Subdomain: ddns.CloudflareConfig.Subdomain})
		}
		if len(dnsRecords) > 0 {
			if err := ddns.SyncDNSInfoToKV(dnsRecords); err != nil {
				utils.LogError("同步DNS记录信息到KV失败: %v", err)
			}
		}
	}

	return append(ipv4Results, ipv6Results...)
}

// 根据情况选择退出方式（针对 Windows）
func endPrint() {
	if utils.NoPrintResult() { // 如果不需要打印测速结果，则直接退出
		return
	}
	if runtime.GOOS == "windows" { // 如果是 Windows 系统，则需要按下 回车键 或 Ctrl+C 退出（避免通过双击运行时，测速完毕后直接关闭）
		fmt.Println("按下 回车键 或 Ctrl+C 退出。")
		_, _ = fmt.Scanln()
	}
}

// 检查更新
func checkUpdate() (string, error) {
	timeout := 10 * time.Second
	client := http.Client{Timeout: timeout}
	res, err := client.Get("https://api.github.com/repos/Lyxot/CloudflareSpeedTestDNS/releases/latest")
	if err != nil {
		return "", err
	}
	// 读取资源数据 body: []byte
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	// 关闭资源流
	defer func(Body io.ReadCloser) {
		err := Body.Close()
		if err != nil {
			utils.LogError("关闭版本检查响应流失败，错误信息: %v", err)
		}
	}(res.Body)

	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", err
	}

	if tagName, ok := result["tag_name"].(string); ok {
		return tagName, nil
	}
	return "", fmt.Errorf("can't get tag_name from github api")
}

func pgo() {
	f, err := os.Create("cpu.pprof")
	if err != nil {
		utils.LogFatal("could not create CPU profile: %v", err)
	}
	defer func(f *os.File) {
		err := f.Close()
		if err != nil {
			utils.LogFatal("could not close CPU profile: %v", err)
		}
	}(f)
	if err := pprof.StartCPUProfile(f); err != nil {
		utils.LogFatal("could not start CPU profile: %v", err)
	}
	defer pprof.StopCPUProfile()
}
