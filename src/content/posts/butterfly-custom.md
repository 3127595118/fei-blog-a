---
title: Hexo + Butterfly 主题配置笔记
published: 2026-11-12T20:30:00+08:00
updated: 2026-11-12T21:00:00+08:00
draft: false
description: 记录 Butterfly 主题的常用配置项，方便以后查阅。
image: /img/covers/butterfly-custom.webp
tags:
  - Hexo
  - Butterfly
  - 教程
category: 技术笔记
lang: zh-CN
---

## 安装主题

推荐使用 npm 安装，升级更方便：

```bash
npm install hexo-theme-butterfly --save
```

安装完成后，把主题复制到 `themes/butterfly`，再将主题目录下的 `_config.yml` 复制为根目录的 `_config.butterfly.yml`。

<!-- more -->

## 常用配置

### 导航菜单

在 `_config.butterfly.yml` 中修改 `menu`：

```yaml
menu:
  首页: / || fas fa-home
  归档: /archives/ || fas fa-archive
  分类: /categories/ || fas fa-folder-open
  标签: /tags/ || fas fa-tags
```

### 首页打字机效果

```yaml
subtitle:
  enable: true
  effect: true
  sub:
    - 永远相信美好的事情即将发生
```

### 本地搜索

先安装插件：

```bash
npm install hexo-generator-searchdb --save
```

然后在主题配置中启用：

```yaml
search:
  use: local_search
  placeholder: 搜索文章...
```

## 小结

Butterfly 的配置项非常多，建议边看[官方文档](https://butterfly.js.org/)边改，改一项刷新一次页面，方便定位问题。
