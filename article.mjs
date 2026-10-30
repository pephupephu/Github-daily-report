#!/usr/bin/env node
// 读 reports/latest.json -> 浏览器渲染抓中文入口+截图
// -> 生成「公众号风格」文章初稿 -> 截图附件内嵌发邮箱
// 定位：AI 出文章骨架 + 链接 + 部署命令，“真实体验/多媒体”留占位给人填
// 用法: node article.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTransport } from "nodemailer";

const ROOT = dirname(fileURLToPath(import.meta.url));
const UA = { "user-agent": "gh-daily-article" };

// ---------- 大模型逐个深度分析（OpenAI 兼容协议；默认智谱 glm-4-flash 免费档）----------

const LLM = process.env.OPENAI_API_KEY
  ? {
      key: process.env.OPENAI_API_KEY,
      base: (process.env.OPENAI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, ""),
      model: process.env.OPENAI_MODEL || "glm-4.7-flash",
    }
  : null;

const AI_PROMPT = `你是资深公众号科技编辑，为一个 GitHub 热门项目写中文深度解读。要求像真人作者写的：口语化、句子完整通顺、有具体细节、不说空话、不堆术语（出现专业词就用半句话解释它对读者的意义）。

仓库名：{repo}（{lang}，总星 {stars}，今日涨 {today}）
官方简介：{desc}
README 摘录：
{readme}

本期已用过的开头角度：{used}
hook（开头）是全文胜负手：读者看完这一句才决定要不要往下读。从该仓库自身找一个具体抓手——一个扎眼的数字、一个真实痛点、一个反常识的设计决策、或一句“终于有人把它做出来了”的感叹——像人随口跟朋友说话那样写出来，有画面、有悬念，但不是标题党。禁止以“分享一个”“爆火”“上榜”“今天看到”这类套话开头，禁止喊口号和排比。

只输出 JSON（不要代码块、不要任何解释）：
{"hook":"开头一句，30字内。直接给一个具体成果或场景：谁用它能做到什么，带关键数字或名词，让人一眼看到画面；禁止出现：爆火/火得有理由/涨得最凶/杀疯了/上榜/分享一个/今天看到/值得一看","oneliner":"18字内直戳它最牛的那一点：杀手锏能力/最抓眼的数字/别人做不到而它做到了，例如：本地跑通 70B 大模型；10 行代码生成整个后台；禁止'平台/框架/生态/无缝/赋能'，禁止写成'这是一个…工具'","what":"3到4句大白话：它是做什么的、解决谁的问题，要带一个具体的输入→输出例子（例如：丢一张图纸，几分钟后拿回可编辑的 3D 模型），没接触过的人能秒懂","case":"2到3句一个贴合实际的运用案例：谁（具体身份）、被什么卡住、拆成具体动作怎么解决（第一步…第二步…）、前后省了什么。基于 README 能力，不编造","core":"3到4句讲清它是怎么做到的：点名关键组件、步骤和数据流，说清为什么有效。基于 README 事实，不编造","who":"适合谁用，具体到身份，如：天天让 AI 写页面但总不满意的前端开发"}

在 what / case / core 的内容里，把关键名词、数字、量化收益用 **双星号** 包起来标黑（如 **7 美元**、**3295 个可编辑对象**、**一块 ESP32-S3 开发板**），每段 1 到 3 处，不要整句加粗。`;

async function callAI(prompt) {
  const res = await fetch(`${LLM.base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LLM.key}` },
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
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 150)}`);
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
  if (!out.hook || !out.what) throw new Error(`关键字段为空：hook=${!!out.hook} what=${!!out.what}`);
  return out;
}

// 智谱免费档限流特征：HTTP 429 / code 1302(账户频率) / 1305(模型过载)，退避重试有效
const RATE_LIMITED = /HTTP 429|1302|1305|速率|访问量过大/;

async function analyzeOne(r, md, usedHooks = []) {
  if (!LLM) return null;
  const prompt = AI_PROMPT
    .replace("{used}", usedHooks.length ? usedHooks.map((h, i) => `${i + 1}. ${h}`).join("；") : "（无，可自由发挥，但仍禁止“分享一个/爆火/上榜”式套话）")
    .replace("{repo}", r.repo).replace("{lang}", r.lang || "-").replace("{stars}", String(r.stars ?? "")).replace("{today}", r.today ?? "")
    .replace("{desc}", r.desc || "").replace("{readme}", md.slice(0, 4000));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callAI(prompt);
    } catch (e) {
      if (attempt < 2 && RATE_LIMITED.test(e.message)) {
        process.stderr.write(`[大模型] ${r.repo} 被限流，${attempt ? 60 : 25}s 后重试\n`);
        await new Promise((s) => setTimeout(s, attempt ? 60000 : 25000));
        continue;
      }
      process.stderr.write(`[大模型] ${r.repo} 分析失败：${e.message}\n`);
      return null;
    }
  }
}

// AI 缺席时的轮换兜底开场，只陈述榜单事实，不喊口号
const FALLBACK_HOOKS = [
  (n, name) => `${name} 今天单日 **+${n} star**。`,
  (n, name) => `**+${n} star** 一天，${name} 在解决一个具体问题。`,
  (n, name) => `${name} 今天的榜单成绩：**+${n} star**。`,
  (n, name) => `单日 **+${n} star** 的 ${name}，看看它对你有没有用。`,
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

function extractVideos(md, repoUrl) {
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
    let url;
    try { url = new URL(m[1], repoUrl).href; } catch { continue; }
    if (!seen.has(`file:${url}`)) {
      seen.add(`file:${url}`);
      videos.push({ type: 'file', id: url, url, thumb: url.endsWith('.gif') ? url : undefined });
    }
  }

  // Markdown 图片形式的 gif/视频 ![](xxx.mp4)
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)]*\.(?:mp4|webm|mov|avi|gif)(?:[?#][^)]*)?)\)/gi)) {
    let url;
    try { url = new URL(m[1], repoUrl).href; } catch { continue; }
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
    return `
    <div style="margin:10px 0;padding:12px;background:#fff;border:1px solid #e1e4e8;border-radius:8px">
      <a href="${esc(v.url)}" style="text-decoration:none;display:block">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:48px;height:36px;background:#282c34;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700">▶</div>
          <div style="font-size:13px;color:#1a1a1a">${esc(v.thumb ? '演示动图' : '演示视频')} · ${esc(new URL(v.url).pathname.split('/').pop() || v.url)}</div>
        </div>
      </a>
    </div>`;
  }).join('');
  return `<div style="margin:12px 0">${cards}</div>`;
}

// ---------- 浏览器层面：抓 SPA 中文入口 + 截图 ----------

let browser;
async function withBrowser(fn) {
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"] });
  try { return await fn(); } finally { await browser.close(); }
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

function installCmd(md) {
  const fences = [...md.matchAll(/```(?:bash|sh|shell|console)?\n([\s\S]{0,400}?)```/g)].map((m) => m[1].trim());
  const score = (c) => (/git clone/.test(c) ? 10 : 0) + (/pip install|npm i|npm install|cargo|uv |brew install/.test(c) ? 6 : 0) + (/^python |^node /.test(c) ? 2 : 0) - (c.split("\n").length > 12 ? 3 : 0);
  return fences.sort((a, b) => score(b) - score(a))[0] || "";
}

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
// 先转义再还原 **粗体**：LLM 用双星号标关键名词/数字，这里变成 <b>
const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
// 中文哨兵：兜底数据里宁可不显示，也不放英文让读者出戏
const CN = (s) => (/[\u4e00-\u9fa5]/.test(s) ? s : "");
const CN_DATE = (d) => `${d.slice(0, 4)}年${d.slice(5, 7)}月${d.slice(8)}日`;
const fmtStars = (n) => `+${String(n || 0).replace(/,/g, "")}`;
const repoShort = (repo) => repo.split("/")[1];

// 公众号风格：每个项目一节，AI 钩子开头，带核心机制/使用场景/适合谁；AI 缺席时退回简版
function section(r, i, shotCid) {
  const ai = r.ai;
  const cmd = r.install ? `<pre style="background:#282c34;color:#abb2bf;padding:12px 14px;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.6;margin:10px 0"><code>${esc(r.install)}</code></pre>` : "";
  const img = shotCid ? `<img src="cid:${shotCid}" style="max-width:100%;border-radius:6px;margin:0 0 14px;display:block" alt="${esc(repoShort(r.repo))} 演示截图" />` : "";
  const vids = r.videos?.length ? videoBlock(r.videos) : "";
  const p = `style="margin:0 0 10px;font-size:15px;line-height:1.9;color:#3a3a3a"`;

  const links = [];
  if (r.homepage) links.push(`<a href="${esc(r.homepage)}" style="color:#576b95;text-decoration:none">${esc(new URL(r.homepage).hostname)}</a>`);
  r.links.cnDemo.slice(0, 1).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#fa5151;font-weight:700;text-decoration:none">中文体验 → ${esc(l.url)}</a>`));
  r.links.demo.slice(0, 2).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#576b95;text-decoration:none">官方演示 → ${esc(l.url)}</a>`));
  r.links.paper.slice(0, 1).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#8a6d3b;text-decoration:none">论文 → ${esc(l.url)}</a>`));

  const hook = ai?.hook || FALLBACK_HOOKS[i % FALLBACK_HOOKS.length](r.today, repoShort(r.repo));
  const cleanSum = /分析失败|HTTP 4\d\d/.test(r.summary || "") ? "" : (r.summary || "");
  const what = ai?.what || (cleanSum || CN(r.readmeCN?.slice(0, 500)) || CN(r.desc) || "");
  const caseHtml = ai?.case ? `<p ${p}><b style="color:#1a1a1a">放进一个真实场景：</b>${md(ai.case)}</p>` : "";
  const coreHtml = ai?.core ? `<p ${p}><b style="color:#1a1a1a">它是怎么做到的：</b>${md(ai.core)}</p>` : "";
  const whoHtml = ai?.who ? `<p ${p}"><b style="color:#1a1a1a">适合谁：</b>${md(ai.who)}</p>` : "";
  const fallbackBox = !ai && (CN(r.summary) || CN(r.desc)) ? `<div style="margin:0;padding:10px 14px;background:#f7f8fa;border-radius:6px;font-size:13px;color:#5a6472;line-height:1.8"><strong>一句话概括：</strong>${esc(CN(r.summary) || CN(r.desc))}</div>` : "";
  // 收尾上手区：仓库地址 + 一句可直接复制给任意 AI Agent 的安装提示词
  const agentBox = `
<div style="margin:16px 0 0;padding:12px 16px;background:#f7fdf9;border-left:4px solid #07c160;border-radius:6px;font-size:14px;line-height:2;color:#3a3a3a">
  <b style="color:#1a1a1a">仓库地址：</b><a href="https://github.com/${esc(r.repo)}" style="color:#576b95;text-decoration:none">github.com/${esc(r.repo)}</a><br>
  <b style="color:#1a1a1a">交给 Agent 安装：</b>把这句话发给任意 AI Agent（Claude Code / Codex / Cursor / Qwen Code 都行）——
  <span style="display:block;margin-top:4px;padding:8px 12px;background:#fff;border:1px dashed #c8d8cf;border-radius:6px;font-size:13px;line-height:1.8">帮我克隆 https://github.com/${esc(r.repo)}，按它 README 的说明装好依赖并运行起来，最后告诉我怎么用</span>
</div>`;

  return `
<section style="margin:0 0 34px;padding-bottom:26px;border-bottom:1px solid #eceef1">
  <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#1a1a1a;line-height:1.5">
    <span style="color:#07c160">${String(i + 1).padStart(2, "0")}</span>
    <span style="margin-left:8px">${esc(repoShort(r.repo))}</span>
    <small style="color:#9a9a9a;font-weight:400">${esc(r.lang)} · ${(r.stars || 0).toLocaleString()} star · 今日 ${fmtStars(r.today)}</small>
  </h2>
  <p ${p}"><b style="color:#1a1a1a">${md(hook)}</b></p>
  <p ${p}">${md(what)}</p>
  ${caseHtml}
  ${coreHtml}
  ${cmd}
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
  const ths = `padding:8px;background:#f7f8fa;border-bottom:1px solid #eceef1;color:#8a8a8a;font-size:12px;font-weight:600`;
  const rows = repos.map((r, i) => {
    const line = String(r.ai?.oneliner || CN(r.summary) || CN(r.desc) || "详情见下").replace(/\*\*/g, "").replace(/\s+/g, " ").slice(0, 46);
    return `<tr>
    <td style="padding:9px 4px 9px 8px;border-bottom:1px solid #eceef1;color:#07c160;font-weight:700;vertical-align:top">${String(i + 1).padStart(2, "0")}</td>
    <td style="padding:9px 8px;border-bottom:1px solid #eceef1;white-space:nowrap;vertical-align:top"><a href="${esc(r.url)}" style="color:#1a1a1a;font-weight:600;text-decoration:none">${esc(repoShort(r.repo))}</a></td>
    <td style="padding:9px 8px;border-bottom:1px solid #eceef1;color:#3a3a3a;line-height:1.75">${esc(line)}</td>
    <td style="padding:9px 8px 9px 4px;border-bottom:1px solid #eceef1;color:#fa5151;white-space:nowrap;text-align:right;vertical-align:top;font-size:12px">+${fmtStars(r.today)}</td>
  </tr>`;
  }).join("");
  const overview = repos.length ? `
<p style="margin:0 0 10px;font-size:16px;font-weight:800;color:#1a1a1a">🔥 最新开源的顶级实用 AI 仓库</p>
<table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 30px">
  <tr>
    <th align="left" style="${ths};width:34px">#</th>
    <th align="left" style="${ths}">仓库</th>
    <th align="left" style="${ths};padding-left:12px">一眼看懂</th>
    <th align="right" style="${ths}">今日</th>
  </tr>
  ${rows}
</table>` : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>GitHub 日报 ${day}</title></head>
<body style="margin:0;background:#f5f6f8">
<div style="max-width:677px;margin:0 auto;background:#fff;padding:26px 20px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">

<p style="margin:0 0 6px;font-size:12px;color:#b2b2b2">${LLM ? "AI 深度初稿，内容基于各仓库 README 生成，发稿前请人工核对事实与链接。" : "⚠️ 未配置 OPENAI_API_KEY，本次为简版初稿。"}</p>
<hr style="border:none;border-top:1px solid #eceef1;margin:14px 0 22px">

<h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#1a1a1a;line-height:1.4">GitHub 今日热榜 · ${CN_DATE(day)}</h1>
<p style="margin:0 0 24px;font-size:14px;color:#8a8a8a;line-height:1.8;border-bottom:2px solid #07c160;padding-bottom:12px">
  今天在 GitHub 上又看到了不少有意思的开源项目。今天 ${repos.length} 个项目上榜，累计新增 ${total.toLocaleString()} star。
  ${cn ? `其中 ${cn} 个有 <b>中文体验入口</b>` : ""}，点击链接交给你的 Agent 部署即可。
</p>

${overview}

${top ? `<section style="background:#07c160;color:#fff;border-radius:10px;padding:18px 20px;margin:0 0 28px">
  <p style="margin:0 0 6px;font-size:12px;opacity:.9">今日最热</p>
  <p style="margin:0 0 8px;font-size:20px;font-weight:700">${esc(repoShort(top.repo))}</p>
  <p style="margin:0 0 10px;font-size:13px;line-height:1.75;opacity:.96">${esc(String(top.ai?.what || CN(top.summary) || CN(top.desc) || "详情见下文各仓库一节").slice(0, 130))}</p>
  <p style="margin:0;font-size:12px;opacity:.9">今日 +${fmtStars(top.today)} star · 总 ${(top.stars || 0).toLocaleString()} star</p>
</section>` : ""}

${sections}

<section style="margin-top:10px;padding:14px 16px;background:#f7f8fa;border-radius:8px;font-size:12.5px;color:#9a9a9a;line-height:1.85">
  链接全部来自各项目 GitHub 仓库元数据与 README，已自动核对可访问性未做人工验证。中文体验入口靠浏览器渲染 demo 站抓取，可能有漏判，发稿前请点开确认。<br>
  生成时间：${new Date().toLocaleString("zh-CN")} · <a href="https://github.com/pephupephu/Github-daily-report" style="color:#576b95">订阅每日推送</a>
</section>

</div></body></html>`;
}

// ---------- 主流程 ----------

let data;
try { data = JSON.parse(readFileSync(join(ROOT, "reports", "latest.json"), "utf8")); }
catch { console.error("找不到 reports/latest.json —— 先跑 node trending.mjs"); process.exit(1); }

console.error(`[文章] 处理 ${data.repos.length} 个项目…`);
if (!LLM) console.error("[警告] 未配置 OPENAI_API_KEY —— 本次为简版文章。去 GitHub 仓库 Settings > Secrets > Actions 添加 OPENAI_API_KEY");
let cidMap = {};
let usedHooks = [];
await withBrowser(async () => {
  const page = await browser.newPage();
  page.setViewportSize({ width: 1280, height: 800 });
  for (const [i, r] of data.repos.entries()) {
  const md = await readme(r.repo);
  r.links = classify(parseLinks(md), r.repo, r.homepage);
  r.install = installCmd(md);
  r.videos = extractVideos(md, r.url);
  r.ai = await analyzeOne(r, md, usedHooks);
  if (r.ai?.hook) usedHooks.push(r.ai.hook);
    if (!r.links.cnDemo.length) {
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
    } else {
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
    await new Promise((s) => setTimeout(s, 1500));
  }
  await page.close();
});

mkdirSync(join(ROOT, "out"), { recursive: true });
const html = buildHTML(data, cidMap);
const file = join(ROOT, "out", `article-${data.day}.html`);
writeFileSync(file, html);
console.error(`[文章] 已生成 ${file}`);

const user = process.env.MAIL_USER, pass = process.env.MAIL_PASS;
if (!user || !pass) { console.error("[文章] 未配置 MAIL_USER/MAIL_PASS，跳过发信"); process.exit(0); }
const port = Number(process.env.MAIL_PORT || 465);
const transport = createTransport({ host: process.env.MAIL_HOST || "smtp.163.com", port, secure: port === 465, auth: { user, pass } });

const attachments = Object.entries(cidMap)
  .filter(([k]) => k.startsWith("shot-"))
  .map(([k, v]) => ({ filename: `${k}.png`, path: v.path, cid: k }));

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