#!/usr/bin/env node
/**
 * 把构建产物中的静态资源（_astro / img / assets）同步到又拍云。
 *
 * 用法：
 *   UPYUN_SPACE=xxx UPYUN_OPERATOR=xxx UPYUN_PASSWORD=xxx \
 *   node scripts/sync-upyun.mjs [--dry-run]
 *
 * 依赖：Node 18+（内置 fetch / crypto），无需额外安装。
 */
import { createHmac } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";

const SPACE = process.env.UPYUN_SPACE;
const OPERATOR = process.env.UPYUN_OPERATOR;
const PASSWORD = process.env.UPYUN_PASSWORD;
const DRY = process.argv.includes("--dry-run");
const DIRS = ["_astro", "img", "assets"];
const ROOT = "dist";

const MIME = {
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".avif": "image/avif",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ico": "image/x-icon",
};

function die(msg) {
	console.error(`\n[upyun] ${msg}\n`);
	process.exit(1);
}

if (!DRY && (!SPACE || !OPERATOR || !PASSWORD)) {
	die("缺少环境变量：UPYUN_SPACE / UPYUN_OPERATOR / UPYUN_PASSWORD");
}

/** 又拍云 REST 签名：base64(HMAC-SHA1(method&uri&date, password)) */
function authHeader(method, uri) {
	const date = new Date().toUTCString();
	const sign = createHmac("sha1", PASSWORD)
		.update(`${method}&${uri}&${date}`)
		.digest("base64");
	return { Authorization: `UPYUN ${OPERATOR}:${sign}`, Date: date };
}

async function walk(dir, out = []) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) await walk(p, out);
		else out.push(p);
	}
	return out;
}

async function exists(remotePath, size, mtime) {
	const uri = encodeURI(`/${SPACE}${remotePath}`);
	const res = await fetch(`https://v0.api.upyun.com${uri}`, {
		method: "HEAD",
		headers: authHeader("HEAD", uri),
	});
	if (!res.ok) return false;
	// 文件大小一致即视为未变更（又拍云返回 Content-Length）
	return Number(res.headers.get("content-length")) === size;
}

async function upload(file, remotePath) {
	const uri = encodeURI(`/${SPACE}${remotePath}`);
	const body = await readFile(file);
	const res = await fetch(`https://v0.api.upyun.com${uri}`, {
		method: "PUT",
		headers: {
			...authHeader("PUT", uri),
			"Content-Type": MIME[extname(file)] || "application/octet-stream",
			// 文件名带 hash，可长期缓存
			"x-upyun-meta-cache-control": remotePath.startsWith("/img/")
				? "public, max-age=604800"
				: "public, max-age=31536000, immutable",
			// 字体跨域需要 CORS，这里同时写入源站响应头
			"x-upyun-meta-access-control-allow-origin": "*",
		},
		body,
	});
	if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
}

const files = [];
for (const d of DIRS) files.push(...(await walk(join(ROOT, d))));
if (files.length === 0) die("dist 里没有可同步的资源，先执行 pnpm build");

console.log(`[upyun] 待处理 ${files.length} 个文件 -> ${SPACE || "(dry-run)"}`);

let done = 0;
let skipped = 0;
let failed = 0;
const queue = [...files];

async function worker() {
	while (queue.length) {
		const file = queue.shift();
		const remotePath = "/" + relative(ROOT, file).split("\\").join("/");
		try {
			const st = await stat(file);
			if (DRY) {
				console.log(`  ${remotePath} (${(st.size / 1024).toFixed(1)}KB)`);
				done++;
				continue;
			}
			if (await exists(remotePath, st.size)) {
				skipped++;
				continue;
			}
			await upload(file, remotePath);
			done++;
		} catch (err) {
			failed++;
			console.error(`  ✗ ${remotePath}: ${err.message}`);
		}
	}
}

await Promise.all(Array.from({ length: 8 }, worker));
console.log(`[upyun] 完成 上传${done} 跳过${skipped} 失败${failed}`);
if (failed) process.exit(1);
