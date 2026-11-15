import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let sharp;
try {
	sharp = require("sharp");
} catch {
	// sharp 只装在全局，pnpm 项目里没有直接依赖
	sharp = require(`${execSync("npm root -g").toString().trim()}/sharp`);
}

/**
 * 生成「虚化背景 + 大字标题」封面（参考 sumi233 风格）
 * 用法：node scripts/make-cover.mjs <背景图> <大标题> <副标题> <输出.webp>
 */
const [, , bgPath, title, subtitle = "", outPath = "cover.webp"] = process.argv;

const W = 1200;
const H = 675;
const FONT = "Noto Sans CJK SC";

/** 按字符宽度粗略折行：中文按 1 个字宽，英文按 0.55 个字宽 */
function wrapText(text, maxUnitsPerLine) {
	const lines = [];
	let cur = "";
	let units = 0;
	for (const ch of Array.from(text)) {
		const u = /[\x00-\xff]/.test(ch) ? 0.55 : 1;
		if (units + u > maxUnitsPerLine && cur) {
			lines.push(cur);
			cur = ch;
			units = u;
		} else {
			cur += ch;
			units += u;
		}
	}
	if (cur) lines.push(cur);
	return lines;
}

const lines = wrapText(title, 6);
const size = lines.length > 1 ? 108 : 150;
const lineH = size * 1.18;

const svg = `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="14" flood-color="rgba(0,0,0,0.55)"/>
    </filter>
    <radialGradient id="vignette" cx="50%" cy="50%" r="62%">
      <stop offset="0%" stop-color="rgba(0,0,0,0.34)"/>
      <stop offset="70%" stop-color="rgba(0,0,0,0.14)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.06)"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="rgba(0,0,0,0.14)"/>
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
  <g filter="url(#shadow)" text-anchor="middle"
     font-family="${FONT}" font-weight="900" fill="#ffffff">
    ${lines
			.map(
				(l, i) =>
					`<text x="${W / 2}" y="${H / 2 - ((lines.length - 1) * lineH) / 2 + i * lineH + size * 0.35}" font-size="${size}" letter-spacing="6">${l}</text>`,
			)
			.join("\n    ")}
    ${
			subtitle
				? `<text x="${W / 2}" y="${H / 2 + ((lines.length - 1) * lineH) / 2 + size * 0.35 + 62}" font-size="34" font-weight="500" letter-spacing="4" fill="rgba(255,255,255,0.92)">${subtitle}</text>`
				: ""
		}
    <text x="${W - 34}" y="${H - 28}" font-size="24" font-weight="500" fill="rgba(255,255,255,0.72)" text-anchor="end">@Fei'Blog</text>
  </g>
</svg>`;

// AI 生图右下角有「AI生成」水印，先裁掉底部 6%
const src = sharp(readFileSync(bgPath));
const meta = await src.metadata();
const cropped = await src
	.extract({
		left: 0,
		top: 0,
		width: meta.width,
		height: Math.round(meta.height * 0.94),
	})
	.toBuffer();

const bg = await sharp(cropped)
	.resize(W, H, { fit: "cover" })
	.blur(6)
	.modulate({ brightness: 0.92 })
	.toBuffer();

await sharp(bg)
	.composite([{ input: Buffer.from(svg) }])
	.webp({ quality: 82 })
	.toFile(outPath);

const bytes = statSync(outPath).size;
console.log(`${outPath} ${(bytes / 1024).toFixed(0)}KB ${W}x${H} lines=${lines.length}`);
