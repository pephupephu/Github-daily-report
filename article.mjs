#!/usr/bin/env node
// 读 reports/latest.json -> 浏览器渲染抓中文入口+截图
// -> 生成「公众号风格」文章初稿 -> 截图附件内嵌发邮箱
// 定位：AI 出文章骨架 + 链接 + 部署命令，“真实体验/多媒体”留占位给人填
// 用法: node article.mjs

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTransport } from "nodemailer";
import { Document, Packer, Paragraph, TextRun, ImageRun } from "docx";

const ROOT = dirname(fileURLToPath(import.meta.url));
const UA = { "user-agent": "gh-daily-article" };

// 二次元挂件：pick 传文件名则用该图，传数字则从池子里按索引取（可 exclude 排除某张），转 base64 内联
function mascot(pick = 0, size = 84, exclude = "") {
  const dir = join(ROOT, "assets", "mascots");
  let files = [];
  // 排除 1.png（用户不要这张）
  try { files = readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f) && !/^1\.png$/i.test(f)).sort(); } catch { return ""; }
  if (!files.length) return "";
  let file;
  if (typeof pick === "string") {
    file = files.includes(pick) ? pick : files[0];
  } else {
    const pool = exclude ? files.filter((f) => f !== exclude) : files;
    const use = pool.length ? pool : files;
    file = use[Math.abs(pick) % use.length];
  }
  try {
    const b64 = readFileSync(join(dir, file)).toString("base64");
    const mime = /\.png$/i.test(file) ? "image/png" : "image/jpeg";
    return `<img src="data:${mime};base64,${b64}" data-file="assets/mascots/${file}" width="${size}" style="border-radius:14px;box-shadow:0 3px 12px rgba(199,125,255,.25);vertical-align:middle;border:2px solid #ffe0f3" alt="二次元挂件" />`;
  } catch { return ""; }
}

// ---------- 大模型逐个深度分析（OpenAI 兼容协议；默认智谱 glm-4-flash 免费档）----------

const LLM_KEYS = [process.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY_2, process.env.OPENAI_API_KEY_3, process.env.OPENAI_API_KEY_4, process.env.OPENAI_API_KEY_5]
  .filter(Boolean);
const LLM = LLM_KEYS.length
  ? {
      keys: LLM_KEYS,
      base: (process.env.OPENAI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, ""),
      model: process.env.OPENAI_MODEL || "glm-4-flash-250414",
    }
  : null;
let LLM_KEY_IDX = 0; // 轮换指针：摊平多账号限流

const AI_PROMPT = `你是资深公众号科技编辑，为一个 GitHub 热门项目写中文深度解读。要求像真人作者写的：口语化、句子完整通顺、有具体细节、不说空话、不堆术语（出现专业词就用半句话解释它对读者的意义）。

仓库名：{repo}（{lang}，总星 {stars}，今日涨 {today}）
官方简介：{desc}
README 摘录：
{readme}

本期已用过的开头角度：{used}
hook（开头）是全文胜负手：读者看完这一句才决定要不要往下读。从该仓库自身找一个具体抓手——一个扎眼的数字、一个真实痛点、一个反常识的设计决策，或者一句感慨——像人随口跟朋友说话那样写出来，有画面、有悬念，但不是标题党。禁止以“分享一个”“爆火”“上榜”“今天看到”这类套话开头，禁止喊口号和排比。

只输出 JSON（不要代码块、不要任何解释）：
{"hook":"开头一句，30字内。直接给一个具体成果或场景：谁用它能做到什么，带关键数字或名词，让人一眼看到画面；禁止出现：爆火/火得有理由/涨得最凶/杀疯了/上榜/分享一个/今天看到/值得一看","oneliner":"18字内，一句话点出这个仓库独有的真本事：它处理什么、能到什么程度，必须写出具体对象和具体动作，不点名仓库也能猜出是干什么的。禁止空话和比较句，禁止'平台/框架/生态/无缝/赋能'，禁止'这是一个…工具'，禁止不同仓库之间重复同一说法","what":"第1句必须用最直白的一句话先说清这个仓库是干嘛的（做成什么东西、给谁用、解决什么问题，不写代码的人也秒懂）；第2句起才讲它最厉害的地方，落到一个具体的输入→输出例子。严禁第1句就抛优点/特性/技术词。不要给固定骨架，不同仓库切入角度要各不相同，只求每篇都新鲜、有它自己的味道","case":"2到3句一个贴合本仓库真实能力的运用案例。开头先交代这个工具是用来解决什么问题的，再写具体场景。不要套固定结构，每次按这个仓库 README 里最能打的那个能力出发，写一个具体、能落地、别人真会遇到的场景。禁止用'老王''某前端''某程序员''某同事'这类泛指人名开场；禁止'先做A再做B''第一步第二步'这种流水账；禁止空泛的'方便了很多人''效率大增'；每个仓库的案例必须是它独有的、别仓库替代不了的","core":"3到4句讲清它是怎么做到的，点名关键部件、步骤和数据流向，说清为什么有效。开头用一句先说明它整体是做什么的，再讲原理。不要套同一套写法，不同技术原理要用不同的表述。基于 README 事实，不编造","who":"适合谁用，直接说具体职业或具体生活场景，具体到一眼能想出这个人在干什么活。禁止'热爱折腾的程序员''资深开发者'这类空身份，别给泛化人设"}

全文对"完全不写代码的普通人"说人话。英文专业词一个都不许保留原样，必须翻成中文日常说法，翻不了就拆成大白话解释它管什么用。例如："Decoder-only Transformer"→"只看上文往下猜字的一个模型"、"Wayland 合成器"→"替系统画屏幕、排窗口的软件"、"MoE"→"平时只叫一部分脑子干活、省电"、"MCP"→"让两个软件能互相说话的接头"、"Tokenizer"→"把一句话切成一粒粒小词的切词器"。专有缩写（AI、GPU、手机、Windows）除外。凡是像"SDK/API/CLI/FFI/GGUF/Optuna/IPC/组件/算子/协议/StyleX/Tailwind/CSS/React/组件/前端框架名"这类读者会卡壳的词，一律要么换成人话，要么先给一个"说白了就是X"的括号解释，绝不允许原样扔出来。出现英文词必须紧跟着用中文说清楚它是什么。读者是不写代码的人也能看懂。编程语言名、命令行工具名、技术框架名（如 Rust、Shell、Python、npm、Docker、Kubernetes、React、前端框架名）一概不许原样出现，必须换成"一种主打安全的编程语言""一个命令行小工具""一个打包发布软件的工具"这种说人话的说法；实在绕不开就带括号解释它用来干嘛的。输出里绝对禁止出现任何没跟中文解释的英文技术词。

禁止 AI 腔套话，一次都不许出现：值得注意的是、总的来说、总而言之、不可否认、在当今、极大地、深入地、一站式、赋能、致力于、旨在、此外、然而、因此、从而、无缝衔接。写具体事、具体数字、具体动作。整篇各个仓库的写法要各不相同，绝不允许两篇开头相似、结构雷同，每个仓库都要有它自己的开头和展开方式。严禁空洞废话——像"它不是一个又大又全的东西，而是小而精""功能强大、性能优秀""它是为解决XX而生"这类不落地的形容一概不要，要说就说出它到底小在哪、精在哪、哪个具体点强，用能感知的细节或数字说话。

在 what / case / core 的内容里，把关键名词、数字、量化收益用 **双星号** 包起来标黑（如 **7 美元**、**3295 个可编辑对象**、**一块 ESP32-S3 开发板**），每段 1 到 3 处，不要整句加粗。`;

async function callAI(prompt) {
  // 多 key 轮换：1305 限流时换下一个 key 重试，摊平负载
  for (let k = 0; k < LLM.keys.length + 2; k++) {
    const key = LLM.keys[LLM_KEY_IDX % LLM.keys.length];
    LLM_KEY_IDX++;
    const res = await fetch(`${LLM.base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        model: LLM.model,
        temperature: 0.85,
        messages: [
          { role: "system", content: "你是写得一手好中文的公众号科技编辑：句子通顺、口语但有信息量、只讲事实不喊口号。只输出 JSON。" },
          { role: "user", content: prompt },
        ],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      const msg = `HTTP ${res.status} ${text.slice(0, 150)}`;
      if (/HTTP 429|1302|1305|速率|过大/.test(msg)) {
        if (k < LLM.keys.length + 1) { process.stderr.write(`[大模型] 限流 → 换下一个 key\n`); continue; }
        throw new Error(msg);
      }
      throw new Error(msg);
    }
    // 正确解包：外层是 API 信封，正文在 choices[0].message.content，正文里可能还有 ```json 围栏
    let content = "";
    try { content = JSON.parse(text)?.choices?.[0]?.message?.content || ""; } catch { /* 非标准响应,退回原文 */ }
    if (!content) content = text;
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`返回无 JSON 内容：${content.slice(0, 120)}`);
    const raw = JSON.parse(m[0]);
    const out = {
      hook: String(raw.hook || "").trim(),
      oneliner: String(raw.oneliner || "").trim(),
      what: String(raw.what || "").trim(),
      case: String(raw.case || raw.usecases?.[0] || "").trim(),
      core: String(raw.core || "").trim(),
      who: String(raw.who || "").trim(),
    };
    if (!out.hook && !out.what) throw new Error("hook/what 均为空");
    return out;
  }
  throw new Error("所有 key 均限流");
}

// 智谱免费档限流特征：HTTP 429 / code 1302(账户频率) / 1305(模型过载)，退避重试有效
const RATE_LIMITED = /HTTP 429|1302|1305|速率|访问量过大/;

async function analyzeOne(r, md, usedHooks = []) {
  if (!LLM) return null;
  const prompt = AI_PROMPT
    .replace("{used}", usedHooks.length ? usedHooks.map((h, i) => `${i + 1}. ${h}`).join("；") : "（无，可自由发挥，但仍禁止“分享一个/爆火/上榜”式套话）")
    .replace("{repo}", r.repo).replace("{lang}", r.lang || "-").replace("{stars}", String(r.stars ?? "")).replace("{today}", r.today ?? "")
    .replace("{desc}", r.desc || "").replace("{readme}", md.slice(0, 4000));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await callAI(prompt);
    } catch (e) {
      if (attempt < 3 && (RATE_LIMITED.test(e.message) || /aborted|timeout/i.test(e.message))) {
        const wait = [25000, 60000, 120000][attempt];
        process.stderr.write(`[大模型] ${r.repo} 被限流/超时，${wait / 1000}s 后重试\n`);
        await new Promise((s) => setTimeout(s, wait));
        continue;
      }
      process.stderr.write(`[大模型] ${r.repo} 分析失败：${e.message}\n`);
      return null;
    }
  }
}

// AI 缺席时的轮换兜底开场，只陈述榜单事实，不喊口号
const FALLBACK_HOOKS = [
  (n, name) => `${name} 今天单日 **+${n}★**。`,
  (n, name) => `**+${n}★** 一天，${name} 在解决一个具体问题。`,
  (n, name) => `${name} 今天的榜单成绩：**+${n}★**。`,
  (n, name) => `单日 **+${n}★** 的 ${name}，看看它对你有没有用。`,
];

// ---------- 链接抽取 ----------

const DEMO = /(demo|try (it )?(online|out)|live|playground|play ?with|online demo|web ?ui|体验|演示|试用|在线|玩一下|在线体验)/i;
const DOCS = /(doc|documentation|guide|tutorial|readme|手册|文档|教程)/i;
const PAPER = /(arxiv|paper|技术报告|论文)/i;
const SOCIAL = /(discord|telegram|微信|wechat|slack|twitter|community|社区|交流)/i;
const CN_PATH = /(\/zh(-cn|-tw|-hans)?\/|\/cn\/|\bzh\b|\bchinese\b|lang=(zh|cn))/i;
const JUNK = /(^|\.)(github\.com|gitee\.com|arxiv\.org|doi\.org|githubusercontent\.com|shields\.io|badge\.|discord\.gg|twitter\.com|x\.com|patreon\.com|opencollective\.com|ko-fi\.com|buymeacoffee\.com|huggingface\.co\/[^/]+\/[^/]+\/blob)/i;
const VID_FILE = /\.(mp4|webm|mov|avi|gif)(\?|#|$)/i;

async function readme(repo) {
  const r = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: { ...UA, accept: "application/vnd.github.raw" } });
  return r.ok ? await r.text() : "";
}

function parseLinks(md) {
  const out = [];
  for (const m of md.matchAll(/\[([^\]]{0,120})\]\((https?:\/\/[^)\s]+)[^)]*\)/g))
    out.push({ text: m[1].replace(/[*_`]/g, "").trim(), url: m[2].replace(/[.,;:]+$/, "") });
  for (const m of md.matchAll(/(?:^|[^\](])(https?:\/\/[^\s<>()\[\]"']{8,200})/g))
    out.push({ text: "", url: m[1].replace(/[.,;]+$/, "") });
  return out;
}

function classify(links, repo, homepage) {
  const seen = new Set();
  const res = { cnDemo: [], demo: [], docs: [], paper: [], social: [] };
  const items = homepage ? [...links, { text: "Homepage", url: homepage }] : links;

  for (const l of items) {
    let u; try { u = new URL(l.url); } catch { continue; }
    const host = u.hostname;
    if (u.hostname === `github.com` && u.pathname.startsWith(`/${repo}`)) continue;
    // 站内零散页（issues/PR/releases/wiki…）和礼仪性文档没有代表性，跳过
    if (/\/(issues|pulls|releases|discussions|wiki|actions|security|blob|tree|commit|stargazers)\b/.test(u.pathname)) continue;
    if (/(contribut|licen[cs]e|code of conduct|changelog|sponsor|funding|privacy|terms)/i.test(l.text)) continue;
    const key = host + u.pathname.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (JUNK.test(host)) {
      if (PAPER.test(l.text) || /arxiv/.test(host)) res.paper.push(l);
      else if (SOCIAL.test(l.text) || /discord|telegram|t\.me/i.test(host)) res.social.push(l);
      continue;
    }
    const cn = CN_PATH.test(u.pathname + u.search);
    if (DEMO.test(l.text) || /(^|\.)(demo|demos|play|playground|app|try)\./i.test(host)) (cn ? res.cnDemo : res.demo).push(l);
    else if (DOCS.test(l.text)) res.docs.push(l);
  }
  const rank = (a, b) => (a.text ? 0 : 1) - (b.text ? 0 : 1);
  res.cnDemo.sort(rank); res.demo.sort(rank);
  return res;
}

// ---------- 视频提取 ----------

// README 里相对路径必须转 raw，否则拼出来的是 github.com 网页而不是图片文件
function toRaw(url, repo) {
  const u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) return `https://raw.githubusercontent.com/${repo}/HEAD/${u.replace(/^\.?\//, "")}`;
  const m = u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/i);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : u;
}

const IMG_JUNK = /(shields\.io|badge|badgen|visitor|counter|star.?history|contrib\.rocks|travis|codecov|circleci|snyk|dependabot|logo|icon|favicon)/i;
const imgExt = (u) => (/\.(png|jpe?g|gif|webp)(\?|#|$)/i.exec(u)?.[1] || "png").toLowerCase().replace("jpeg", "jpg");

// README 里第一张非 badge 的图，通常就是产品界面/演示，比盲截首页有代表性
function readmeHero(md, repo) {
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    const u = toRaw(m[1], repo);
    if (!/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(u)) continue;
    if (IMG_JUNK.test(u)) continue;
    if (/(banner|header|cover|social|hero|title|wordmark)/i.test(u)) continue; // 装饰性头图，不是产品界面
    return u;
  }
  return "";
}

async function grabImage(url, dest) {
  try {
    const res = await fetch(url, { headers: UA, redirect: "follow" });
    if (!res.ok) return null;
    if (!/^image\//i.test(res.headers.get("content-type") || "")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 12 * 1024 || buf.length > 2.5 * 1024 * 1024) return null; // 小图是图标，大图附件吃不消
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    return dest;
  } catch { return null; }
}

function extractVideos(md, repoUrl, repo) {
  const videos = [];
  const seen = new Set();
  const base = new URL(repoUrl);

  // YouTube: watch?v= / youtu.be/ / embed/
  for (const m of md.matchAll(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/gi)) {
    const id = m[1];
    if (!seen.has(`yt:${id}`)) {
      seen.add(`yt:${id}`);
      videos.push({ type: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}`, thumb: `https://img.youtube.com/vi/${id}/mqdefault.jpg` });
    }
  }

  // Bilibili: BV number
  for (const m of md.matchAll(/(?:bilibili\.com\/video\/(BV[0-9A-Za-z]+)|b23\.tv\/([0-9A-Za-z]+))/gi)) {
    const id = m[1] || m[2];
    if (!seen.has(`bili:${id}`)) {
      seen.add(`bili:${id}`);
      videos.push({ type: 'bilibili', id, url: `https://www.bilibili.com/video/${id}` });
    }
  }

  // Vimeo
  for (const m of md.matchAll(/vimeo\.com\/(\d+)/gi)) {
    const id = m[1];
    if (!seen.has(`vim:${id}`)) {
      seen.add(`vim:${id}`);
      videos.push({ type: 'vimeo', id, url: `https://vimeo.com/${id}` });
    }
  }

  // 直接视频文件 / GIF
  for (const m of md.matchAll(/(?:(?:src|href)=["'])([^"']*\.(?:mp4|webm|mov|avi|gif)(?:[?#][^"']*)?)["']/gi)) {
    const url = toRaw(m[1], repo);
    if (IMG_JUNK.test(url)) continue;
    if (!seen.has(`file:${url}`)) {
      seen.add(`file:${url}`);
      videos.push({ type: 'file', id: url, url, thumb: url.endsWith('.gif') ? url : undefined });
    }
  }

  // Markdown 图片形式的 gif/视频 ![](xxx.mp4)
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]*\.(?:mp4|webm|mov|avi|gif)(?:[?#][^)]*)?)\)/gi)) {
    const url = toRaw(m[1], repo);
    if (IMG_JUNK.test(url)) continue;
    if (!seen.has(`md:${url}`)) {
      seen.add(`md:${url}`);
      videos.push({ type: 'file', id: url, url, thumb: url.endsWith('.gif') ? url : undefined });
    }
  }

  return videos.slice(0, 4);
}

// ---------- 视频卡片 ----------

function videoBlock(videos) {
  if (!videos.length) return '';
  const cards = videos.map(v => {
    if (v.type === 'youtube') {
      return `
      <div style="margin:10px 0;padding:12px;background-color:#fff;border:1px solid #e1e4e8;border-radius:8px">
        <a href="${esc(v.url)}" style="text-decoration:none;display:block">
          <img src="${esc(v.thumb)}" style="width:100%;max-width:560px;border-radius:6px;display:block;margin-bottom:8px" onerror="this.src='https://img.youtube.com/vi/${esc(v.id)}/default.jpg'">
          <div style="font-size:13px;color:#1a1a1a">▶ ${esc(`YouTube 演示 · ${v.id}`)}</div>
        </a>
      </div>`;
    }
    if (v.type === 'bilibili') {
      return `
      <div style="margin:10px 0;padding:12px;background-color:#fff;border:1px solid #e1e4e8;border-radius:8px">
        <a href="${esc(v.url)}" style="text-decoration:none;display:block"><span style="font-size:13px;color:#1a1a1a">▶ Bilibili 演示 · ${esc(v.id)}</span></a>
      </div>`;
    }
    if (v.type === 'vimeo') {
      return `
      <div style="margin:10px 0;padding:12px;background-color:#fff;border:1px solid #e1e4e8;border-radius:8px">
        <a href="${esc(v.url)}" style="text-decoration:none;display:block"><span style="font-size:13px;color:#1a1a1a">▶ Vimeo 演示 · ${esc(v.id)}</span></a>
      </div>`;
    }
    // 直接文件
    let fname = v.url; try { fname = new URL(v.url).pathname.split('/').pop() || v.url; } catch {}
    return `
    <div style="margin:10px 0;padding:12px;background-color:#fff;border:1px solid #e1e4e8;border-radius:8px">
      <a href="${esc(v.url)}" style="text-decoration:none;display:block"><span style="font-size:13px;color:#1a1a1a">▶ ${esc(v.thumb ? '演示动图' : '演示视频')} · ${esc(fname)}</span></a>
    </div>`;
  }).join('');
  return `<div style="margin:12px 0">${cards}</div>`;
}

// ---------- 浏览器层面：抓 SPA 中文入口 + 截图 ----------

let browser;
async function withBrowser(fn) {
  // 浏览器缺失（版本错位/下载失败）时降级：跳过 SPA 截图，但英雄图(HTTP 直抓)+AI 分析照常，文章仍能出，不整崩
  let page = null;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"] });
    page = await browser.newPage();
    page.setViewportSize({ width: 1280, height: 800 });
  } catch (e) {
    browser = null;
    page = null;
    process.stderr.write(`[浏览器] 无法启动（${e.message.slice(0, 90)}）→ 降级：本次跳过 SPA 截图，仅用 README 英雄图\n`);
  }
  try { return await fn(page); } finally { if (browser) await browser.close(); }
}

async function probeAndShot(page, demoUrl, repo) {
  try {
    await page.goto(demoUrl, { waitUntil: "networkidle", timeout: 20000 });
    const hrefs = await page.$$eval("a", (els) => els.map((e) => e.getAttribute("href") || "").filter(Boolean));
    const cn = [];
    for (const h of hrefs) {
      try { const abs = new URL(h, demoUrl).href; if (CN_PATH.test(abs)) cn.push(abs); } catch {}
    }
    const shotDir = join(ROOT, "shots");
    mkdirSync(shotDir, { recursive: true });
    const shotPath = join(shotDir, `${repo.replace("/", "__")}.png`);
    // 触发懒加载后只截首屏：fullPage 会把 demo 页底出的长空白全拍进来
    await page.evaluate(() => window.scrollTo(0, 400)).catch(() => {});
    await page.waitForTimeout(400);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    const h = await page.evaluate(() => Math.min(800, Math.max(document.documentElement.scrollHeight, 300))).catch(() => 600);
    await page.screenshot({ path: shotPath, clip: { x: 0, y: 0, width: 1280, height: h } });
    return { cnUrls: [...new Set(cn)].slice(0, 3), shotPath };
  } catch (e) {
    process.stderr.write(`[浏览器] ${demoUrl} 渲染失败：${e.message}\n`);
    return { cnUrls: [], shotPath: null };
  }
}

// ---------- 文案 ----------

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
// 去 AI 味：删空话套话、换掉高频书面腔。只做安全的词级替换，不动事实
const AI_SMELL = [
  [/值得注意的是[，,]?\s*/g, ""], [/需要指出的是[，,]?\s*/g, ""],
  [/总的来说[，,]?\s*/g, ""], [/总而言之[，,]?\s*/g, ""], [/不可否认[，,]?\s*/g, ""],
  [/在当今[^，。]{0,12}(时代|背景下)[，,]?\s*/g, ""],
  [/极大地/g, "很"], [/深入地/g, "好好"], [/一站式/g, "整套"],
  [/赋能/g, "帮上忙"], [/致力于/g, "在做"], [/旨在/g, "想"],
  [/此外[，,]?\s*/g, "另外，"], [/然而[，,]?\s*/g, "但"], [/因此[，,]?\s*/g, "所以"], [/从而/g, "这样"],
  // 英文专业词必须说人话：LLM 偶发漏网，这里硬翻译兜底（顺序：长词在前，避免被短词误伤）
  [/\bDecoder[\s-]only\b/gi, "只往下猜字的生成模型"],
  [/\bTransformer\b/gi, "大模型"], [/\bTokenizer\b/gi, "切词器"],
  [/\bToken(s)?\b/gi, "词单元"],
  [/\bDataFrame\b/gi, "表格数据"], [/\bPandas\b/gi, "表格处理库"],
  [/\bWayland\b/gi, "新一代桌面显示接口"], [/\bMoE\b/gi, "混合专家架构"],
  [/\bMCP\b/gi, "软件互联接口"], [/\bGGUF\b/gi, "大模型打包格式"],
  [/\bFFI\b/gi, "跨语言调用接口"], [/\bOptuna\b/gi, "自动调参工具"],
  [/\bRANSAC\b/gi, "位姿估算算法"], [/\bSLAM\b/gi, "同步定位建图"],
  [/\bAPI\b/gi, "接口"], [/\bSDK\b/gi, "开发工具包"], [/\bCLI\b/gi, "命令行工具"],
];
const deAI = (s) => { let t = String(s ?? ""); for (const [re, to] of AI_SMELL) t = t.replace(re, to); return t.replace(/\s{2,}/g, " ").trim(); };
// 先转义再还原 **粗体**：LLM 用双星号标关键名词/数字，这里变成 <b>
const md = (s) => esc(deAI(s)).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
// 中文哨兵：兜底数据里宁可不显示，也不放英文让读者出戏
const CN = (s) => (/[\u4e00-\u9fa5]/.test(s) ? s : "");
const CN_DATE = (d) => `${d.slice(0, 4)}年${d.slice(5, 7)}月${d.slice(8)}日`;
const fmtStars = (n) => { const v = +String(n || 0).replace(/,/g, ""); return v ? `+${v}` : "—"; };
const repoShort = (repo) => repo.split("/")[1];

// 无 LLM 时的最后保障：用 topics 词表拼一句中文，绝不让表格/正文出现"详情见下"这种空壳
const TOPIC_CN = {
  ai: "AI", llm: "大模型", "ai-agents": "AI Agent", agents: "Agent", "agent-skills": "Agent 技能",
  skills: "技能包", mcp: "MCP 工具", rag: "知识库检索", automation: "自动化",
  browser: "浏览器", "browser-automation": "浏览器自动化", headless: "无头浏览器", scraper: "网页抓取",
  web: "网页", react: "React", nextjs: "Next.js", typescript: "TypeScript", python: "Python",
  rust: "Rust", zig: "Zig", go: "Go", golang: "Go", cli: "命令行工具", devtools: "开发者工具",
  design: "设计", ui: "界面", database: "数据库", api: "API", docker: "Docker",
  crm: "CRM", email: "邮件", video: "视频", image: "图片", audio: "音频", speech: "语音",
  memory: "记忆", "computer-use": "电脑操作", desktop: "桌面应用", electron: "桌面应用",
  ios: "iOS", android: "Android", note: "笔记", markdown: "Markdown", pdf: "PDF",
  prompt: "提示词", "prompt-engineering": "提示词", tutor: "学习辅导", learning: "学习",
  game: "游戏", "3d": "3D", blender: "Blender", seo: "SEO", security: "安全", proxy: "代理",
};
function metaLine(r) {
  const t = [...new Set((r.topics || []).map((x) => TOPIC_CN[String(x).toLowerCase()]).filter(Boolean))].slice(0, 2);
  const lang = r.lang && r.lang !== "—" ? `${r.lang} ` : "";
  return t.length ? `面向${t.join("、")}的${lang}项目` : `${lang}开源项目`;
}

// 公众号风格：每个项目一节，AI 钩子开头，带核心机制/使用场景/适合谁；AI 缺席时退回简版
function section(r, i, shotCid) {
  const ai = r.ai;
  const img = shotCid ? `<img src="cid:${shotCid}" style="max-width:100%;border-radius:10px;margin:0 0 16px;display:block;box-shadow:0 4px 16px rgba(16,24,40,.08);border:1px solid #f0f1f3" alt="${esc(repoShort(r.repo))} 演示截图" />` : "";
  const vids = r.videos?.length ? videoBlock(r.videos) : "";
  const p = `style="margin:0 0 10px;font-size:13px;line-height:1.9;color:#3a3a3a"`;
  // 小节标签：二次元粉紫胶囊，给 case/core/who 一个统一视觉
  const tag = (t) => `<span style="display:inline-block;background-color:#ffe0f3;color:#c75bd6;border-radius:7px;padding:2px 9px;font-size:12px;font-weight:800;margin-right:8px">${t}</span>`;

  const links = [];
  if (r.homepage) { try { links.push(`<a href="${esc(r.homepage)}" style="color:#9b6cff;text-decoration:none">${esc(new URL(r.homepage).hostname)}</a>`); } catch {} }
  r.links.cnDemo.slice(0, 1).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#ff5c8a;font-weight:700;text-decoration:none">中文体验 → ${esc(l.url)}</a>`));
  r.links.demo.slice(0, 2).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#9b6cff;text-decoration:none">官方演示 → ${esc(l.url)}</a>`));
  r.links.docs.slice(0, 1).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#9b6cff;text-decoration:none">文档 → ${esc(l.url)}</a>`));
  r.links.paper.slice(0, 1).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#b08ccd;text-decoration:none">论文 → ${esc(l.url)}</a>`));

  const hook = ai?.hook || FALLBACK_HOOKS[i % FALLBACK_HOOKS.length](r.today, repoShort(r.repo));
  const cleanSum = /分析失败|HTTP 4\d\d/.test(r.summary || "") ? "" : (r.summary || "");
  const what = ai?.what || (cleanSum || CN(r.readmeCN?.slice(0, 500)) || CN(r.desc) || metaLine(r));
  // 开头总结+正文整块截图：微信会把 <p> 上的 font-size 剥回 16px，<b> 里的黑字也保不住，截图后与下方卡片字号一致
  const leadHtml = `<div data-block="card-lead-${i}" style="margin:0 0 4px">
  <p ${p}><b style="color:#1a1a1a">${md(hook)}</b></p>
  <p ${p}>${md(what)}</p>
</div>`;
  const caseHtml = (ai?.case || r.scenarios?.[0]) ? `<div data-block="card-case-${i}" style="margin:0 0 12px;padding:12px 14px;background-color:#fdf3fb;border:1px solid #ffe0f3;border-radius:12px;font-size:13px;line-height:1.9;color:#3a3a3a">${tag("案例举例")}${md(ai?.case || r.scenarios[0])}</div>` : "";
  const coreHtml = (ai?.core || r.mechanics?.length) ? `<div data-block="card-core-${i}" style="margin:0 0 12px;padding:12px 14px;background-color:#f6f2ff;border:1px solid #e6dbff;border-radius:12px;font-size:13px;line-height:1.9;color:#3a3a3a">${tag("怎么做到的")}${md(ai?.core || r.mechanics.join("；"))}</div>` : "";
  const whoHtml = (ai?.who || r.scenarios?.[1]) ? `<div data-block="card-who-${i}" style="margin:0 0 12px;padding:12px 14px;background-color:#fff4f2;border:1px solid #ffded8;border-radius:12px;font-size:13px;line-height:1.9;color:#3a3a3a">${tag("适合谁")}${md(ai?.who || r.scenarios[1])}</div>` : "";
  const fallbackBox = !ai && (CN(r.summary) || CN(r.desc)) ? `<div style="margin:0;padding:12px 14px;background-color:#fbf3ff;border-radius:12px;font-size:13px;color:#b08ccd;line-height:1.8"><strong>一句话概括：</strong>${esc(CN(r.summary) || CN(r.desc))}</div>` : "";
  // 收尾上手区：仓库地址 + 一句可直接复制给任意 AI Agent 的安装提示词
  const agentBox = `
<div data-block="card-agent-${i}" style="margin:16px 0 0;padding:14px 16px;background-color:#f8f1fb;background-image:linear-gradient(135deg,#fdf3fb,#eef6ff);border:2px solid #f3d9ff;border-radius:14px;font-size:13px;line-height:2;color:#3a3a3a">
  <b style="color:#c75bd6">🌈 仓库地址：</b><a href="https://github.com/${esc(r.repo)}" style="color:#9b6cff;text-decoration:none;font-weight:700">github.com/${esc(r.repo)}</a><br>
  <b style="color:#c75bd6">🤖 交给 Agent 安装：</b>把这句话发给任意 AI Agent（Claude Code / Codex / Cursor / Qwen Code 都行）——
  <span style="display:block;margin-top:6px;padding:9px 12px;background-color:#fff;border:2px dashed #e3b7f5;border-radius:10px;font-size:13px;line-height:1.8;color:#7a4fa8">帮我克隆 https://github.com/${esc(r.repo)}，按它 README 的说明装好依赖并运行起来，最后告诉我怎么用</span>
</div>`;

  return `
<div style="margin:0 0 34px;padding:0 2px 26px;border-bottom:1px solid #f3e0f0">
  <p style="margin:0 0 12px;font-size:19px;font-weight:800;color:#1a1a1a;line-height:1.4">
    <span style="display:inline-block;line-height:30px;text-align:center;min-width:30px;height:30px;padding:0 6px;border-radius:9px;background-color:#e07ad8;background-image:linear-gradient(135deg,#ff9ad5,#c77dff);color:#fff;font-size:15px;font-weight:900;vertical-align:middle;margin-right:10px">${String(i + 1).padStart(2, "0")}</span>
    <span style="vertical-align:middle;margin-right:10px">${esc(repoShort(r.repo))}</span>
    <span style="color:#c9a0d6;font-weight:500;font-size:12px;vertical-align:middle">${esc(r.lang)} · ${(r.stars || 0).toLocaleString()} ★ · 今日 ${fmtStars(r.today)}</span>
  </p>
  ${leadHtml}
  ${caseHtml}
  ${coreHtml}
  ${img}
  ${vids}
  ${links.length ? `<div style="margin:10px 0"><span style="font-size:13px">${links.join("　　")}</span></div>` : ""}
  ${whoHtml}
  ${agentBox}
  ${fallbackBox}
</div>`;
}

function buildHTML(data, cidMap) {
  const { day, repos: allRepos } = data;
  // 挂件：头部固定 5.png，文末每次从其余几张随机
  // 日榜按原顺序罗列，不做周榜沉底/去重
  const repos = allRepos;
  const top = repos[0];
  const cn = repos.filter((r) => r.links.cnDemo.length).length;
  const total = repos.reduce((s, r) => s + (+String(r.today || 0).replace(/,/g, "") || 0), 0);
  const sections = (() => {
    const parts = [];
    repos.forEach((r, i) => {
      parts.push(section(r, i, cidMap[r.repo] || ""));
    });
    return parts.join("");
  })();

  // 文首总览表：一chart表把今天的推荐直接铺开，oneliner 缺了就退回 trending 摘要/官方简介
  const ths = `padding:10px 8px;background-color:#f7f8fa;color:#5a6472;font-size:12px;font-weight:600;letter-spacing:.5px`;
  const seenOl = new Set();
  const rows = repos.map((r, i) => {
    // AI 偶尔把同一句套到多个仓库：重复的 oneliner 直接丢弃，退回该仓库自身摘要
    let ol = String(r.ai?.oneliner || "").trim();
    // 空话/比较句没信息量（没说清到底是哪件事），同样退回仓库自身摘要
    if (ol && /这个事|这件事|其他不行|别人不行|其他做不到/.test(ol)) ol = "";
    if (ol && seenOl.has(ol)) ol = "";
    if (ol) seenOl.add(ol);
    const line = String(ol || CN(r.judgment) || CN(r.summary) || CN(r.desc) || metaLine(r)).replace(/\*\*/g, "").replace(/\s+/g, " ");
    // 智能截断：到最近标点/空格，避免把词截一半
    const cut = (s, n) => { if (s.length <= n) return s; const t = s.slice(0, n); const m = Math.max(t.lastIndexOf("，"), t.lastIndexOf("。"), t.lastIndexOf("、"), t.lastIndexOf("；"), t.lastIndexOf("："), t.lastIndexOf(" ")); return (m > n / 2 ? t.slice(0, m + 1) : t) + "…"; };
    const line2 = cut(line, 60);
    const bg = i % 2 ? "#fdf5fc" : "#fff";
    return `<tr>
    <td style="background-color:${bg};padding:10px 6px;color:#c77dff;font-weight:800;vertical-align:top;border-top:1px solid #f7e9f5">${String(i + 1).padStart(2, "0")}</td>
    <td style="background-color:${bg};padding:10px 8px;word-break:break-all;vertical-align:top;border-top:1px solid #f7e9f5"><a href="${esc(r.url)}" style="color:#9b6cff;font-weight:700;text-decoration:none">${esc(repoShort(r.repo))}</a></td>
    <td style="background-color:${bg};padding:10px 8px;color:#3a3a3a;line-height:1.6;font-size:11px;border-top:1px solid #f7e9f5">${esc(line2)}</td>
    <td style="background-color:${bg};padding:10px 8px 10px 4px;color:#ff5c8a;white-space:nowrap;text-align:right;vertical-align:top;font-size:12px;font-weight:700;border-top:1px solid #f7e9f5">${fmtStars(r.today)}</td>
  </tr>`;
  }).join("");
  const overview = repos.length ? `
<p style="margin:0 0 14px;font-size:18px;font-weight:900;color:#c77dff">🌸 热榜总览表</p>
<div style="border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(159,108,255,.12);border:2px solid #f3d9ff;margin:0 0 34px">
<table style="width:100%;border-collapse:collapse;font-size:13px;background-color:#fff;table-layout:fixed">
  <tr>
    <th align="left" style="${ths};background-color:#e07ad8;background-image:linear-gradient(135deg,#ff9ad5,#c77dff);color:#fff;width:26px">#</th>
    <th align="left" style="${ths};background-color:#e07ad8;background-image:linear-gradient(135deg,#ff9ad5,#c77dff);color:#fff;width:24%">仓库</th>
    <th align="left" style="${ths};padding-left:12px;background-color:#e07ad8;background-image:linear-gradient(135deg,#ff9ad5,#c77dff);color:#fff">一眼看懂</th>
    <th align="right" style="${ths};background-color:#e07ad8;background-image:linear-gradient(135deg,#ff9ad5,#c77dff);color:#fff;width:48px">今日</th>
  </tr>
  ${rows}
</table>
</div>` : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>最新开源AI技术分享 ${day}</title></head>
<body style="margin:0;background-color:#fdf3fb">
<div style="max-width:677px;margin:0 auto;background-color:#fffdfd;padding:0 20px 40px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">

<div data-block="header" style="margin:0 0 0;padding:28px 20px;background-color:#c77dff;background-image:linear-gradient(135deg,#ff9ad5 0%,#c77dff 55%,#8ab4ff 100%);color:#fff;overflow:hidden">
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="vertical-align:middle;padding-right:14px">
      <p style="margin:0 0 8px;font-size:28px;font-weight:900;line-height:1.3;letter-spacing:1px">最新开源AI技术分享</p>
      <p style="margin:0;font-size:13.5px;line-height:1.8">把今天最值得动手的 AI 开源仓库，用大白话讲给你听，一眼看懂能干嘛。</p>
    </td>
    <td style="width:112px;vertical-align:middle">${mascot("5.png", 112)}</td>
  </tr></table>
</div>

<p style="margin:16px 0 0;font-size:13px;color:#b08ccd;font-weight:700;text-align:center">🌸 分享最新开源免费 AI 技术，帮普通人提效工作、改变生活 🌸</p>

${overview}

${top ? `<div data-block="top" style="background-color:#e07ad8;background-image:linear-gradient(135deg,#ff9ad5,#c77dff);color:#fff;border-radius:18px;padding:22px 24px;margin:0 0 30px;box-shadow:0 8px 26px rgba(199,125,255,.28);border:2px solid #ffe0f3">
  <p style="margin:0 0 10px;font-size:13px;font-weight:800;letter-spacing:2px;opacity:.95">🌟 今日最闪耀</p>
  <p style="margin:0 0 10px;font-size:24px;font-weight:900;line-height:1.35">${esc(repoShort(top.repo))}</p>
  <p style="margin:0 0 14px;font-size:14px;line-height:1.8;opacity:.97">${esc(String(top.ai?.what || CN(top.summary) || CN(top.desc) || metaLine(top)).slice(0, 130))}</p>
  <div style="display:inline-block;background-color:rgba(255,255,255,.2);border-radius:20px;padding:5px 16px;font-size:13px;font-weight:700">今日 ${fmtStars(top.today)} ★ · 总 ${(top.stars || 0).toLocaleString()} ★</div>
</div>` : ""}

${sections}

${(data.featured && data.featured.length) ? `
<div style="margin:0 0 34px;padding:22px 20px;background-color:#f8f1fb;background-image:linear-gradient(135deg,#fdf3fb,#eef6ff);border-radius:18px;border:2px solid #f3d9ff">
  <p style="margin:0 0 8px;font-size:18px;font-weight:900;color:#9b6cff">🚀 新晋潜力 · 从 0 快速增长的黑马</p>
  <p style="margin:0 0 16px;font-size:13px;color:#b08ccd;line-height:1.7">这些是最近新建立、还没上日榜，但星数涨得飞快的仓库——真正值得早关注的黑马。</p>
  ${data.featured.map((r, i) => {
    const ai = r.ai;
    const hook = ai?.hook || `新晋开源，${(r.stars || 0).toLocaleString()} ★，值得放进收藏。`;
    return `
  <div style="margin:0 0 14px;padding:16px 18px;background-color:#fff;border-radius:14px;border:2px solid #ffe0f3;box-shadow:0 3px 12px rgba(199,125,255,.08)">
    <div style="margin:0 0 8px;font-size:15px;font-weight:700;color:#1a1a1a"><span style="display:inline-block;background-color:#e07ad8;background-image:linear-gradient(135deg,#ff9ad5,#c77dff);color:#fff;border-radius:6px;padding:2px 9px;font-size:11px;margin-right:8px">${String(i + 1).padStart(2, "0")}</span><a href="${esc(r.url)}" style="color:#9b6cff;text-decoration:none;font-weight:800">${esc(r.repo)}</a></div>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.8;color:#3a3a3a"><b>${md(hook)}</b></p>
    <p style="margin:0 0 10px;font-size:13px;line-height:1.8;color:#5a6472">${md(ai?.what || CN(r.summary) || CN(r.desc) || metaLine(r))}</p>
    <div data-block="feat-meta-${i}" style="margin:0;font-size:12px;color:#b08ccd">${(r.stars || 0).toLocaleString()} ★ · ${esc(r.lang || "")} · <a href="${esc(r.url)}" style="color:#c77dff;font-weight:700">仓库 →</a></div>
  </div>`;
  }).join("")}
</div>` : ""}

<div data-block="footer" style="margin:6px 0 22px;padding:20px;background-color:#e07ad8;background-image:linear-gradient(135deg,#ff9ad5,#c77dff);border-radius:16px;color:#fff;text-align:center;border:2px solid #ffe0f3">
  <table style="width:100%;border-collapse:collapse"><tr>
    <td style="width:112px;vertical-align:middle">${mascot(Math.floor(Math.random() * 1000), 112, "5.png")}</td>
    <td style="vertical-align:middle;padding-left:12px;font-size:16px;font-weight:900;letter-spacing:1px;text-align:left">✨ 分享最新开源免费 AI 技术，帮普通人提效工作、改变生活 ✨</td>
  </tr></table>
  <p style="margin:10px 0 0;font-size:12.5px">每天陪你一起发现好用的新仓库，轻松提升效率。</p>
</div>

<div data-block="footer-note" style="margin-top:14px;padding:16px 18px;background-color:#fbf3ff;border-radius:12px;font-size:12.5px;color:#b08ccd;line-height:1.85;text-align:center">
  <p style="margin:0">本文内容仅作参考，具体以各仓库官方说明为准。</p>
</div>

</div></body></html>`;
}

// ---------- 彩色板块整块转图 ----------
// 微信粘贴时会剥掉所有 CSS 背景（background-color 和 background-image 都可能丢），
// 把带背景的板块连文字一起截图，粘进公众号才能原样保留，也顺手解决 table 宽度跑偏
async function blocksToImages(html, day) {
  let browser;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"] });
    // 2x 出图：公众号内容区宽 677，按 2 倍截才不发虚
    const ctx = await browser.newContext({ viewport: { width: 720, height: 1000 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "load" });
    // 明确指定中文字体：CI 是 Linux（Noto CJK），本地是 Windows（微软雅黑），不指定会退成方框
    // 截图完必须移除，否则 page.content() 会把它带进最终 HTML，反过来改公众号里的字体
    const fontTag = await page.addStyleTag({
      content: `body,body *{font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC","Noto Sans SC","WenQuanYi Zen Hei","Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif !important}`,
    });
    await page.waitForTimeout(300);
    const els = await page.$$("[data-block]");
    for (const el of els) {
      const name = await el.getAttribute("data-block");
      // 只有三张渐变大图用 PNG，其余文字块（每仓库 5 张）用 JPEG 控体积
      const isCard = !["header", "top", "footer"].includes(name);
      const buf = await el.screenshot(isCard ? { type: "jpeg", quality: 90 } : { type: "png" });
      const ext = isCard ? "jpg" : "png";
      const mime = isCard ? "image/jpeg" : "image/png";
      // 文件名带内容哈希：同一天重跑换了内容，jsDelivr 也不会返回旧图
      const hash = createHash("md5").update(buf).digest("hex").slice(0, 8);
      const rel = `shots/${day}-block-${name}-${hash}.${ext}`;
      writeFileSync(join(ROOT, rel), buf);
      await el.evaluate((e, arg) => {
        const cs = getComputedStyle(e);
        const img = document.createElement("img");
        img.src = arg.src;
        img.setAttribute("data-file", arg.rel);
        img.setAttribute("alt", "");
        img.style.cssText = `width:100%;display:block;margin:${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`;
        e.replaceWith(img);
      }, { src: `data:${mime};base64,${buf.toString("base64")}`, rel });
    }
    await fontTag.evaluate((e) => e.remove()).catch(() => {});
    return await page.content();
  } catch (e) {
    process.stderr.write(`[板块截图] 失败（${e.message.slice(0, 80)}）→ 退回纯 CSS 版\n`);
    return html;
  } finally {
    if (browser) await browser.close();
  }
}

// ---------- 公众号版转换 ----------
// 微信编辑器不接收 base64 图片，必须换成公网可访问的图片地址（粘贴时微信自动转存到自己服务器）
const REPO_CDN = "https://cdn.jsdelivr.net/gh/pephupephu/Github-daily-report@main/";
function toWechat(src, map) {
  // 内联图（挂件 / 彩色板块截图）-> 仓库里的原图外链
  let out = src.replace(/<img([^>]*?)src="data:image\/[^"]*"([^>]*?)>/g, (m, a, b) => {
    const f = (m.match(/data-file="([^"]+)"/) || [])[1];
    return f ? `<img${a}src="${REPO_CDN}${f}"${b}>` : m;
  });
  // 截图：cid -> 仓库里的原图外链
  out = out.replace(/src="cid:([^"]+)"/g, (m, cid) => {
    const v = map[cid];
    if (!v?.path) return m;
    const rel = v.path.replace(ROOT, "").replace(/\\/g, "/").replace(/^\/+/, "");
    return `src="${REPO_CDN}${rel}"`;
  });
  // 渐变：微信剥 linear-gradient，换成同款渐变的图片底（100% 100% 拉伸，线性渐变拉伸不变形）
  const grads = [
    ["linear-gradient(135deg,#ff9ad5 0%,#c77dff 55%,#8ab4ff 100%)", "header.png"],
    ["linear-gradient(135deg,#ff9ad5,#c77dff)", "card.png"],
    ["linear-gradient(135deg,#fdf3fb,#eef6ff)", "soft.png"],
  ];
  for (const [grad, bgFile] of grads) {
    out = out.split(`background-image:${grad}`).join(
      `background-image:url(${REPO_CDN}assets/bg/${bgFile});background-size:100% 100%;background-repeat:no-repeat`
    );
  }
  return out;
}

// ---------- Word 文稿（.docx）----------

function buildDocx(data, cidMap) {
  const { day, repos: allRepos } = data;
  // 日榜按原顺序罗列，不做周榜沉底/去重
  const repos = allRepos;
  const total = repos.reduce((s, r) => s + (+String(r.today || 0).replace(/,/g, "") || 0), 0);
  const clean = (s) => deAI(String(s ?? "")).replace(/\*\*/g, "").trim();
  const para = (text, { bold = false, size = 21, color, before = 0, after = 140 } = {}) =>
    new Paragraph({ spacing: { before, after }, children: [new TextRun({ text, bold, size, color, font: "微软雅黑" })] });
  // 每个仓库的截图路径：cidMap[r.repo] 是 cid，cidMap[cid].path 是本地文件；自动量宽度等比缩放
  const imgPara = (r) => {
    const cid = r.shotCid || cidMap[r.repo];
    const hit = cid && cidMap[cid];
    if (!hit?.path) return [];
    try {
      const buf = readFileSync(hit.path);
      const type = String(hit.path).split(".").pop().toLowerCase().replace("jpeg", "jpg");
      if (!["png", "jpg", "gif", "bmp"].includes(type)) return [];
      return [new Paragraph({
        spacing: { before: 60, after: 120 },
        children: [new ImageRun({ data: buf, type, transformation: { width: 520, height: 320 } })],
      })];
    } catch { return []; }
  };

  const children = [
    para("🌸 最新开源AI技术分享", { bold: true, size: 36, color: "C77DFF", after: 60 }),
    para("把今天最值得动手的 AI 开源仓库，用大白话讲给你听", { color: "9B6CFF", size: 20, after: 260 }),
  ];

  let num = 0;
  const writeRepo = (r) => {
    const ai = r.ai;
    const i = num++;
    children.push(para(`${String(i + 1).padStart(2, "0")} ${repoShort(r.repo)}`, { bold: true, size: 28, color: "07A050", before: 240, after: 60 }));
    children.push(para(`${r.lang || ""} · ${(r.stars || 0).toLocaleString()} ★ · 今日 +${r.today || 0}`, { color: "9A9A9A", size: 18, after: 120 }));
    children.push(para(clean(ai?.hook || FALLBACK_HOOKS[i % FALLBACK_HOOKS.length](r.today, repoShort(r.repo))), { bold: true }));
    children.push(para(clean(ai?.what || CN(r.summary) || CN(r.readmeCN?.slice(0, 500)) || CN(r.desc) || metaLine(r))));
    // 演示截图直接嵌进 Word，方便打开即看图
    children.push(...imgPara(r));
    const cs = ai?.case || r.scenarios?.[0];
    if (cs) children.push(para(`案例举例：${clean(cs)}`));
    const core = ai?.core || (r.mechanics?.length ? r.mechanics.join("；") : "");
    if (core) children.push(para(`它是怎么做到的：${clean(core)}`));
    const who = ai?.who || r.scenarios?.[1];
    if (who) children.push(para(`适合谁：${clean(who)}`));
    // 演示视频：Word 内嵌播放不现实，放可点击链接（微信发视频也走链接/上传）
    const vids = (r.videos || []).slice(0, 3);
    if (vids.length) {
      const labels = vids.map((v) => `${v.type === "file" ? "演示动图" : "演示视频"} → ${v.url}`).join("\n");
      children.push(para(labels, { size: 18, color: "576B95", after: 60 }));
    }
    children.push(para(`仓库地址：https://github.com/${r.repo}`, { color: "576B95", size: 19, after: 60 }));
    children.push(para(`交给 Agent 安装：帮我克隆 https://github.com/${r.repo}，按它 README 的说明装好依赖并运行起来，最后告诉我怎么用`, { size: 19, after: 220 }));
  };
  // 日榜按原顺序罗列
  repos.forEach(writeRepo);

  children.push(para("🌸 分享最新开源免费 AI 技术，帮普通人提效工作、改变生活 🌸", { bold: true, size: 22, color: "C77DFF", before: 320, after: 40 }));
  children.push(para("本文内容仅作参考，具体以各仓库官方说明为准。", { color: "B08CCD", size: 18, before: 40, after: 80 }));

  // 「值得关注」板块也进 Word（和 HTML 对齐）
  const feat = (data.featured || []).filter((r) => r && r.repo);
  if (feat.length) {
    children.push(para("🚀 新晋潜力 · 从 0 快速增长的黑马", { bold: true, size: 26, color: "9B6CFF", before: 360, after: 100 }));
    feat.forEach((r, i) => {
      const ai = r.ai;
      children.push(para(`${String(i + 1).padStart(2, "0")} ${repoShort(r.repo)}`, { bold: true, size: 26, color: "C77DFF", before: 220, after: 60 }));
      children.push(para(`${(r.stars || 0).toLocaleString()} ★ · ${r.lang || ""}`, { color: "9A9A9A", size: 18, after: 100 }));
      children.push(para(clean(ai?.hook || `新晋开源，${(r.stars || 0).toLocaleString()} ★，值得放进收藏。`), { bold: true }));
      children.push(para(clean(ai?.what || CN(r.summary) || CN(r.desc) || metaLine(r))));
      children.push(...imgPara(r));
      children.push(para(`仓库地址：https://github.com/${r.repo}`, { color: "576B95", size: 19, after: 200 }));
    });
  }

  return new Document({ sections: [{ children }] });
}

// ---------- 主流程 ----------

let data;
try { data = JSON.parse(readFileSync(join(ROOT, "reports", "latest.json"), "utf8")); }
catch { console.error("找不到 reports/latest.json —— 先跑 node trending.mjs"); process.exit(1); }

console.error(`[文章] 处理 ${data.repos.length} 个项目…`);
if (!LLM) console.error("[警告] 未配置 OPENAI_API_KEY —— 本次为简版文章。去 GitHub 仓库 Settings > Secrets > Actions 添加 OPENAI_API_KEY");
let cidMap = {};
let usedHooks = [];
await withBrowser(async (page) => {
  for (const [i, r] of data.repos.entries()) {
  const md = await readme(r.repo);
  r.links = classify(parseLinks(md), r.repo, r.homepage);
  r.videos = extractVideos(md, r.url, r.repo);
  r.ai = await analyzeOne(r, md, usedHooks);
  if (r.ai?.hook) usedHooks.push(r.ai.hook);
    // 优先用 README 里的产品图（真实界面/演示），比盲截首页更有代表性；拿不到才截 demo 首屏
    const heroUrl = readmeHero(md, r.repo);
    const heroPath = heroUrl ? await grabImage(heroUrl, join(ROOT, "shots", `${r.repo.replace("/", "__")}.${imgExt(heroUrl)}`)) : null;
    if (heroPath) {
      const cid = `shot-${i}`;
      r.shotCid = cid;
      cidMap[r.repo] = cid;
      cidMap[cid] = { path: heroPath };
    } else if (page && !r.links.cnDemo.length) {
      const targets = [...r.links.demo.slice(0, 1).map((l) => l.url), r.homepage].filter(Boolean);
      for (const cand of targets) {
        const hit = await probeAndShot(page, cand, r.repo);
        if (hit.cnUrls.length) {
          r.links.cnDemo = hit.cnUrls.map((u) => ({ url: u, text: "", probed: true }));
          break;
        }
        if (hit.shotPath) {
          const cid = `shot-${i}`;
          r.shotCid = cid;
          cidMap[r.repo] = cid;
          cidMap[cid] = { path: hit.shotPath };
        }
      }
    } else if (page) {
      // 先真的打开中文入口再截图——此前直接截的 page 还停在上一仓库的页面，错图/空白都因这
      const hit = await probeAndShot(page, r.links.cnDemo[0].url, r.repo);
      if (hit.shotPath) {
        const cid = `shot-${i}`;
        r.shotCid = cid;
        cidMap[r.repo] = cid;
        cidMap[cid] = { path: hit.shotPath };
      }
    }
    process.stderr.write(`  ${i + 1}/${data.repos.length} ${r.repo} → 演示${r.links.demo.length} 中文${r.links.cnDemo.length} AI:${r.ai ? "✓" : "✗"}\n`);
    await new Promise((s) => setTimeout(s, 10000));
  }
  // 「值得关注」板块：权威发布源的新仓库，走同一套分析管线
  const featured = data.featured || [];
  for (let fi = 0; fi < featured.length; fi++) {
    const r = featured[fi];
    const md = await readme(r.repo);
    r.links = classify(parseLinks(md), r.repo, r.homepage);
    r.videos = extractVideos(md, r.url, r.repo);
    r.ai = await analyzeOne(r, md, usedHooks);
    if (r.ai?.hook) usedHooks.push(r.ai.hook);
    const heroUrl = readmeHero(md, r.repo);
    const heroPath = heroUrl ? await grabImage(heroUrl, join(ROOT, "shots", `feat__${r.repo.replace("/", "__")}.${imgExt(heroUrl)}`)) : null;
    if (heroPath) {
      const cid = `feat-${fi}`;
      r.shotCid = cid;
      cidMap[r.repo] = cid;   // 与 section() 的 cidMap[r.repo] 取值保持一致
      cidMap[cid] = { path: heroPath };
    }
    process.stderr.write(`  [值得关注] ${fi + 1}/${featured.length} ${r.repo} → AI:${r.ai ? "✓" : "✗"}\n`);
    await new Promise((s) => setTimeout(s, 10000));
  }
  if (page) await page.close();
});

// 质量门槛：AI 分析失败、又没有一句像样中文介绍的，直接拿掉——宁缺毋滥，不浪费读者时间
function substantive(r) {
  // 空壳：正文该讲实质的核心字段全是占位符"无"，即使有 one-line 简介也不够——拿掉
  const emptyShell = ["what", "core", "case"].every((k) => {
    const v = String(r.ai?.[k] || "").trim();
    return !v || v === "无" || v.length < 4;
  });
  if (emptyShell) return false;
  if (r.ai?.what && r.ai.what.length > 20) return true;          // AI 讲出了实质内容
  const sum = String(r.summary || "").replace(/分析失败|HTTP 4\d\d/g, "").trim();
  const cdesc = /[\u4e00-\u9fa5]{4,}/.test(r.desc || "") ? r.desc : "";
  return (sum.length >= 20) || (cdesc.length >= 20);             // 有一段像样的中文才算数
}
const before = data.repos.length;
data.repos = data.repos.filter(substantive);
const dropped = before - data.repos.length;
if (dropped) console.error(`[文章] 质量门槛：剔除 ${dropped} 个无实质介绍的仓库（AI 分析失败且无可用中文简介）`);
if (data.featured) data.featured = data.featured.filter(substantive);

mkdirSync(join(ROOT, "out"), { recursive: true });
// 彩色板块先整块截图，邮件里内联、公众号版换外链
const html = await blocksToImages(buildHTML(data, cidMap), data.day);

// 落盘的就是公众号版：浏览器打开有图、全选复制粘进公众号也保持同样的排版
const wechatHtml = toWechat(html, cidMap);
const file = join(ROOT, "out", `article-${data.day}.html`);
writeFileSync(file, wechatHtml);
const docxBuf = await Packer.toBuffer(buildDocx(data, cidMap));
writeFileSync(join(ROOT, "out", `article-${data.day}.docx`), docxBuf);
console.error(`[文章] 已生成 ${file}（图片为公网外链，Chrome 打开后全选复制即可粘进公众号）与 article-${data.day}.docx`);

const user = process.env.MAIL_USER, pass = process.env.MAIL_PASS;
if (!user || !pass) { console.error("[文章] 未配置 MAIL_USER/MAIL_PASS，跳过发信"); process.exit(0); }
const port = Number(process.env.MAIL_PORT || 465);
const transport = createTransport({ host: process.env.MAIL_HOST || "smtp.163.com", port, secure: port === 465, auth: { user, pass } });

const attachments = Object.entries(cidMap)
  .filter(([k]) => k.startsWith("shot-"))
  .map(([k, v]) => ({ filename: `${k}.${(v.path.split(".").pop() || "png").toLowerCase()}`, path: v.path, cid: k }));
attachments.push({ filename: `GitHub日报-${data.day}.docx`, content: docxBuf });
attachments.push({ filename: `公众号直发-${data.day}.html`, content: readFileSync(file) });

try {
  await transport.sendMail({
    from: `"GitHub 日报" <${user}>`,
    to: process.env.MAIL_TO || user,
    subject: `【公众号初稿】GitHub 热榜 ${data.day} · ${data.repos.length} 个项目 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`,
    // 正文用内联图版：手机邮箱访问不了 jsDelivr，内联图才能显示；复制到公众号请用下载的 html 附件
    html,
    attachments,
  });
  console.error(`[文章] 已发送 ${data.repos.length} 个项目到邮箱，附件截图 ${attachments.length} 张`);
} catch (e) {
  // 发送失败也别让整个 job 变红：文章已在仓库里，重跑一次即可
  console.error(`[邮件] 发送失败：${e.message}（文章已生成并归档，重跑 workflow 即可补发）`);
}