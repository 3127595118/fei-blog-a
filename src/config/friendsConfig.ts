import type { FriendLink, FriendsPageConfig } from "../types/friendsConfig";

// 可以在src/content/spec/friends.md中编写友链页面下方的自定义内容

// 友链页面配置
export const friendsPageConfig: FriendsPageConfig = {
	// 页面标题，如果留空则使用 i18n 中的翻译
	title: "",

	// 页面描述文本，如果留空则使用 i18n 中的翻译
	description: "",

	// 是否显示底部自定义内容（friends.mdx 中的内容）
	showCustomContent: true,

	// 是否显示评论区，需要先在commentConfig.ts启用评论系统
	showComment: true,

	// 是否开启随机排序配置，如果开启，就会忽略权重，构建时进行一次随机排序
	randomizeSort: false,
};

// 友链配置
export const friendsConfig: FriendLink[] = [
	{
		title: "Butterfly",
		imgurl: "https://butterfly.js.org/favicon.ico",
		desc: "漂亮又强大的 Hexo 主题",
		siteurl: "https://butterfly.js.org/",
		tags: ["Blog"],
		weight: 10,
		enabled: true,
	},
	{
		title: "Hexo",
		imgurl: "https://hexo.io/favicon.ico",
		desc: "快速、简洁且高效的博客框架",
		siteurl: "https://hexo.io/",
		tags: ["Blog"],
		weight: 9,
		enabled: true,
	},
	{
		title: "Fomalhaut",
		imgurl: "https://www.fomal.cc/favicon.ico",
		desc: "本站的灵感来源",
		siteurl: "https://www.fomal.cc/",
		tags: ["Blog"],
		weight: 8,
		enabled: true,
	},
];

// 获取启用的友链并进行排序
export const getEnabledFriends = (): FriendLink[] => {
	const friends = friendsConfig.filter((friend) => friend.enabled);

	if (friendsPageConfig.randomizeSort) {
		return friends.sort(() => Math.random() - 0.5);
	}

	return friends.sort((a, b) => b.weight - a.weight);
};
