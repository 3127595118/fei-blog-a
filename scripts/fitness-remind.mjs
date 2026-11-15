// 训练提醒：读取云端数据后决定是否推送
// 用法：node scripts/fitness-remind.mjs train|log|weekly
// 需要环境变量：FITNESS_KEY、PUSHPLUS_TOKEN
const API = process.env.FITNESS_API || "https://feimy.xyz/api/fitness";
const FITNESS_KEY = process.env.FITNESS_KEY;
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN;
const PAGE = "https://feimy.xyz/fitness/";
const mode = process.argv[2] || "train";

const PLAN = {
	0: { type: "休息", name: "完全休息", items: [["睡够 8 小时", ""], ["提前备好下周早餐", ""]] },
	1: { type: "力量 A", name: "全身 A · 推 + 蹲", items: [["哑铃卧推", "4×8–12"], ["高脚杯深蹲", "4×10–12"], ["坐姿哑铃肩推", "3×8–12"], ["保加利亚分腿蹲", "3×8–10/侧"], ["死虫", "3×10/侧"]] },
	2: { type: "有氧", name: "有氧日 · 快走", items: [["快走 25 分钟", ""], ["拉伸 10 分钟", ""]] },
	3: { type: "力量 B", name: "全身 B · 拉 + 髋", items: [["引体 / 弹力带辅助", "4×6–10"], ["罗马尼亚硬拉", "4×10–12"], ["单臂划船", "3×10–12/侧"], ["反向飞鸟", "3×12–15"], ["侧平板", "3×30 秒/侧"]] },
	4: { type: "休息", name: "完全休息", items: [["睡够 7–8 小时", ""], ["散步 20 分钟（可选）", ""]] },
	5: { type: "力量 C", name: "全身 C · 混合 + 核心", items: [["哑铃硬拉", "4×8"], ["弓箭步走", "3×12/侧"], ["俯卧撑", "3×力竭前2"], ["哑铃弯举", "3×10–12"], ["农夫行走", "3×40 秒"]] },
	6: { type: "有氧", name: "有氧日 · 轻活动", items: [["快走 25 分钟", ""], ["平板支撑", "3×45 秒"]] },
};
const TRAINING_DAYS = [1, 3, 5];

function todayInShanghai() {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
}

function shanghaiWeekday() {
	const name = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		weekday: "short",
	}).format(new Date());
	return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

async function fetchState() {
	const res = await fetch(`${API}?key=${encodeURIComponent(FITNESS_KEY)}`, {
		headers: { "x-fitness-key": FITNESS_KEY },
	});
	const data = await res.json();
	if (!data.ok) throw new Error(data.error || "读取失败");
	return data;
}

async function push(title, content) {
	if (!PUSHPLUS_TOKEN) throw new Error("缺少 PUSHPLUS_TOKEN");
	const res = await fetch("https://www.pushplus.plus/send", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			token: PUSHPLUS_TOKEN,
			title,
			content,
			template: "html",
			url: PAGE,
		}),
	});
	const data = await res.json();
	if (data.code !== 200) throw new Error(JSON.stringify(data));
	console.log("推送成功:", data.msg || data.code);
}

async function main() {
	const date = todayInShanghai();
	const weekday = shanghaiWeekday();
	const plan = PLAN[weekday];

	if (mode === "train") {
		if (!TRAINING_DAYS.includes(weekday)) {
			console.log(`今天 ${plan.type}，不推送训练提醒`);
			return;
		}
		const list = plan.items
			.map(([name, sets]) => `<li>${name}${sets ? ` <span style="color:#999">${sets}</span>` : ""}</li>`)
			.join("");
		await push(
			`今天练 ${plan.name}`,
			`<p>下班回家先加餐，19:10 开始，40 分钟结束。</p><ul>${list}</ul><p style="color:#999">练完记得在页面记录重量和次数。</p>`,
		);
		return;
	}

	if (mode === "log") {
		const { state } = await fetchState();
		const todayLogs = (state.logs || []).filter((l) => l.date === date);
		const todayItems = Object.keys((state.items || {})[date] || {}).length;
		if (todayLogs.length || todayItems > 0) {
			console.log(`今天已记录 ${todayLogs.length} 条，跳过催促`);
			return;
		}
		await push(
			"今天还没记录训练",
			`<p>${date} 的训练和体重都还没记。</p><p>花 30 秒补一下：动作重量、体重、腰围。</p>`,
		);
		return;
	}

	if (mode === "weekly") {
		const { state } = await fetchState();
		const date7 = new Date(`${date}T00:00:00+08:00`);
		const dow = shanghaiWeekday() === 0 ? 7 : shanghaiWeekday();
		const monday = new Date(date7);
		monday.setDate(date7.getDate() - (dow - 1));
		const weekKeys = [];
		for (let i = 0; i < 7; i++) {
			const d = new Date(monday);
			d.setDate(monday.getDate() + i);
			weekKeys.push(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(d));
		}
		const doneDays = TRAINING_DAYS.filter((i) => state.checks?.[weekKeys[i - 1]]).length;
		const weights = (state.weights || []).slice(-1)[0];
		const weekLogs = (state.logs || []).filter((l) => weekKeys.includes(l.date)).length;
		await push(
			"本周复盘",
			`<p>本周完成训练 <b>${doneDays}/3</b> 天，记录 ${weekLogs} 条。</p>` +
				`<p>最新体重：<b>${weights ? weights.kg + " kg" : "未记录"}</b>${weights?.waist ? `，腰围 ${weights.waist} cm` : ""}</p>` +
				`<p>现在量一下腰围、拍张对比照，再称个体重。</p>`,
		);
		return;
	}

	console.error("未知模式:", mode);
	process.exit(1);
}

main().catch((error) => {
	console.error("失败:", error.message);
	process.exit(1);
});
