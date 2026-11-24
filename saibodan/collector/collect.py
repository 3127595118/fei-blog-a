#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
赛博鸡蛋 · 每日福利核验采集器

纯标准库，零依赖；可在轻量应用服务器 / CVM / SCF / 任意 Linux 上跑。

做四件事：
  1. 按 sources.json 逐条抓官方页面（国内直连，海外走可选代理）
  2. 提取正文、关键词命中、指纹比对，算出「新增 / 变更 / 待核验 / 已结束」
  3. 生成 web/data/deals.json（前端直接读）
  4. 可选：把当日日报推到博客（见 collector/blog.py）

用法：
  python3 collect.py                     # 采集并写 web/data/deals.json
  python3 collect.py --publish           # 采集 + 发布日报到博客
  python3 collect.py --only agnes-free-api,codebuddy-free-tier
  python3 collect.py --dry-run           # 不写文件，只打印结果
"""
import argparse
import difflib
import gzip
import hashlib
import html as htmlmod
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TZ = timezone(timedelta(hours=8))  # 北京时间
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 CyberEggBot/1.0")

MAX_BYTES = 3 * 1024 * 1024
KEEP_HISTORY = 8
MAX_SENTENCES = 600


# ---------------------------------------------------------------- 基础工具
def now():
    return datetime.now(TZ)


def today():
    return now().strftime("%Y-%m-%d")


def log(*a):
    print("[%s]" % now().strftime("%H:%M:%S"), *a, flush=True)


def env(key, default=""):
    v = os.environ.get(key)
    return v.strip() if v and v.strip() else default


def load_dotenv():
    """读项目根的 .env（存在则合并进环境变量，已存在的键不覆盖）"""
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, sort_keys=False)
    os.replace(tmp, path)


# ---------------------------------------------------------------- 抓取
def build_opener():
    ctx = ssl.create_default_context()
    proxies = env("HTTP_PROXY") or env("HTTPS_PROXY")
    if proxies:
        handler = urllib.request.ProxyHandler({"http": proxies, "https": proxies})
        return urllib.request.build_opener(handler, urllib.request.HTTPSHandler(context=ctx))
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))


OPENER = None


def fetch(url, timeout=None):
    global OPENER
    if OPENER is None:
        OPENER = build_opener()
    timeout = timeout or int(env("FETCH_TIMEOUT", "20"))
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip",
        "Cache-Control": "no-cache",
    })
    t0 = time.time()
    try:
        with OPENER.open(req, timeout=timeout) as r:
            raw = r.read(MAX_BYTES)
            if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
                try:
                    raw = gzip.decompress(raw)
                except Exception:
                    pass
            charset = "utf-8"
            m = re.search(r"charset=([\w\-]+)", r.headers.get("Content-Type", "") or "", re.I)
            if m:
                charset = m.group(1)
            text = raw.decode(charset, "replace")
            return {"ok": True, "status": getattr(r, "status", 200), "text": text,
                    "error": "", "ms": int((time.time() - t0) * 1000), "url": r.geturl()}
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "text": "", "error": "HTTP %s" % e.code,
                "ms": int((time.time() - t0) * 1000), "url": url}
    except Exception as e:
        return {"ok": False, "status": 0, "text": "", "error": "%s: %s" % (type(e).__name__, str(e)[:110]),
                "ms": int((time.time() - t0) * 1000), "url": url}


def strip_html(raw):
    s = re.sub(r"(?is)<(script|style|noscript|svg|template)[^>]*>.*?</\1>", " ", raw)
    s = re.sub(r"(?s)<!--.*?-->", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</tr>|</h[1-6]>", "\n", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = htmlmod.unescape(s)
    s = s.replace("\u00a0", " ")
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


def sentences(text):
    """切成短句，只留可能含福利信息的句子，做 diff 用"""
    parts = re.split(r"(?<=[。！？!?；;\n])", text)
    out = []
    seen = set()
    for p in parts:
        p = re.sub(r"\s+", " ", p).strip()
        if not (8 <= len(p) <= 220):
            continue
        key = p.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
        if len(out) >= MAX_SENTENCES:
            break
    return out


def fingerprint(sent_list):
    h = hashlib.sha256()
    for s in sent_list:
        h.update(s.encode("utf-8", "replace"))
        h.update(b"\x00")
    return h.hexdigest()[:20]


def pick_new_sentences(old, new, limit=3):
    oldset = set(old)
    added = [s for s in new if s not in oldset]
    removed = [s for s in old if s not in set(new)]
    return added[:limit], removed[:limit]


def shorten(s, n=88):
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[:n - 1] + "…"


# ---------------------------------------------------------------- 单条核验
TYPE_LABEL = {"free": "免费", "quota": "额度", "discount": "折扣", "member": "会员"}
REGION_LABEL = {"cn": "国内", "global": "海外"}
STATUS_LABEL = {"active": "可用", "updated": "今日更新", "new": "今日新增",
                "pending": "待核验", "ended": "已结束", "expiring": "即将截止"}


def check_source(src, prev):
    urls = [src["url"]] + [u for u in src.get("mirrors", []) if u]
    res = None
    for u in urls:
        res = fetch(u)
        if res["ok"] and res["text"]:
            break
    text = strip_html(res["text"]) if res and res["ok"] else ""
    low = text.lower()
    hits = [k for k in src.get("keywords", []) if k.lower() in low]
    ended_hits = [k for k in src.get("end_keywords", []) if k.lower() in low]
    sents = sentences(text)
    fp = fingerprint(sents)

    rec = {
        "fp": fp,
        "hits": hits,
        "ended_hits": ended_hits,
        "checked_at": now().strftime("%Y-%m-%d %H:%M"),
        "http": res["status"] if res else 0,
        "error": res["error"] if res else "no url",
        "ms": res["ms"] if res else 0,
        "sentences": sents,
    }

    status = "active"
    change = ""

    if not res or not res["ok"] or not text:
        status = "pending"
        change = "核验失败（%s），保留上次结论" % (rec["error"] or "空页面")
    else:
        if ended_hits and not hits:
            status = "ended"
            change = "页面出现结束信号且不再有免费信息：%s" % "、".join(ended_hits[:2])
        elif len(text) < 200:
            status = "pending"
            change = "页面前端渲染或反爬，正文抓不到，需人工看一眼"
        elif not hits:
            status = "pending"
            change = "页面可访问但未命中关键词，人工复核"
        elif prev and prev.get("fp") and prev["fp"] != fp:
            added, removed = pick_new_sentences(prev.get("sentences", []), sents)
            bits = []
            if added:
                bits.append("新增表述：" + shorten(added[0], 70))
            if removed:
                bits.append("移除表述：" + shorten(removed[0], 60))
            change = "；".join(bits) or "页面指纹变化"
            status = "updated"
        elif not prev or not prev.get("fp"):
            status = "new"
            change = "首次收录并核验通过"

    return rec, status, change


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sources", default=os.path.join(HERE, "sources.json"))
    ap.add_argument("--state", default=os.path.join(ROOT, "state", "snapshots.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "web", "data", "deals.json"))
    ap.add_argument("--only", default="")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--publish", action="store_true", help="采集后把日报推到博客")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--emit-post", default="", help="只生成博客文章 Markdown 到该路径（不发网络），供 CI 用")
    ap.add_argument("--sleep", type=float, default=0.6, help="请求间隔秒数")
    ap.add_argument("--timeout", type=int, default=0, help="单请求超时秒数，默认读 FETCH_TIMEOUT")
    args = ap.parse_args()

    load_dotenv()
    if args.timeout:
        os.environ["FETCH_TIMEOUT"] = str(args.timeout)
    cfg = read_json(args.sources)
    if not cfg:
        log("读不到 sources.json")
        sys.exit(2)

    state = read_json(args.state, {}) or {}
    snaps = state.get("sources", {})
    meta = state.get("meta", {})

    only = [x.strip() for x in args.only.split(",") if x.strip()]
    sources = [s for s in cfg["sources"] if not only or s["id"] in only]
    if args.limit:
        sources = sources[:args.limit]

    log("开始核验 %d 条源" % len(sources))
    deals = []
    stats = {"new": 0, "updated": 0, "pending": 0, "ended": 0, "active": 0}
    today_s = today()

    for i, src in enumerate(sources, 1):
        sid = src["id"]
        prev = snaps.get(sid, {})
        rec, status, change = check_source(src, prev)

        first_seen = prev.get("first_seen") or today_s
        history = prev.get("history", [])
        if change and (status in ("updated", "new", "ended", "pending") or not history):
            if not history or history[0].get("note") != change or history[0].get("date") != today_s:
                history.insert(0, {"date": today_s, "note": change})
                history = history[:KEEP_HISTORY]

        snaps[sid] = {
            "fp": rec["fp"], "hits": rec["hits"], "ended_hits": rec["ended_hits"],
            "checked_at": rec["checked_at"], "http": rec["http"], "error": rec["error"],
            "sentences": rec["sentences"], "first_seen": first_seen,
            "history": history, "last_status": status,
        }

        stats[status] = stats.get(status, 0) + 1

        deals.append({
            "id": sid,
            "vendor": src["vendor"],
            "title": src["title"],
            "url": src["url"],
            "region": src["region"],
            "region_label": REGION_LABEL.get(src["region"], src["region"]),
            "type": src["type"],
            "type_label": TYPE_LABEL.get(src["type"], src["type"]),
            "group": src.get("group", "free_api"),
            "value": src.get("value", 0),
            "gets": src.get("gets", ""),
            "cond": src.get("cond", ""),
            "deadline": src.get("deadline", ""),
            "status": status,
            "status_label": STATUS_LABEL.get(status, status),
            "check": {
                "ok": rec["http"] == 200 and bool(rec["hits"]),
                "http": rec["http"],
                "at": rec["checked_at"],
                "ms": rec["ms"],
                "hits": rec["hits"],
                "error": rec["error"],
            },
            "first_seen": first_seen,
            "history": history[:4],
        })
        log("%-28s %-8s %s" % (sid, status, ("· " + change) if change else ""))
        if i < len(sources):
            time.sleep(args.sleep)

    deals.sort(key=lambda d: (-d["value"], d["vendor"]))

    groups = []
    for g in cfg.get("groups", []):
        items = [d for d in deals if d["group"] == g["key"]]
        groups.append({"key": g["key"], "label": g["label"], "count": len(items),
                       "url": "#filter:" + g["key"]})

    blog = {"url": cfg.get("blog", {}).get("url", ""),
            "site_url": cfg.get("blog", {}).get("site_url", ""),
            "posts": []}
    if blog["url"]:
        try:
            from blog import fetch_rss
            blog["posts"] = fetch_rss(blog["url"], cfg.get("blog", {}).get("limit", 6))
            log("博客 RSS 拉到 %d 篇" % len(blog["posts"]))
        except Exception as e:
            log("博客 RSS 拉取失败：%s" % e)

    payload = {
        "site": cfg.get("site", {}),
        "generated_at": now().strftime("%Y-%m-%d %H:%M"),
        "generated_day": today_s,
        "stats": {"total": len(deals),
                  "today_new": sum(1 for d in deals if d["first_seen"] == today_s),
                  "today_updated": stats.get("updated", 0),
                  "pending": stats.get("pending", 0),
                  "ended": stats.get("ended", 0),
                  "active": stats.get("active", 0)},
        "flash": cfg.get("flash", []),
        "groups": groups,
        "deals": deals,
        "blog": blog,
    }

    meta["last_run"] = now().strftime("%Y-%m-%d %H:%M:%S")
    meta["last_stats"] = payload["stats"]
    state = {"meta": meta, "sources": snaps}

    if args.dry_run:
        log("dry-run：%s" % json.dumps(payload["stats"], ensure_ascii=False))
        return

    write_json(args.out, payload)
    write_json(args.state, state)
    log("已写出 %s（%d 条）" % (os.path.relpath(args.out, ROOT), len(deals)))

    if args.emit_post:
        try:
            import blog as blogmod
            fmt = os.environ.get("BLOG_FORMAT", "fuwari").lower()
            site = os.environ.get("SITE_URL", "")
            if fmt in ("fuwari", "astro"):
                md = blogmod.build_fuwari_post(payload, site, os.environ.get("BLOG_SOURCE_LINK", ""))
            else:
                md = blogmod.build_markdown(payload, site)
            path = os.path.abspath(args.emit_post)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(md)
            log("文章已生成 %s（%d 字符）" % (os.path.relpath(path), len(md)))
        except Exception as e:
            log("生成文章失败：%s" % e)

    if args.publish:
        try:
            import blog as blogmod
            ok, msg = blogmod.publish_daily(cfg, payload, root=ROOT)
            log("博客发布：%s · %s" % ("成功" if ok else "未发布", msg))
        except Exception as e:
            log("博客发布异常：%s" % e)


if __name__ == "__main__":
    main()
