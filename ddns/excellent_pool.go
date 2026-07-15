package ddns

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/Lyxot/CloudflareSpeedTestDNS/utils"
	"github.com/cloudflare/cloudflare-go"
)

// ExcellentEntry 优良库中单条IP记录
type ExcellentEntry struct {
	IP        string  `json:"ip"`
	Speed     float64 `json:"speed"`      // MB/s
	Delay     int64   `json:"delay"`      // ms
	LossRate  float32 `json:"loss_rate"`
	Packets   int     `json:"packets"`
	Received  int     `json:"received"`
	Colo      string  `json:"colo"`
	AddedTime string  `json:"added_time"` // 北京时间
}

// excellentPoolConfig 优良库配置（由 conf 包在 ApplyConfig 中填充）
type excellentPoolConfig struct {
	Enable         bool
	UseMode        string  // "priority" / "only" / "mixed"
	MinSpeed       float64 // MB/s
	MaxDelay       int     // ms
	MaxLossRate    float64
	MaxSize        int
	AutoRemoveSlow bool
}

var ExcellentPoolCfg = excellentPoolConfig{
	Enable:         false,
	UseMode:        "priority",
	MinSpeed:       20.0,
	MaxDelay:       150,
	MaxLossRate:    0.0,
	MaxSize:        100,
	AutoRemoveSlow: true,
}

// excellentPoolKey 构建优良库在 KV 中的 key
func excellentPoolKey(prefix, ipVersion string) string {
	return prefix + "excellent_" + ipVersion
}

// LoadExcellentPool 从 KV 读取优良库，返回对应版本的 IP 列表
func LoadExcellentPool(ipVersion string) ([]ExcellentEntry, error) {
	if CloudflareKVConfig.APIToken == "" || CloudflareKVConfig.AccountID == "" || CloudflareKVConfig.NamespaceID == "" {
		return nil, fmt.Errorf("cloudflare kv配置不完整")
	}

	api, err := newCloudflareKVClient()
	if err != nil {
		return nil, fmt.Errorf("创建Cloudflare客户端失败: %v", err)
	}

	ctx := context.Background()
	prefix := buildKeyPrefix()
	key := excellentPoolKey(prefix, ipVersion)

	val, err := api.GetWorkersKV(ctx, cloudflare.AccountIdentifier(CloudflareKVConfig.AccountID), cloudflare.GetWorkersKVParams{
		NamespaceID: CloudflareKVConfig.NamespaceID,
		Key:         key,
	})
	if err != nil {
		// key 不存在时视为空库，不报错
		if utils.Debug {
			utils.LogDebug("优良库 KV key [%s] 不存在或读取失败: %v", key, err)
		}
		return []ExcellentEntry{}, nil
	}

	var entries []ExcellentEntry
	if err := json.Unmarshal(val, &entries); err != nil {
		utils.LogWarn("解析优良库数据失败，视为空库: %v", err)
		return []ExcellentEntry{}, nil
	}

	utils.LogInfo("[优良库] 读取 %s 优良库成功，共 %d 条记录", ipVersion, len(entries))
	return entries, nil
}

// UpdateExcellentPool 根据本次测速结果更新优良库并写回 KV
func UpdateExcellentPool(ipVersion string, testResults []utils.IPData) error {
	if CloudflareKVConfig.APIToken == "" || CloudflareKVConfig.AccountID == "" || CloudflareKVConfig.NamespaceID == "" {
		return fmt.Errorf("cloudflare kv配置不完整")
	}

	current, err := LoadExcellentPool(ipVersion)
	if err != nil {
		utils.LogWarn("[优良库] 读取现有优良库失败，将从空库开始: %v", err)
		current = []ExcellentEntry{}
	}

	cfg := ExcellentPoolCfg
	beijingLoc := time.FixedZone("CST", 8*3600)
	now := time.Now().In(beijingLoc).Format("2006-01-02 15:04:05")

	// 1. 移除衰减IP（如果启用）
	if cfg.AutoRemoveSlow {
		before := len(current)
		var kept []ExcellentEntry
		for _, e := range current {
			if e.Speed >= cfg.MinSpeed && float64(e.Delay) <= float64(cfg.MaxDelay) && float64(e.LossRate) <= cfg.MaxLossRate {
				kept = append(kept, e)
			} else {
				utils.LogInfo("[优良库] 移除衰减IP: %s (速度: %.2f MB/s, 延迟: %d ms)", e.IP, e.Speed, e.Delay)
			}
		}
		current = kept
		if utils.Debug && before > len(current) {
			utils.LogDebug("[优良库] 移除衰减IP %d 条", before-len(current))
		}
	}

	// 构建现有IP集合，避免重复入库
	existing := make(map[string]struct{}, len(current))
	for _, e := range current {
		existing[e.IP] = struct{}{}
	}

	utils.LogInfo("[优良库] 正在筛选本次 %d 条%s测速结果 (速度≥%.1f MB/s, 延迟≤%d ms, 丢包率≤%.2f)...",
		len(testResults), ipVersion, cfg.MinSpeed, cfg.MaxDelay, cfg.MaxLossRate)

	// 2. 遍历本次测速结果，尝试入库
	added, updated, replaced, skipped := 0, 0, 0, 0
	for _, r := range testResults {
		if !meetsExcellentStandard(r) {
			skipped++
			if utils.Debug {
				utils.LogDebug("[优良库] 不符合标准，跳过: %s (速度: %.2f MB/s, 延迟: %d ms, 丢包: %.2f)",
					r.IP, r.Speed, r.Delay, r.LossRate)
			}
			continue
		}
		if _, dup := existing[r.IP]; dup {
			// 已存在则更新数据
			for i, e := range current {
				if e.IP == r.IP {
					current[i].Speed = r.Speed
					current[i].Delay = r.Delay
					current[i].LossRate = r.LossRate
					current[i].Colo = r.Colo
				}
			}
			updated++
			continue
		}

		newEntry := ExcellentEntry{
			IP:        r.IP,
			Speed:     r.Speed,
			Delay:     r.Delay,
			LossRate:  r.LossRate,
			Packets:   r.Packets,
			Received:  r.Received,
			Colo:      r.Colo,
			AddedTime: now,
		}

		if len(current) < cfg.MaxSize {
			current = append(current, newEntry)
			existing[r.IP] = struct{}{}
			utils.LogInfo("[优良库] 新增: %s (速度: %.2f MB/s, 延迟: %d ms)", r.IP, r.Speed, r.Delay)
			added++
		} else {
			// 库满，找最慢且最老的IP
			idx := findSlowestOldestIndex(current)
			if idx >= 0 && newEntry.Speed > current[idx].Speed {
				utils.LogInfo("[优良库] 替换: %s (%.2f MB/s) → %s (%.2f MB/s)",
					current[idx].IP, current[idx].Speed, newEntry.IP, newEntry.Speed)
				delete(existing, current[idx].IP)
				current[idx] = newEntry
				existing[r.IP] = struct{}{}
				replaced++
			} else {
				utils.LogInfo("[优良库] 库已满(%d)且无更慢IP可替换，跳过: %s (%.2f MB/s)", cfg.MaxSize, r.IP, r.Speed)
			}
		}
	}

	qualified := added + updated + replaced
	if qualified == 0 {
		utils.LogWarn("[优良库] 本次 %d 条结果均不符合入库标准（速度需≥%.1f MB/s），优良库未变更", len(testResults), cfg.MinSpeed)
	} else {
		utils.LogInfo("[优良库] 本次筛选: %d/%d 条符合标准，新增%d 更新%d 替换%d，当前库共 %d 条",
			qualified, len(testResults), added, updated, replaced, len(current))
	}

	// 3. 写回 KV
	return saveExcellentPool(ipVersion, current)
}

// meetsExcellentStandard 判断一条测速结果是否满足入库标准
func meetsExcellentStandard(r utils.IPData) bool {
	cfg := ExcellentPoolCfg
	return r.Speed >= cfg.MinSpeed &&
		r.Delay <= int64(cfg.MaxDelay) &&
		float64(r.LossRate) <= cfg.MaxLossRate
}

// findSlowestOldestIndex 找出库中速度最慢且入库时间最早的那条记录的索引
func findSlowestOldestIndex(entries []ExcellentEntry) int {
	if len(entries) == 0 {
		return -1
	}
	// 先找出最低速度
	minSpeed := entries[0].Speed
	for _, e := range entries {
		if e.Speed < minSpeed {
			minSpeed = e.Speed
		}
	}
	// 在最慢的一批里找入库时间最早的
	idx := -1
	var oldest time.Time
	for i, e := range entries {
		if e.Speed != minSpeed {
			continue
		}
		t, err := time.ParseInLocation("2006-01-02 15:04:05", e.AddedTime, time.FixedZone("CST", 8*3600))
		if err != nil {
			// 解析失败则视为最老
			return i
		}
		if idx == -1 || t.Before(oldest) {
			oldest = t
			idx = i
		}
	}
	return idx
}

// saveExcellentPool 将优良库按速度降序排列后写入 KV
func saveExcellentPool(ipVersion string, entries []ExcellentEntry) error {
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Speed > entries[j].Speed
	})

	data, err := json.Marshal(entries)
	if err != nil {
		return fmt.Errorf("序列化优良库数据失败: %v", err)
	}

	api, err := newCloudflareKVClient()
	if err != nil {
		return fmt.Errorf("创建Cloudflare客户端失败: %v", err)
	}

	prefix := buildKeyPrefix()
	key := excellentPoolKey(prefix, ipVersion)

	if err := writeToCloudflareKV(context.Background(), api, key, string(data)); err != nil {
		return fmt.Errorf("写入优良库到KV失败: %v", err)
	}

	utils.LogInfo("[优良库] %s 优良库已更新，共 %d 条记录", ipVersion, len(entries))
	return nil
}

// ExcellentEntriesToIPText 将优良库条目转为逗号分隔的 IP 字符串，供测速使用
func ExcellentEntriesToIPText(entries []ExcellentEntry) string {
	if len(entries) == 0 {
		return ""
	}
	result := make([]string, 0, len(entries))
	for _, e := range entries {
		result = append(result, e.IP)
	}
	out := ""
	for i, ip := range result {
		if i > 0 {
			out += ","
		}
		out += ip
	}
	return out
}
