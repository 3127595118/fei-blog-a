import type { AnnouncementConfig } from "../types/announcementConfig";

export const announcementConfig: AnnouncementConfig = {
	// 公告标题，留空则走i18n默认标题
	title: "欢迎来到 Fei'Blog",

	// 公告内容（同时用于侧边栏公告卡片与首次进入的弹窗）
	content:
		"这里是 Fei 的小站，记录生活与代码。文章持续更新中，欢迎随便逛逛。",

	// 是否允许用户关闭公告
	closable: true,

	link: {
		// 启用链接
		enable: true,
		// 链接文本
		text: "了解更多",
		// 链接 URL
		url: "/about/",
		// 内部链接
		external: false,
	},
};
