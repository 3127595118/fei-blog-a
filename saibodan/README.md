# 赛博鸡蛋 · 采集器（跑在 GitHub Actions 里，不需要服务器）

这个目录是「赛博鸡蛋」福利库的采集与前端。每天 **北京时间 07:30**，`.github/workflows/cyber-eggs-daily.yml`
会自动跑一次：

1. `collector/collect.py` 按 `collector/sources.json` 逐条抓官方页面，做关键词命中 + 内容指纹比对
2. 生成 `web/data/deals.json`（前端数据）和 `src/content/posts/cyber-eggs-<日期>.md`（博客文章）
3. 把变化提交回本仓库 → EdgeOne 自动重建博客，GitHub Pages 自动更新福利库站点

## 目录

```
saibodan/
├── collector/
│   ├── collect.py      # 采集 + 核验 + 生成数据与文章
│   ├── blog.py         # 文章模板（fuwari/通用）、RSS、发布适配器
│   └── sources.json    # 源清单：加福利就改这里
├── web/                # 静态前端（GitHub Pages 根目录）
│   ├── index.html
│   ├── blog.config.json
│   └── data/deals.json # 采集产物
└── state/snapshots.json # 指纹快照 + 变更历史（用于判断「今天变了什么」）
```

## 加一条福利

编辑 `collector/sources.json`，往 `sources` 数组里加：

```json
{
  "id": "my-free-api",
  "vendor": "某厂商",
  "title": "免费档：每月 100 万 tokens",
  "url": "https://official.example.com/pricing",
  "region": "cn",
  "type": "free",
  "group": "free_api",
  "value": 7.5,
  "gets": "能拿到什么（写清数量和限制）",
  "cond": "领取条件（实名？绑卡？数据用于训练？）",
  "deadline": "官方未写截止日",
  "keywords": ["免费", "free"],
  "end_keywords": ["活动结束"]
}
```

## 手动跑一次

仓库 Actions 页面 → 赛博鸡蛋日报 → Run workflow。或者本地：

```bash
python3 saibodan/collector/collect.py --limit 5 --dry-run   # 只测前 5 条
```

## 判定规则

- `keywords` 一个都没命中 → 标「待核验」，不假报可用
- 正文少于 200 字符（前端渲染/反爬）→ 标「待核验」
- `end_keywords` 命中且 `keywords` 全不命中 → 判「已结束」
- 指纹变化 → 记一条「变更」，写清变在哪一句
