#!/usr/bin/env node
/**
 * 赛博鸡蛋 · 每日自动采摘
 *
 * 从 https://saibodan.com/ 抓取最新一期（或指定日期）的福利清单，
 * 生成 Astro 博客文章到 src/content/posts/cyber-eggs-YYYY-MM-DD.md
 *
 * 用法:
 *   node scripts/cyber-eggs.mjs                 # 抓最新一期
 *   node scripts/cyber-eggs.mjs --date 2026-11-23
 *   node scripts/cyber-eggs.mjs --force         # 已存在则覆盖
 *   node scripts/cyber-eggs.mjs --dry-run       # 只打印不写文件
 *   node scripts/cyber-eggs.mjs --limit 0       # 全量清单全部列出（默认每组 20 条）
 *
 * 环境变量:
 *   SAIBODAN_BASE   站点根地址，默认 https://saibodan.com
 *   POSTS_DIR       输出目录，默认 src/content/posts
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.SAIBODAN_BASE || "https://saibodan.com").replace(/\/$/, "");
const POSTS_DIR = resolve(ROOT, process.env.POSTS_DIR || "src/content/posts");

// ── 参数 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getFlag = (n) => argv.includes(`--${n}`);
const getOpt = (n, d = "") => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const OPT = {
	date: getOpt("date"),
	force: getFlag("force"),
	dryRun: getFlag("dry-run"),
	limit: Number(getOpt("limit", "20")),  // 全量清单每组最多列多少条，0 表示全部
};

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

// ── 工具 ────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, retries = 3) {
	for (let i = 0; i < retries; i++) {
		try {
			const res = await fetch(url, {
				headers: { "User-Agent": UA, Accept: "text/html,application/xml,*/*", "Accept-Language": "zh-CN,zh;q=0.9" },
				redirect: "follow",
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.text();
		} catch (e) {
			if (i === retries - 1) throw e;
			await sleep(800 * (i + 1));
		}
	}
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };

function decode(s) {
	return s
		.replace(/&([a-zA-Z#0-9x]+);/g, (m, k) => ENTITIES[k] ?? m)
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** 去标签 + 收空白 */
function text(html) {
	return decode(
		(html || "")
			.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
			.replace(/<br\s*\/?>/gi, " ")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/\s+/g, " ")
		.trim();
}

/** markdown 表格/正文里需要转义的字符 */
const mdText = (s) => text(s).replace(/\|/g, "\\|");

/** 去掉开头成对的括号块（支持嵌套），用于剥离台账前缀 */
function stripLeadingParen(str) {
	let t = str.trim();
	if (!t.startsWith("（") && !t.startsWith("(")) return t;
	const open = t[0];
	const close = open === "（" ? "）" : ")";
	let depth = 0;
	for (let i = 0; i < t.length; i++) {
		if (t[i] === open) depth++;
		else if (t[i] === close) {
			depth--;
			if (depth === 0) return t.slice(i + 1).replace(/^[\s；;、，,。:：]+/, "").trim();
		}
	}
	return t;
}

/**
 * 把一条台账摘要渲染成 markdown：
 *   （平台 ｜ 核验日期 ｜ 截止：…）摘要 入口： https://…
 *   → 摘要 [官方入口](https://…)
 */
function renderNote(raw, max = 100) {
	let t = text(raw);
	t = stripLeadingParen(t);
	t = stripLeadingParen(t); // 有时会有两层括号

	let url = "";
	const m = /入口[：:]\s*(https?:\/\/\S+)\s*$/.exec(t);
	if (m) {
		url = m[1];
		t = t.slice(0, m.index).trim();
	}
	t = t.replace(/[；;、，,\s]+$/, "").replace(/^[；;、，,。:：]+/, "").trim();
	if (t.length > max) t = `${t.slice(0, max)}…`;

	if (t && url) return `${t}（[入口](${url})）`;
	if (url) return `[官方入口](${url})`;
	return t;
}

// ── 解析 ────────────────────────────────────────────────
async function listEpisodes() {
	const xml = await fetchText(`${BASE}/sitemap.xml`);
	const dates = [...xml.matchAll(/\/episodes\/deals-(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
	return [...new Set(dates)].sort().reverse();
}

/** 解析单个 <section class="deal"> 块 */
function parseDeals(html) {
	const out = [];
	for (const m of html.matchAll(/<section class="deal">([\s\S]*?)<\/section>/g)) {
		const block = m[1];
		const titleRaw = /<h3[^>]*class="deal-title"[^>]*>([\s\S]*?)<\/h3>/.exec(block)?.[1] ?? "";
		const title = text(titleRaw).replace(/^\d+[.、]\s*/, "");
		if (!title) continue;

		const fields = {};
		for (const li of block.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
			const lb = /<span class="lb"[^>]*>([\s\S]*?)<\/span>/.exec(li[1])?.[1] ?? "";
			const vl = /<span class="vl"[^>]*>([\s\S]*?)<\/span>/.exec(li[1])?.[1] ?? "";
			if (!lb) continue;
			fields[text(lb)] = vl;
		}
		const href = /<a[^>]+href="([^"]+)"[^>]*class="raw-url"/.exec(block)?.[1] || /<a[^>]+href="(https?:[^"]+)"/.exec(block)?.[1] || "";
		out.push({
			title,
			desc: text(fields["上屏文案"] || ""),
			gain: text(fields["能拿到"] || "") || text(fields["上屏文案"] || ""),
			cond: text(fields["领取条件与限制"] || "") || text(fields["条件"] || ""),
			deadline: text(fields["截止"] || "") || "官方未标注",
			url: href.replace(/&amp;/g, "&"),
		});
	}
	return out;
}

/** 解析「二、本期在售全量」里的分类列表 */
function parseCatalog(html) {
	const start = html.search(/本期在售全量/);
	if (start < 0) return { groups: [], total: 0 };
	const tail = html.slice(start);
	const total = Number(/本期在售全量（(\d+)\s*条）/.exec(tail)?.[1] ?? 0) || 0;

	// 以 <h3 class="cat"> 为分隔，逐个取其后第一个 <ul>…</ul>
	const groups = [];
	const parts = [...tail.matchAll(/<h3[^>]*class="cat"[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<h3[^>]*class="cat"|<footer|<\/body|$)/g)];
	for (const p of parts) {
		const name = text(p[1]).replace(/\s*[（(]\d+\s*条[)）]\s*$/, "");
		const items = [];
		for (const li of p[2].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
			const strong = /<strong[^>]*>([\s\S]*?)<\/strong>/.exec(li[1])?.[1];
			if (strong) {
				const rest = text(li[1].replace(/<strong[\s\S]*?<\/strong>/, "")).replace(/^[：:]\s*/, "");
				items.push({ title: text(strong), note: rest });
			} else {
				const t = text(li[1]);
				if (t) items.push({ title: t, note: "" });
			}
		}
		if (items.length) groups.push({ name, items });
	}
	return { groups, total };
}

function parseEpisode(html) {
	const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";
	const title = text(h1).replace(/【赛博鸡蛋】\s*$/, "").trim();
	const meta = text(/<p class="meta"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "");

	// 本期重点（卡片里的链接）
	const highlights = [];
	const card = /<div class="card">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
	for (const a of card.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
		highlights.push({ title: text(a[2]), url: a[1] });
	}

	const deals = parseDeals(html);
	const catalog = parseCatalog(html);
	const dateMatch = /(\d{4}-\d{2}-\d{2})/.exec(html) || /deals-(\d{4}-\d{2}-\d{2})/.exec(html);
	return { title, meta, highlights, deals, catalog, date: dateMatch?.[1] ?? "" };
}

// ── 生成 ────────────────────────────────────────────────
function makeSlug(date) {
	return `cyber-eggs-${date}`;
}

function buildMarkdown({ date, title, meta, highlights, deals, catalog }) {
	// 统一用 +08:00 本地格式，与站内既有文章的写法保持一致
	const stamp = `${date}T09:00:00+08:00`;
	const lines = [];

	const desc =
		deals.length > 0
			? `赛博鸡蛋 ${date} 期：${deals
					.slice(0, 3)
					.map((d) => d.title.split("：")[0])
					.join("、")}${catalog.groups.length ? `，本期在售 ${catalog.total || "若干"} 条` : ""}。`
			: `赛博鸡蛋 ${date} 期每日 AI 福利与免费额度汇总。`;

	lines.push(
		"---",
		`title: ${JSON.stringify(`赛博鸡蛋 · ${date}：${title.split("；")[0].slice(0, 60)}`)}`,
		`published: ${stamp}`,
		`updated: ${stamp}`,
		"draft: false",
		`description: ${JSON.stringify(desc)}`,
		"tags:",
		"  - 赛博鸡蛋",
		"  - AI额度",
		"  - 白嫖",
		"category: 赛博鸡蛋",
		"lang: zh-CN",
		`sourceLink: ${JSON.stringify(`${BASE}/episodes/deals-${date}`)}`,
		"comment: true",
		"---",
		"",
	);

	lines.push("> 本文由 `scripts/cyber-eggs.mjs` 每日自动采摘自 [赛博鸡蛋](" + BASE + ")，以官方活动页为准。", "");

	if (meta) lines.push(`**${meta}**`, "");

	// 速览表
	if (deals.length) {
		lines.push("## 今日速览", "", "| 项目 | 能拿到 | 截止 |", "| --- | --- | --- |");
		for (const d of deals) {
			lines.push(`| ${mdText(d.title)} | ${mdText(d.gain).slice(0, 60)} | ${mdText(d.deadline).slice(0, 40)} |`);
		}
		lines.push("");
	}

	// 推荐详情
	if (deals.length) {
		lines.push("## 上首页的推荐", "");
		for (const [i, d] of deals.entries()) {
			lines.push(`### ${i + 1}. ${d.title}`, "");
			if (d.desc) lines.push(d.desc, "");
			lines.push(`- **能拿到**：${d.gain || "—"}`, `- **截止**：${d.deadline}`);
			if (d.cond) lines.push(`- **条件与限制**：${d.cond}`);
			if (d.url) lines.push(`- **官方入口**：[${d.url.replace(/^https?:\/\//, "").slice(0, 60)}](${d.url})`);
			lines.push("");
		}
	}

	// 变动 + 全量
	const deltaGroups = catalog.groups.filter((g) => ["新增", "调整", "结束"].includes(g.name));
	const areaGroups = catalog.groups.filter((g) => !["新增", "调整", "结束"].includes(g.name));

	if (deltaGroups.length) {
		lines.push("## 本期变动", "");
		for (const g of deltaGroups) {
			lines.push(`### ${g.name}（${g.items.length}）`, "");
			for (const it of g.items) {
				lines.push(`- **${it.title}**${it.note ? `：${renderNote(it.note)}` : ""}`);
			}
			lines.push("");
		}
	}

	if (areaGroups.length) {
		lines.push("## 在售全量清单", "", `<details><summary>展开 ${catalog.total || ""} 条（国内 / 海外）</summary>`, "");
		for (const g of areaGroups) {
			const items = OPT.limit ? g.items.slice(0, OPT.limit) : g.items;
			lines.push(`### ${g.name}（${g.items.length}）`, "");
			for (const it of items) {
				lines.push(`- **${it.title}**${it.note ? `：${renderNote(it.note)}` : ""}`);
			}
			if (OPT.limit && g.items.length > OPT.limit) {
				lines.push(`- …… 其余 ${g.items.length - OPT.limit} 条见[原页](${BASE}/episodes/deals-${date})`);
			}
			lines.push("");
		}
		lines.push("</details>", "");
	}

	lines.push("## 领取提醒", "");
	lines.push(
		"- 免费额度基本都要**实名认证**，介意就跳过",
		"- 免费模型一般有并发/速率限制，别拿去跑线上服务",
		"- 截止时间以官方活动页为准，第三方汇总可能滞后",
		"- 领取前确认账号没有被风控，批量注册容易连坐",
		"",
	);

	lines.push("## 信息来源", "", `- [赛博鸡蛋 · ${date} 期](${BASE}/episodes/deals-${date})`, `- [赛博鸡蛋首页](${BASE}/)`, "");
	lines.push("> 赛博鸡蛋每天自动更新，捡到好的欢迎在评论区投喂。", "");

	return lines.join("\n");
}

// ── 主流程 ──────────────────────────────────────────────
async function main() {
	console.log(`[赛博鸡蛋] 站点 ${BASE}`);

	let date = OPT.date;
	if (!date) {
		const dates = await listEpisodes();
		if (!dates.length) throw new Error("sitemap 里没找到 episodes，站点结构可能变了");
		date = dates[0];
		console.log(`[赛博鸡蛋] 最新一期 ${date}（共 ${dates.length} 期可抓）`);
	} else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error(`--date 格式应为 YYYY-MM-DD，收到: ${date}`);
	}

	const outFile = `${makeSlug(date)}.md`;
	const outPath = resolve(POSTS_DIR, outFile);

	if (existsSync(outPath) && !OPT.force) {
		console.log(`[赛博鸡蛋] ${outFile} 已存在，跳过（--force 可覆盖）`);
		return;
	}

	const url = `${BASE}/episodes/deals-${date}`;
	console.log(`[赛博鸡蛋] 抓取 ${url}`);
	const html = await fetchText(url);

	const ep = parseEpisode(html);
	if (!ep.deals.length && !ep.catalog.groups.length) {
		throw new Error("解析结果为空，页面结构可能变了");
	}
	ep.date = date;

	console.log(`[赛博鸡蛋] 推荐 ${ep.deals.length} 条 / 清单分组 ${ep.catalog.groups.length} 个 / 共 ${ep.catalog.total} 条`);

	const md = buildMarkdown({ ...ep, date });

	if (OPT.dryRun) {
		console.log("\n──── 预览（前 2000 字符）────\n");
		console.log(md.slice(0, 2000));
		console.log(`\n──── 全文 ${md.length} 字符 ────`);
		return;
	}

	mkdirSync(POSTS_DIR, { recursive: true });
	writeFileSync(outPath, md, "utf-8");
	console.log(`[赛博鸡蛋] 已写入 ${outPath}（${md.length} 字符）`);
}

main().catch((e) => {
	console.error("[赛博鸡蛋] 失败:", e.message);
	process.exit(1);
});
