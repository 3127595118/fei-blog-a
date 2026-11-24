#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
赛博鸡蛋 · 博客对接层（纯标准库）

两个方向：
  pull  —— 读你博客的 RSS/Atom，取最新文章放到站点「我的博客」区块（引流入口）
  push  —— 把每日日报发到你博客，四种后端任选：wordpress / webhook / git / local

配置全部走环境变量（.env），见 .env.example：
  BLOG_KIND=wordpress|webhook|git|local|none
  BLOG_RSS_URL=https://your-blog.com/feed.xml
  BLOG_SITE_URL=https://your-blog.com
  WP_BASE=https://your-blog.com           # WordPress
  WP_USER=admin
  WP_APP_PASSWORD=xxxx xxxx xxxx xxxx     # 后台「应用密码」，不是登录密码
  WP_CATEGORY=赛博鸡蛋
  WEBHOOK_URL=https://...                 # 任意能收 JSON 的地址（含腾讯云函数/企业微信机器人）
  BLOG_GIT_DIR=/srv/blog                       # Hexo/Hugo/Astro 仓库本地路径
  BLOG_GIT_POST_DIR=source/_posts              # 相对仓库的 Markdown 目录
  BLOG_GIT_BRANCH=main
"""
import base64
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

TZ = timezone(timedelta(hours=8))
UA = "Mozilla/5.0 (compatible; CyberEggBot/1.0)"


def env(k, d=""):
    v = os.environ.get(k)
    return v.strip() if v and v.strip() else d


def _req(url, data=None, headers=None, method=None, timeout=20):
    body = None
    h = {"User-Agent": UA, "Accept": "application/json,text/xml,*/*"}
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        h["Content-Type"] = "application/json; charset=utf-8"
    h.update(headers or {})
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


# ------------------------------------------------------------------ pull
def fetch_rss(url, limit=6):
    """解析 RSS 2.0 / Atom，返回 [{title, link, date}]"""
    try:
        status, raw = _req(url, timeout=20)
    except Exception:
        return []
    if status >= 400:
        return []

    def pick(block, tags):
        for t in tags:
            m = re.search(r"(?is)<%s[^>]*>(.*?)</%s>" % (t, t), block)
            if m:
                v = m.group(1)
                v = re.sub(r"(?s)^<!\[CDATA\[(.*?)\]\]>$", r"\1", v.strip())
                v = re.sub(r"(?s)<[^>]+>", "", v)
                return v.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").strip()
        return ""

    posts = []
    for m in re.finditer(r"(?is)<item>(.*?)</item>", raw):
        b = m.group(1)
        posts.append({"title": pick(b, ["title"]), "link": pick(b, ["link", "guid"]),
                      "date": pick(b, ["pubDate", "dc:date"])[:16]})
    if not posts:
        for m in re.finditer(r"(?is)<entry>(.*?)</entry>", raw):
            b = m.group(1)
            link_m = re.search(r'(?is)<link[^>]*href="([^"]+)"', b)
            posts.append({"title": pick(b, ["title"]),
                          "link": link_m.group(1) if link_m else "",
                          "date": pick(b, ["updated", "published"])[:16]})
    posts = [p for p in posts if p["title"]]
    return posts[:limit]


# ------------------------------------------------------------------ 日报
def build_markdown(payload, site_url=""):
    st = payload["stats"]
    day = payload["generated_day"]
    lines = ["---",
             "title: 赛博鸡蛋日报 · %s" % day,
             "date: %s" % day,
             "tags: [赛博鸡蛋, AI福利, 免费额度]",
             "---",
             "",
             "> 今日核验 %d 条：新增 %d · 变更 %d · 待核验 %d · 已结束 %d"
             % (st["total"], st["today_new"], st["today_updated"], st["pending"], st["ended"]),
             ""]

    def block(title, items, empty):
        lines.append("## " + title)
        if not items:
            lines.append(empty)
            lines.append("")
            return
        for d in items:
            lines.append("### [%s](%s)" % (d["title"], d["url"]))
            lines.append("- **能拿到**：%s" % d["gets"])
            lines.append("- **条件**：%s" % d["cond"])
            lines.append("- **期限**：%s" % d["deadline"])
            lines.append("- 核验：%s · HTTP %s · %s" % (d["check"]["at"], d["check"]["http"], d["status_label"]))
            lines.append("")
        lines.append("")

    day = payload["generated_day"]
    new = [d for d in payload["deals"] if d.get("first_seen") == day
           and d["status"] in ("new", "active", "updated")]
    upd = [d for d in payload["deals"] if d["status"] == "updated" and d.get("first_seen") != day]
    bad = [d for d in payload["deals"] if d["status"] == "pending"]
    end = [d for d in payload["deals"] if d["status"] == "ended"]

    block("今日新增", new, "今天没有新增条目。")
    block("今日变更", upd, "今天没有条目发生变动。")
    block("需要人工复核", bad, "全部核验通过。")
    block("已结束", end, "没有条目结束。")

    if site_url:
        lines.append("---")
        lines.append("完整福利库与排行榜：[%s](%s)" % (site_url, site_url))
    lines.append("")
    lines.append("_本日报由赛博鸡蛋采集器自动生成于 %s（北京时间）_"
                 % datetime.now(TZ).strftime("%Y-%m-%d %H:%M"))
    return "\n".join(lines)


# ------------------------------------------------------------------ Fuwari / Astro 文章
GROUP_TITLES = {"free_api": "免费 API", "tool": "工具与客户端", "media": "多媒体生成",
                "paid": "低价付费", "id": "身份专享"}


def _q(s):
    """YAML 双引号安全字符串"""
    return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'


def build_fuwari_post(payload, site_url="", source_link=""):
    """生成 Fuwari(Astro) 博客可用的文章：front-matter 严格对齐 src/content.config.ts 的 posts schema"""
    st = payload["stats"]
    day = payload["generated_day"]
    t = datetime.now(TZ)
    stamp = t.strftime("%Y-%m-%dT%H:%M:%S+08:00")
    deals = payload["deals"]
    usable = [d for d in deals if d["status"] in ("new", "active", "updated")]
    usable.sort(key=lambda d: -d["value"])
    lead = usable[0]["vendor"] if usable else "今日无新增"
    title = "赛博鸡蛋 · %s：%s 等 %d 条免费额度已核验" % (day, lead, len(usable))
    desc = "赛博鸡蛋 %s 期：本期收录 %d 条免费 AI 福利，可用 %d 条、今日变动 %d 条、待核验 %d 条，逐条核验官方页面。" % (
        day, st["total"], len(usable), st["today_updated"], st["pending"])

    L = []
    L.append("---")
    L.append("title: " + _q(title))
    L.append("published: " + stamp)
    L.append("updated: " + stamp)
    L.append("draft: false")
    L.append("description: " + _q(desc))
    L.append("tags:")
    L.append("  - 赛博鸡蛋")
    L.append("  - AI额度")
    L.append("  - 白嫖")
    L.append("category: 赛博鸡蛋")
    L.append("lang: zh-CN")
    L.append("sourceLink: " + _q(source_link or site_url or ""))
    L.append("comment: true")
    L.append("---")
    L.append("")
    L.append("> 本文由赛博鸡蛋采集器每日自动核验官方页面生成，只收录官方公开、能自己领到的额度；"
             "变了的会标出来，抓不到就标「待核验」而不是删掉。" + ("全站福利库：[%s](%s)" % (site_url, site_url) if site_url else ""))
    L.append("")
    L.append("**%d 月 %d 日 · 在库 %d 条 · 可用 %d 条 · 核验时间 %s（北京时间）**"
             % (t.month, t.day, st["total"], len(usable), payload["generated_at"]))
    L.append("")

    L.append("## 今日速览")
    L.append("")
    L.append("| 项目 | 能拿到 | 截止 | 状态 |")
    L.append("| --- | --- | --- | --- |")
    for d in usable[:8]:
        L.append("| %s | %s | %s | %s |" % (
            (d["vendor"] + "：" + d["title"]).replace("|", "\\|"),
            d["gets"].replace("|", "\\|"),
            d["deadline"].replace("|", "\\|"),
            d["status_label"]))
    L.append("")

    for gkey, gtitle in GROUP_TITLES.items():
        items = [d for d in usable if d["group"] == gkey][:6]
        if not items:
            continue
        L.append("## " + gtitle)
        L.append("")
        for i, d in enumerate(items, 1):
            L.append("### %d. %s：%s" % (i, d["vendor"], d["title"]))
            L.append("")
            L.append("- **能拿到**：" + d["gets"])
            L.append("- **截止**：" + d["deadline"])
            L.append("- **条件与限制**：" + d["cond"])
            L.append("- **官方入口**：[%s](%s)" % (d["url"].split("//")[-1][:48], d["url"]))
            L.append("- **核验**：%s · HTTP %s · %s" % (d["check"]["at"], d["check"]["http"], d["status_label"]))
            L.append("")

    upd = [d for d in deals if d["status"] == "updated" and d.get("first_seen") != day]
    L.append("## 今日变化")
    L.append("")
    if upd:
        for d in upd:
            note = d["history"][0]["note"] if d["history"] else "页面内容有变"
            L.append("- **%s · %s**：%s" % (d["vendor"], d["title"], note))
    else:
        L.append("今天没有条目发生变动。")
    L.append("")

    bad = [d for d in deals if d["status"] == "pending"]
    L.append("## 需要人工复核")
    L.append("")
    if bad:
        L.append("下面这些官方页抓不到正文或没命中关键词，**不保证还能领**，请点官方页自己看一眼：")
        L.append("")
        for d in bad:
            reason = d["history"][0]["note"] if d["history"] else "核验未通过"
            L.append("- %s · %s（%s）" % (d["vendor"], d["title"], reason))
    else:
        L.append("全部核验通过。")
    L.append("")

    end = [d for d in deals if d["status"] == "ended"]
    L.append("## 已结束")
    L.append("")
    if end:
        for d in end:
            note = d["history"][0]["note"] if d["history"] else "官方页面已标记结束"
            L.append("- %s · %s（%s）" % (d["vendor"], d["title"], note))
    else:
        L.append("没有条目结束。")
    L.append("")

    L.append("---")
    L.append("")
    L.append("_采集器运行于 %s；本页 %d 条源，可用 %d · 今日变动 %d · 待核验 %d · 已结束 %d。"
             "以官方页面为准。_" % (payload["generated_at"], st["total"], len(usable),
                                   st["today_updated"], st["pending"], st["ended"]))
    L.append("")
    return "\n".join(L)


# ------------------------------------------------------------------ GitHub API（免 clone）
def _publish_github_api(md, day):
    """用 GitHub Contents API 直接提交文章：适合云函数、无 git 环境的机器"""
    token = env("BLOG_GH_TOKEN") or env("GITHUB_TOKEN") or env("BLOG_GIT_TOKEN")
    repo = env("BLOG_GH_REPO", "3127595118/fei-blog-a")
    branch = env("BLOG_GH_BRANCH", "main")
    directory = env("BLOG_GH_DIR", "src/content/posts").strip("/")
    tpl = env("BLOG_GH_FILENAME", "cyber-eggs-{date}.md")
    name = tpl.replace("{date}", day).replace("{name}", "cyber-eggs-daily")
    if not name.endswith(".md"):
        name += ".md"
    path = "%s/%s" % (directory, name)
    if not token:
        return False, "缺 BLOG_GH_TOKEN"

    api = "https://api.github.com/repos/%s/contents/%s" % (repo, path)
    hdr = {"Authorization": "Bearer " + token, "Accept": "application/vnd.github+json",
           "User-Agent": "cyber-eggs", "X-GitHub-Api-Version": "2022-11-28"}

    sha = ""
    try:
        _, body = _req(api + "?ref=" + branch, headers=hdr)
        sha = json.loads(body).get("sha", "")
    except urllib.error.HTTPError as e:
        if e.code != 404:
            return False, "读现有文件失败 HTTP %s" % e.code
    except Exception:
        pass

    payload = {"message": env("BLOG_GH_MESSAGE", "chore(cyber-eggs): 日报 %s" % day),
               "content": base64.b64encode(md.encode("utf-8")).decode(),
               "branch": branch}
    if sha:
        payload["sha"] = sha
    try:
        status, body = _req(api, data=payload, headers=hdr, method="PUT")
    except urllib.error.HTTPError as e:
        return False, "提交失败 HTTP %s %s" % (e.code, (e.read() or b"")[:160])
    except Exception as e:
        return False, "提交异常 %s" % e
    if status in (200, 201):
        try:
            return True, "%s · %s" % (path, json.loads(body)["commit"]["sha"][:8])
        except Exception:
            return True, path
    return False, "HTTP %s" % status


# ------------------------------------------------------------------ push
def _publish_wordpress(title, md):
    base = env("WP_BASE").rstrip("/")
    user = env("WP_USER")
    pw = env("WP_APP_PASSWORD")
    if not (base and user and pw):
        return False, "缺 WP_BASE / WP_USER / WP_APP_PASSWORD"
    token = base64.b64encode(("%s:%s" % (user, pw)).encode()).decode()
    data = {"title": title, "content": md, "status": env("WP_STATUS", "publish")}
    cat = env("WP_CATEGORY")
    if cat:
        try:
            _, cr = _req(base + "/wp-json/wp/v2/categories?search=" + urllib.parse.quote(cat),
                         headers={"Authorization": "Basic " + token})
            arr = json.loads(cr)
            if arr:
                data["categories"] = [arr[0]["id"]]
        except Exception:
            pass
    status, body = _req(base + "/wp-json/wp/v2/posts", data=data, method="POST",
                        headers={"Authorization": "Basic " + token})
    if status in (200, 201):
        try:
            return True, json.loads(body).get("link", "已发布")
        except Exception:
            return True, "已发布"
    return False, "HTTP %s %s" % (status, body[:160])


def _publish_webhook(title, md):
    url = env("WEBHOOK_URL")
    if not url:
        return False, "缺 WEBHOOK_URL"
    status, body = _req(url, data={"title": title, "markdown": md,
                                   "text": title + "\n\n" + md}, method="POST")
    return (200 <= status < 300), "HTTP %s" % status


def _git(args, cwd, env_git):
    return subprocess.run(["git"] + args, cwd=cwd, env=env_git, capture_output=True, text=True)


def _publish_git(title, md, root):
    """Hexo / Hugo / Astro：把日报作为 Markdown 提交进博客仓库并推送，CI 自己构建"""
    repo = env("BLOG_GIT_DIR")
    remote = env("BLOG_GIT_REMOTE")
    branch = env("BLOG_GIT_BRANCH", "main")

    # 仓库不在就当远程仓库：自动 clone 一份
    if repo and not os.path.isdir(os.path.join(repo, ".git")) and remote:
        os.makedirs(os.path.dirname(repo.rstrip("/")) or ".", exist_ok=True)
        clone_url = remote
        if env("BLOG_GIT_TOKEN") and remote.startswith("https://"):
            clone_url = remote.replace("https://", "https://x-access-token:%s@" % env("BLOG_GIT_TOKEN"), 1)
        p = subprocess.run(["git", "clone", "-b", branch, clone_url, repo],
                           capture_output=True, text=True)
        if p.returncode != 0:
            return False, "clone 失败：%s" % (p.stderr or p.stdout)[-160:]
    if not repo or not os.path.isdir(os.path.join(repo, ".git")):
        return False, "GIT_DIR 不是 git 仓库，也没给 GIT_REMOTE"

    env_git = {k: v for k, v in os.environ.items()
               if k not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE")}
    env_git.update(GIT_AUTHOR_NAME=env("BLOG_GIT_AUTHOR", "cyber-eggs"),
                   GIT_AUTHOR_EMAIL=env("BLOG_GIT_AUTHOR_EMAIL", "bot@localhost"),
                   GIT_COMMITTER_NAME=env("BLOG_GIT_AUTHOR", "cyber-eggs"),
                   GIT_COMMITTER_EMAIL=env("BLOG_GIT_AUTHOR_EMAIL", "bot@localhost"),
                   GIT_TERMINAL_PROMPT="0")
    key = env("BLOG_GIT_SSH_KEY")
    if key:
        env_git["GIT_SSH_COMMAND"] = ("ssh -i %s -o IdentitiesOnly=yes "
                                      "-o StrictHostKeyChecking=accept-new" % key)

    # 先同步远端，避免 push 被拒
    if remote or _git(["remote"], repo, env_git).stdout.strip():
        _git(["pull", "--rebase", "--autostash", "origin", branch], repo, env_git)

    post_dir = env("BLOG_GIT_POST_DIR", "source/_posts")
    day = datetime.now(TZ).strftime("%Y-%m-%d")
    tpl = env("BLOG_GIT_FILENAME", "")
    if tpl:
        fn = (tpl.replace("{date}", day)
                 .replace("{time}", datetime.now(TZ).strftime("%H%M%S"))
                 .replace("{name}", env("BLOG_GIT_POST_NAME", "cyber-eggs-daily")))
        if not fn.endswith(".md"):
            fn += ".md"
    else:
        base = env("BLOG_GIT_POST_NAME", "cyber-eggs-daily")
        fn = "%s-%s.md" % (day, base) if env("BLOG_GIT_DATE_PREFIX", "1") != "0" else base + ".md"
    path = os.path.join(repo, post_dir, fn)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(md)
    rel = os.path.relpath(path, repo)

    r = _git(["add", rel], repo, env_git)
    if r.returncode != 0:
        return False, "git add 失败：%s" % (r.stderr or r.stdout)[-160:]
    r = _git(["commit", "-m", "chore(cyber-eggs): 日报 " + day], repo, env_git)
    if r.returncode != 0 and "nothing to commit" not in (r.stdout + r.stderr):
        return False, "git commit 失败：%s" % (r.stderr or r.stdout)[-160:]

    token = env("BLOG_GIT_TOKEN")
    push_url = remote
    if token and remote.startswith("https://"):
        push_url = remote.replace("https://", "https://x-access-token:%s@" % token, 1)

    pushed = "未推送（没配 remote）"
    if env("BLOG_GIT_PUSH", "1") in ("0", "false", "no"):
        pushed = "已提交本地（BLOG_GIT_PUSH=0 跳过推送）"
    elif (remote or _git(["remote"], repo, env_git).stdout.strip()):
        r = _git(["push", push_url or "origin", branch], repo, env_git)
        if r.returncode != 0:
            return False, "git push 失败：%s" % (r.stderr or r.stdout)[-200:]
        pushed = "已推送 origin/%s" % branch

    hook = env("BLOG_BUILD_CMD")
    if hook:
        h = subprocess.run(hook, cwd=repo, shell=True, capture_output=True, text=True)
        pushed += " · 构建%s" % ("成功" if h.returncode == 0 else "失败：" + (h.stderr or "")[-120:])
    return True, "%s · %s" % (rel, pushed)


def _publish_local(title, md, root):
    out = os.path.join(root, "out")
    os.makedirs(out, exist_ok=True)
    fn = os.path.join(out, "%s-cyber-eggs-daily.md" % datetime.now(TZ).strftime("%Y-%m-%d"))
    with open(fn, "w", encoding="utf-8") as f:
        f.write(md)
    return True, "已写到 %s" % os.path.relpath(fn, root)


def publish_daily(cfg, payload, root="."):
    kind = env("BLOG_KIND", "local").lower()
    fmt = env("BLOG_FORMAT", "simple").lower()
    site = env("SITE_URL") or cfg.get("blog", {}).get("site_url", "")
    title = "赛博鸡蛋日报 · %s" % payload["generated_day"]
    if fmt in ("fuwari", "astro"):
        md = build_fuwari_post(payload, site, env("BLOG_SOURCE_LINK", ""))
    else:
        md = build_markdown(payload, site)
    if kind in ("none", "off"):
        return False, "BLOG_KIND=none，跳过"
    if kind in ("github_api", "github-api", "github"):
        return _publish_github_api(md, payload["generated_day"])
    if kind == "wordpress":
        return _publish_wordpress(title, md)
    if kind == "webhook":
        return _publish_webhook(title, md)
    if kind == "git":
        return _publish_git(title, md, root)
    return _publish_local(title, md, root)


CANDIDATES = ["/atom.xml", "/feed.xml", "/rss.xml", "/index.xml", "/feed/", "/rss/",
              "/atom", "/rss", "/feed", "/blog/atom.xml"]


def probe(site_url):
    """给个站点地址，自动找 RSS/Atom"""
    site_url = site_url.rstrip("/")
    tried = []
    for path in CANDIDATES:
        url = site_url + path
        try:
            status, raw = _req(url, timeout=15)
        except Exception as e:
            tried.append((url, "ERR " + str(e)[:40]))
            continue
        head = raw[:400].lower()
        tried.append((url, "HTTP %s" % status))
        if status < 400 and ("<rss" in head or "<feed" in head or "<rdf" in head):
            posts = fetch_rss(url, 3)
            return {"rss": url, "posts": len(posts), "sample": [p["title"] for p in posts],
                    "tried": tried}
    return {"rss": "", "posts": 0, "sample": [], "tried": tried}


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "probe":
        print(json.dumps(probe(sys.argv[2]), ensure_ascii=False, indent=2))
    elif len(sys.argv) > 1 and sys.argv[1] == "rss":
        url = sys.argv[2] if len(sys.argv) > 2 else env("BLOG_RSS_URL")
        print(json.dumps(fetch_rss(url, 8), ensure_ascii=False, indent=2))
    else:
        print("用法: python3 blog.py rss <RSS地址>")
