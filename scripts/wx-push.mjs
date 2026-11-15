// 微信提醒：通过 PushPlus 一对一推送
// 用法：PUSHPLUS_TOKEN=xxx node scripts/wx-push.mjs "标题" "内容(支持html)" "可选跳转链接"
const token = process.env.PUSHPLUS_TOKEN;
if (!token) {
	console.error("缺少 PUSHPLUS_TOKEN");
	process.exit(1);
}

const [title = "Fei'Blog 提醒", content = "", url = ""] = process.argv.slice(2);

const res = await fetch("https://www.pushplus.plus/send", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
		token,
		title,
		content,
		template: "html",
		...(url ? { url } : {}),
	}),
});

const data = await res.json().catch(() => ({}));
if (data.code !== 200) {
	console.error("推送失败:", JSON.stringify(data));
	process.exit(1);
}
console.log("推送成功:", data.data || data.msg);
