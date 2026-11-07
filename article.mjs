#!/usr/bin/env node
// 读 reports/latest.json -> 浏览器渲染抓中文入口+截图
// -> 生成「公众号风格」文章初稿 -> 截图附件内嵌发邮箱
// 定位：AI 出文章骨架 + 链接 + 部署命令，“真实体验/多媒体”留占位给人填
// 用法: node article.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTransport } from "nodemailer";
import { Document, Packer, Paragraph, TextRun, ImageRun } from "docx";

const ROOT = dirname(fileURLToPath(import.meta.url));
const UA = { "user-agent": "gh-daily-article" };

// ---------- 大模型逐个深度分析（OpenAI 兼容协议；默认智谱 glm-4-flash 免费档）----------

const LLM_KEYS = [process.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY_2, process.env.OPENAI_API_KEY_3, process.env.OPENAI_API_KEY_4, process.env.OPENAI_API_KEY_5]
  .filter(Boolean);
const LLM = LLM_KEYS.length
  ? {
      keys: LLM_KEYS,
      base: (process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
      model: process.env.OPENAI_MODEL || "deepseek-flash",
    }
  : null;
let LLM_KEY_IDX = 0; // 轮换指针：摊平多账号限流

const AI_PROMPT = `你是资深公众号科技编辑，为一个 GitHub 热门项目写中文深度解读。要求像真人作者写的：口语化、句子完整通顺、有具体细节、不说空话、不堆术语（出现专业词就用半句话解释它对读者的意义）。

仓库名：{repo}（{lang}，总星 {stars}，今日涨 {today}）
官方简介：{desc}
README 摘录：
{readme}

本期已用过的开头角度：{used}
hook（开头）是全文胜负手：读者看完这一句才决定要不要往下读。从该仓库自身找一个具体抓手——一个扎眼的数字、一个真实痛点、一个反常识的设计决策、或一句“终于有人把它做出来了”的感叹——像人随口跟朋友说话那样写出来，有画面、有悬念，但不是标题党。禁止以“分享一个”“爆火”“上榜”“今天看到”这类套话开头，禁止喊口号和排比。

只输出 JSON（不要代码块、不要任何解释）：
{"hook":"开头一句，30字内。直接给一个具体成果或场景：谁用它能做到什么，带关键数字或名词，让人一眼看到画面；禁止出现：爆火/火得有理由/涨得最凶/杀疯了/上榜/分享一个/今天看到/值得一看","oneliner":"18字内直戳它最牛的那一点：杀手锏能力/最抓眼的数字/别人做不到而它做到了，例如：本地跑通 70B 大模型；10 行代码生成整个后台；禁止'平台/框架/生态/无缝/赋能'，禁止写成'这是一个…工具'","what":"3到4句大白话：第一句就说透它最厉害的地方（像'把 AI 接进 iPhone，让它自己帮你操作手机'），不要从'这是一个…项目'开头，不要提实现方式；后面说清它解决谁的问题，带一个具体的输入→输出例子，没接触过的人能秒懂","case":"2到3句一个贴合实际的运用案例：谁（具体身份）、被什么卡住、拆成具体动作怎么解决（第一步…第二步…）、前后省了什么。基于 README 能力，不编造","core":"3到4句讲清它是怎么做到的：点名关键部件、步骤和数据流向，说清为什么有效。基于 README 事实，不编造","who":"适合谁用，具体到身份，如：天天让 AI 写页面但总不满意的前端开发"}

全文对"完全不写代码的普通人"说人话。英文专业词一个都不许保留原样，必须翻成中文日常说法，翻不了就拆成大白话解释它管什么用。例如："Decoder-only Transformer"→"只看上文往下猜字的一个模型"、"Wayland 合成器"→"替系统画屏幕、排窗口的软件"、"MoE"→"平时只叫一部分脑子干活、省电"、"MCP"→"让两个软件能互相说话的接头"、"Tokenizer"→"把一句话切成一粒粒小词的切词器"。专有缩写（AI、GPU、手机、Windows）除外。凡是像"SDK/API/CLI/FFI/GGUF/Optuna/IPC/组件/算子/协议"这类读者会卡壳的词，要么换成人话，要么先给一个"说白了就是X"的括号解释，绝不允许原样扔出来。出现英文词必须紧跟着用中文说清楚它是什么。读者是不写代码的人也能看懂。

禁止 AI 腔套话，一次都不许出现：值得注意的是、总的来说、总而言之、不可否认、在当今、极大地、深入地、一站式、赋能、致力于、旨在、此外、然而、因此、从而、无缝衔接。写具体事、具体数字、具体动作。

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
      <div style="margin:10px 0;padding:12px;background:#fff;border:1px solid #e1e4e8;border-radius:8px">
        <a href="${esc(v.url)}" style="text-decoration:none;display:block">
          <div style="position:relative;width:100%;max-width:560px;padding-bottom:56.25%;overflow:hidden;border-radius:6px;margin-bottom:8px">
            <img src="${esc(v.thumb)}" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover" onerror="this.src='https://img.youtube.com/vi/${esc(v.id)}/default.jpg'">
            <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:40px;color:#fff;opacity:0.85;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5))">▶</div>
          </div>
          <div style="font-size:13px;color:#1a1a1a">${esc(`YouTube 演示 · ${v.id}`)}</div>
        </a>
      </div>`;
    }
    if (v.type === 'bilibili') {
      return `
      <div style="margin:10px 0;padding:12px;background:#fff;border:1px solid #e1e4e8;border-radius:8px">
        <a href="${esc(v.url)}" style="text-decoration:none;display:block">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:48px;height:36px;background:#191919;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700">B</div>
            <div style="font-size:13px;color:#1a1a1a">Bilibili 演示 · ${esc(v.id)}</div>
          </div>
        </a>
      </div>`;
    }
    if (v.type === 'vimeo') {
      return `
      <div style="margin:10px 0;padding:12px;background:#fff;border:1px solid #e1e4e8;border-radius:8px">
        <a href="${esc(v.url)}" style="text-decoration:none;display:block">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:48px;height:36px;background:#1ab7ea;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700">V</div>
            <div style="font-size:13px;color:#1a1a1a">Vimeo 演示 · ${esc(v.id)}</div>
          </div>
        </a>
      </div>`;
    }
    // 直接文件
    let fname = v.url; try { fname = new URL(v.url).pathname.split('/').pop() || v.url; } catch {}
    return `
    <div style="margin:10px 0;padding:12px;background:#fff;border:1px solid #e1e4e8;border-radius:8px">
      <a href="${esc(v.url)}" style="text-decoration:none;display:block">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:48px;height:36px;background:#282c34;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700">▶</div>
        <div style="font-size:13px;color:#1a1a1a">${esc(v.thumb ? '演示动图' : '演示视频')} · ${esc(fname)}</div>
        </div>
      </a>
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
const fmtStars = (n) => `+${String(n || 0).replace(/,/g, "")}`;
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
  const p = `style="margin:0 0 10px;font-size:15px;line-height:1.9;color:#3a3a3a"`;
  // 小节标签：绿胶囊，给 case/core/who 一个统一视觉
  const tag = (t) => `<span style="display:inline-block;background:#e8f7ee;color:#07a055;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:700;margin-right:8px">${t}</span>`;

  const links = [];
  if (r.homepage) { try { links.push(`<a href="${esc(r.homepage)}" style="color:#576b95;text-decoration:none">${esc(new URL(r.homepage).hostname)}</a>`); } catch {} }
  r.links.cnDemo.slice(0, 1).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#fa5151;font-weight:700;text-decoration:none">中文体验 → ${esc(l.url)}</a>`));
  r.links.demo.slice(0, 2).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#576b95;text-decoration:none">官方演示 → ${esc(l.url)}</a>`));
  r.links.docs.slice(0, 1).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#576b95;text-decoration:none">文档 → ${esc(l.url)}</a>`));
  r.links.paper.slice(0, 1).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#8a6d3b;text-decoration:none">论文 → ${esc(l.url)}</a>`));

  const hook = ai?.hook || FALLBACK_HOOKS[i % FALLBACK_HOOKS.length](r.today, repoShort(r.repo));
  const cleanSum = /分析失败|HTTP 4\d\d/.test(r.summary || "") ? "" : (r.summary || "");
  const what = ai?.what || (cleanSum || CN(r.readmeCN?.slice(0, 500)) || CN(r.desc) || metaLine(r));
  const caseHtml = (ai?.case || r.scenarios?.[0]) ? `<div style="margin:0 0 12px;padding:12px 14px;background:#f7fdf9;border:1px solid #dff3e8;border-radius:10px;font-size:15px;line-height:1.9;color:#3a3a3a">${tag("真实场景")}${md(ai?.case || r.scenarios[0])}</div>` : "";
  const coreHtml = (ai?.core || r.mechanics?.length) ? `<div style="margin:0 0 12px;padding:12px 14px;background:#f7f9fb;border:1px solid #eceef1;border-radius:10px;font-size:15px;line-height:1.9;color:#3a3a3a">${tag("怎么做到的")}${md(ai?.core || r.mechanics.join("；"))}</div>` : "";
  const whoHtml = (ai?.who || r.scenarios?.[1]) ? `<div style="margin:0 0 12px;padding:12px 14px;background:#fbf7f0;border:1px solid #f1e6d6;border-radius:10px;font-size:15px;line-height:1.9;color:#3a3a3a">${tag("适合谁")}${md(ai?.who || r.scenarios[1])}</div>` : "";
  const fallbackBox = !ai && (CN(r.summary) || CN(r.desc)) ? `<div style="margin:0;padding:12px 14px;background:#f7f8fa;border-radius:10px;font-size:13px;color:#5a6472;line-height:1.8"><strong>一句话概括：</strong>${esc(CN(r.summary) || CN(r.desc))}</div>` : "";
  // 收尾上手区：仓库地址 + 一句可直接复制给任意 AI Agent 的安装提示词
  const agentBox = `
<div style="margin:16px 0 0;padding:14px 16px;background:linear-gradient(135deg,#f7fdf9,#eef8f2);border:1px solid #d8f0e0;border-radius:12px;font-size:14px;line-height:2;color:#3a3a3a">
  <b style="color:#1a1a1a">仓库地址：</b><a href="https://github.com/${esc(r.repo)}" style="color:#576b95;text-decoration:none">github.com/${esc(r.repo)}</a><br>
  <b style="color:#1a1a1a">交给 Agent 安装：</b>把这句话发给任意 AI Agent（Claude Code / Codex / Cursor / Qwen Code 都行）——
  <span style="display:block;margin-top:6px;padding:9px 12px;background:#fff;border:1px dashed #b8ddc6;border-radius:8px;font-size:13px;line-height:1.8;color:#2e5c45">帮我克隆 https://github.com/${esc(r.repo)}，按它 README 的说明装好依赖并运行起来，最后告诉我怎么用</span>
</div>`;

  return `
<section style="margin:0 0 34px;padding:0 2px 26px;border-bottom:1px solid #eceef1">
  <h2 style="margin:0 0 12px;display:flex;align-items:center;font-size:19px;font-weight:700;color:#1a1a1a;line-height:1.4">
    <span style="display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;padding:0 6px;border-radius:8px;background:linear-gradient(135deg,#07c160,#0aa8a0);color:#fff;font-size:15px;font-weight:800;margin-right:10px">${String(i + 1).padStart(2, "0")}</span>
    <span style="margin-right:10px">${esc(repoShort(r.repo))}</span>
    <small style="color:#9a9a9a;font-weight:400;font-size:12px">${esc(r.lang)} · ${(r.stars || 0).toLocaleString()} ★ · 今日 ${fmtStars(r.today)}</small>
  </h2>
  <p ${p}"><b style="color:#1a1a1a">${md(hook)}</b></p>
  <p ${p}">${md(what)}</p>
  ${caseHtml}
  ${coreHtml}
  ${img}
  ${vids}
  ${links.length ? `<div style="margin:10px 0">${links.join("　　")}</div>` : ""}
  ${whoHtml}
  ${agentBox}
  ${fallbackBox}
</section>`;
}

function buildHTML(data, cidMap) {
  const { day, repos } = data;
  const top = repos[0];
  const cn = repos.filter((r) => r.links.cnDemo.length).length;
  const total = repos.reduce((s, r) => s + (+String(r.today || 0).replace(/,/g, "") || 0), 0);
  const sections = repos.map((r, i) => section(r, i, cidMap[r.repo] || "")).join("");

  // 文首总览表：一chart表把今天的推荐直接铺开，oneliner 缺了就退回 trending 摘要/官方简介
  const ths = `padding:10px 8px;background:#f7f8fa;color:#5a6472;font-size:12px;font-weight:600;letter-spacing:.5px`;
  const rows = repos.map((r, i) => {
    const line = String(r.ai?.oneliner || CN(r.judgment) || CN(r.summary) || CN(r.desc) || metaLine(r)).replace(/\*\*/g, "").replace(/\s+/g, " ").slice(0, 26);
    return `<tr style="background:${i % 2 ? "#fbfcfd" : "#fff"}">
    <td style="padding:10px 8px 10px 12px;color:#07c160;font-weight:800;vertical-align:top;border-top:1px solid #f0f1f3">${String(i + 1).padStart(2, "0")}</td>
    <td style="padding:10px 8px;white-space:nowrap;vertical-align:top;border-top:1px solid #f0f1f3"><a href="${esc(r.url)}" style="color:#1a1a1a;font-weight:600;text-decoration:none">${esc(repoShort(r.repo))}</a></td>
    <td style="padding:10px 8px;color:#3a3a3a;line-height:1.7;border-top:1px solid #f0f1f3">${esc(line)}</td>
    <td style="padding:10px 8px 10px 4px;color:#fa5151;white-space:nowrap;text-align:right;vertical-align:top;font-size:12px;font-weight:700;border-top:1px solid #f0f1f3">+${fmtStars(r.today)}</td>
  </tr>`;
  }).join("");
  const overview = repos.length ? `
<p style="margin:0 0 12px;font-size:16px;font-weight:800;color:#1a1a1a">🔥 最新开源的顶级实用 AI 仓库</p>
<div style="border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(16,24,40,.06);border:1px solid #eceef1;margin:0 0 34px">
<table style="width:100%;border-collapse:collapse;font-size:13px">
  <tr>
    <th align="left" style="${ths};width:34px">#</th>
    <th align="left" style="${ths}">仓库</th>
    <th align="left" style="${ths};padding-left:12px">一眼看懂</th>
    <th align="right" style="${ths}">今日</th>
  </tr>
  ${rows}
</table>
</div>` : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>GitHub 日报 ${day}</title></head>
<body style="margin:0;background:#eef1f6">
<div style="max-width:677px;margin:0 auto;background:#fff;padding:0 20px 40px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">

<div style="margin:0 -20px;padding:28px 20px 24px;background:linear-gradient(135deg,#07c160 0%,#0aa8a0 60%,#0a8f9e 100%);color:#fff">
  <p style="margin:0 0 8px;font-size:12px;opacity:.85;letter-spacing:1px">GitHub DAILY DIGEST · ${CN_DATE(day)}</p>
  <h1 style="margin:0 0 10px;font-size:26px;font-weight:800;line-height:1.35">GitHub 今日热榜</h1>
  <p style="margin:0;font-size:13px;line-height:1.8;opacity:.95">今天 ${repos.length} 个项目上榜，累计新增 ${total.toLocaleString()} ★。
  ${cn ? `其中 ${cn} 个有 <b>中文体验入口</b>` : ""}。点击链接交给你的 Agent 部署即可。</p>
</div>

<p style="margin:14px 0 0;font-size:12px;color:#b2b2b2">${LLM ? "AI 深度初稿，内容基于各仓库 README 生成，发稿前请人工核对事实与链接。" : "⚠️ 未配置 OPENAI_API_KEY，本次为简版初稿。"}</p>

${overview}

${top ? `<section style="background:linear-gradient(135deg,#07c160,#0aa8a0);color:#fff;border-radius:14px;padding:20px 22px;margin:0 0 30px;box-shadow:0 6px 20px rgba(7,193,96,.25)">
  <p style="margin:0 0 8px;font-size:12px;opacity:.85;letter-spacing:1px">🔥 今日最热</p>
  <p style="margin:0 0 10px;font-size:22px;font-weight:800;line-height:1.4">${esc(repoShort(top.repo))}</p>
  <p style="margin:0 0 12px;font-size:14px;line-height:1.8;opacity:.96">${esc(String(top.ai?.what || CN(top.summary) || CN(top.desc) || metaLine(top)).slice(0, 130))}</p>
  <div style="display:inline-block;background:rgba(255,255,255,.16);border-radius:20px;padding:4px 14px;font-size:12px">今日 +${fmtStars(top.today)} ★ · 总 ${(top.stars || 0).toLocaleString()} ★</div>
</section>` : ""}

${sections}

${(data.featured && data.featured.length) ? `
<section style="margin:0 0 34px;padding:22px 20px;background:linear-gradient(135deg,#f0faf3,#e8f6ff);border-radius:14px;border:1px solid #d8f0e0">
  <h2 style="margin:0 0 8px;font-size:18px;font-weight:800;color:#1a1a1a">🔥 本周值得关注 · 还没上热榜的好东西</h2>
  <p style="margin:0 0 16px;font-size:13px;color:#5a6472;line-height:1.7">热门榜只盯短期★涨速，下面这些是权威机构最近开源、质量在线、但可能还没被捧上热榜的仓库——真正想抄作业的先看这里。</p>
  ${data.featured.map((r, i) => {
    const ai = r.ai;
    const hook = ai?.hook || `新晋开源，${(r.stars || 0).toLocaleString()} ★，值得放进收藏。`;
    return `
  <div style="margin:0 0 14px;padding:16px 18px;background:#fff;border-radius:10px;border:1px solid #e6f3eb;box-shadow:0 1px 6px rgba(16,24,40,.05)">
    <div style="margin:0 0 8px;font-size:15px;font-weight:700;color:#1a1a1a"><span style="display:inline-block;background:linear-gradient(135deg,#07c160,#0aa8a0);color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;margin-right:8px">${String(i + 1).padStart(2, "0")}</span><a href="${esc(r.url)}" style="color:#1a1a1a;text-decoration:none">${esc(r.repo)}</a></div>
    <p style="margin:0 0 8px;font-size:13px;line-height:1.8;color:#3a3a3a"><b>${md(hook)}</b></p>
    <p style="margin:0 0 10px;font-size:13px;line-height:1.8;color:#5a6472">${md(ai?.what || CN(r.summary) || CN(r.desc) || metaLine(r))}</p>
    <div style="margin:0;font-size:12px;color:#8a8a8a">${(r.stars || 0).toLocaleString()} ★ · ${esc(r.lang || "")} · <a href="${esc(r.url)}" style="color:#576b95;font-weight:600">仓库 →</a></div>
  </div>`;
  }).join("")}
</section>` : ""}

<section style="margin:6px 0 22px;padding:20px;background:linear-gradient(135deg,#07c160,#0aa8a0);border-radius:12px;color:#fff;text-align:center;box-shadow:0 6px 20px rgba(7,193,96,.22)">
  <p style="margin:0 0 6px;font-size:18px;font-weight:800">每天 9:17 · 顶级 AI 开源，说人话</p>
  <p style="margin:0;font-size:12.5px;opacity:.92">GitHub 热榜里的新东西，先帮你读懂，再决定要不要动手</p>
</section>

<section style="margin-top:12px;padding:14px 16px;background:#f7f8fa;border-radius:8px;font-size:12.5px;color:#9a9a9a;line-height:1.85">
  链接全部来自各项目 GitHub 仓库元数据与 README，已自动核对可访问性未做人工验证。中文体验入口靠浏览器渲染 demo 站抓取，可能有漏判，发稿前请点开确认。<br>
  生成时间：${new Date().toLocaleString("zh-CN")} · <a href="https://github.com/pephupephu/Github-daily-report" style="color:#576b95">订阅每日推送</a>
</section>

</div></body></html>`;
}

// ---------- Word 文稿（.docx）----------

function buildDocx(data, cidMap) {
  const { day, repos } = data;
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
    para(`GitHub 今日热榜 · ${CN_DATE(day)}`, { bold: true, size: 36, after: 80 }),
    para(`今日 ${repos.length} 个项目，累计新增 ${total.toLocaleString()} ★`, { color: "8A8A8A", size: 20, after: 240 }),
  ];

  repos.forEach((r, i) => {
    const ai = r.ai;
    children.push(para(`${String(i + 1).padStart(2, "0")} ${repoShort(r.repo)}`, { bold: true, size: 28, color: "07A050", before: 240, after: 60 }));
    children.push(para(`${r.lang || ""} · ${(r.stars || 0).toLocaleString()} ★ · 今日 +${r.today || 0}`, { color: "9A9A9A", size: 18, after: 120 }));
    children.push(para(clean(ai?.hook || FALLBACK_HOOKS[i % FALLBACK_HOOKS.length](r.today, repoShort(r.repo))), { bold: true }));
    children.push(para(clean(ai?.what || CN(r.summary) || CN(r.readmeCN?.slice(0, 500)) || CN(r.desc) || metaLine(r))));
    // 演示截图直接嵌进 Word，方便打开即看图
    children.push(...imgPara(r));
    const cs = ai?.case || r.scenarios?.[0];
    if (cs) children.push(para(`放进一个真实场景：${clean(cs)}`));
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
  });

  children.push(para("每天 9:17 · 顶级 AI 开源，说人话", { bold: true, size: 22, before: 300, after: 60 }));
  children.push(para(`生成时间：${new Date().toLocaleString("zh-CN")}`, { color: "9A9A9A", size: 18 }));

  // 「值得关注」板块也进 Word（和 HTML 对齐）
  const feat = (data.featured || []).filter((r) => r && r.repo);
  if (feat.length) {
    children.push(para("🔥 本周值得关注 · 还没上热榜的好东西", { bold: true, size: 26, color: "07A050", before: 360, after: 100 }));
    feat.forEach((r, i) => {
      const ai = r.ai;
      children.push(para(`${String(i + 1).padStart(2, "0")} ${repoShort(r.repo)}`, { bold: true, size: 26, color: "07A050", before: 220, after: 60 }));
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
const html = buildHTML(data, cidMap);
const file = join(ROOT, "out", `article-${data.day}.html`);
writeFileSync(file, html);
const docxBuf = await Packer.toBuffer(buildDocx(data, cidMap));
writeFileSync(join(ROOT, "out", `article-${data.day}.docx`), docxBuf);
console.error(`[文章] 已生成 ${file} 与 article-${data.day}.docx`);

// 微信直发版：把 cid 图片内联成 base64（浏览器复制时图片随剪贴板一起走），贴进公众号编辑器图就自动进来
const wechatHtml = html.replace(/src="cid:([^"]+)"/g, (m, cid) => {
  const v = cidMap[cid];
  if (!v?.path) return m;
  try {
    const ext = (v.path.split(".").pop() || "png").toLowerCase();
    const mime = ext === "jpg" ? "jpeg" : ext === "jpeg" || ext === "png" || ext === "gif" || ext === "webp" ? ext : "png";
    const b64 = readFileSync(v.path).toString("base64");
    return `src="data:image/${mime};base64,${b64}"`;
  } catch { return m; }
});
writeFileSync(join(ROOT, "out", `article-${data.day}.wechat.html`), wechatHtml);
console.error(`[文章] 已生成微信直发版 out/article-${data.day}.wechat.html（图片已内联 base64，浏览器全选复制直接粘进公众号）`);

const user = process.env.MAIL_USER, pass = process.env.MAIL_PASS;
if (!user || !pass) { console.error("[文章] 未配置 MAIL_USER/MAIL_PASS，跳过发信"); process.exit(0); }
const port = Number(process.env.MAIL_PORT || 465);
const transport = createTransport({ host: process.env.MAIL_HOST || "smtp.163.com", port, secure: port === 465, auth: { user, pass } });

const attachments = Object.entries(cidMap)
  .filter(([k]) => k.startsWith("shot-"))
  .map(([k, v]) => ({ filename: `${k}.${(v.path.split(".").pop() || "png").toLowerCase()}`, path: v.path, cid: k }));
attachments.push({ filename: `GitHub日报-${data.day}.docx`, content: docxBuf });
// 微信直发版也作为附件：收邮件即拿到内联图片的 html，直接 Chrome 打开复制进公众号即可
const wechatFile = join(ROOT, "out", `article-${data.day}.wechat.html`);
attachments.push({ filename: `公众号直发-${data.day}.wechat.html`, content: readFileSync(wechatFile) });

try {
  await transport.sendMail({
    from: `"GitHub 日报" <${user}>`,
    to: process.env.MAIL_TO || user,
    subject: `【公众号初稿】GitHub 热榜 ${data.day} · ${data.repos.length} 个项目 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`,
    html,
    attachments,
  });
  console.error(`[文章] 已发送 ${data.repos.length} 个项目到邮箱，附件截图 ${attachments.length} 张`);
} catch (e) {
  // 发送失败也别让整个 job 变红：文章已在仓库里，重跑一次即可
  console.error(`[邮件] 发送失败：${e.message}（文章已生成并归档，重跑 workflow 即可补发）`);
}