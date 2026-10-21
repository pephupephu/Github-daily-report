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
    await page.screenshot({ path: shotPath, fullPage: true });
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
const CN_DATE = (d) => `${d.slice(0, 4)}年${d.slice(5, 7)}月${d.slice(8)}日`;
const fmtStars = (n) => `+${String(n || 0).replace(/,/g, "")}`;
const repoShort = (repo) => repo.split("/")[1];

// 公众号风格：每个项目一节，先写“人的话”，再给链接，最后留占位
function section(r, i, shotCid) {
  const tags = (r.topics || []).slice(0, 4).map((t) => `<span style="display:inline-block;background:#f2f3f5;color:#5a6472;font-size:11px;padding:2px 9px;border-radius:10px;margin:0 6px 0 0">${esc(t)}</span>`).join("");
  const body = esc(r.summary || r.readmeCN?.slice(0, 700) || r.desc);
  const cmd = r.install ? `<pre style="background:#282c34;color:#abb2bf;padding:12px 14px;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.6;margin:10px 0"><code>${esc(r.install)}</code></pre>` : "";
  const img = shotCid ? `<img src="cid:${shotCid}" style="max-width:100%;border-radius:6px;margin:0 0 14px;display:block" alt="${esc(repoShort(r.repo))} 演示截图" />` : "";
  const vids = r.videos?.length ? videoBlock(r.videos) : "";

  const links = [];
  if (r.homepage) links.push(`<a href="${esc(r.homepage)}" style="color:#576b95;text-decoration:none">${esc(new URL(r.homepage).hostname)}</a>`);
  r.links.cnDemo.slice(0, 1).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#fa5151;font-weight:700;text-decoration:none">中文体验 → ${esc(l.url)}</a>`));
  r.links.demo.slice(0, 2).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#576b95;text-decoration:none">官方演示 → ${esc(l.url)}</a>`));
  r.links.paper.slice(0, 1).forEach((l) => links.push(`<a href="${esc(l.url)}" style="color:#8a6d3b;text-decoration:none">论文 → ${esc(l.url)}</a>`));

  const hook = (r.summary || r.desc).split("。")[0].slice(0, 40);
  const lead = hook ? `今天看到 ${esc(repoShort(r.repo))} 上榜了，${hook.replace(/^(这个|该|它)/, "")}。` : `今天看到 ${esc(repoShort(r.repo))} 上榜了。`;

  return `
<section style="margin:0 0 34px;padding-bottom:26px;border-bottom:1px solid #eceef1">
  <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#1a1a1a;line-height:1.5">
    <span style="color:#07c160">${String(i + 1).padStart(2, "0")}</span>
    <span style="margin-left:8px">${esc(repoShort(r.repo))}</span>
    <small style="color:#9a9a9a;font-weight:400">${esc(r.lang)} · ${(r.stars || 0).toLocaleString()} star · 今日 ${fmtStars(r.today)}</small>
  </h2>
  <p style="margin:0 0 10px;font-size:15px;line-height:1.9;color:#3a3a3a">${lead}${esc((r.summary || r.desc).slice(hook.length))}</p>
  ${cmd}
  ${img}
  ${vids}
  ${links.length ? `<div style="margin:10px 0">${links.join("　　")}</div>` : ""}
  <div style="margin:0;padding:10px 14px;background:#f7f8fa;border-radius:6px;font-size:13px;color:#5a6472;line-height:1.8">
    <strong>一句话概括：</strong>${esc(r.desc || r.summary || "")}<br>
    <strong>适合谁：</strong>对 ${esc((r.topics || []).slice(0, 3).join("、") || "这个领域")} 感兴趣的开发者。
  </div>
</section>`;
}

function buildHTML(data, cidMap) {
  const { day, repos } = data;
  const top = repos[0];
  const cn = repos.filter((r) => r.links.cnDemo.length).length;
  const total = repos.reduce((s, r) => s + (+String(r.today || 0).replace(/,/g, "") || 0), 0);
  const sections = repos.map((r, i) => section(r, i, cidMap[r.repo] || "")).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>GitHub 日报 ${day}</title></head>
<body style="margin:0;background:#f5f6f8">
<div style="max-width:677px;margin:0 auto;background:#fff;padding:26px 20px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">

<p style="margin:0 0 6px;font-size:12px;color:#b2b2b2">这是 AI 生成的文章初稿，链接已核实，<b>体验部分需要你亲自补</b>（每段下方灰框已标出）。</p>
<hr style="border:none;border-top:1px solid #eceef1;margin:14px 0 22px">

<h1 style="margin:0 0 6px;font-size:24px;font-weight:800;color:#1a1a1a;line-height:1.4">GitHub 今日热榜 · ${CN_DATE(day)}</h1>
<p style="margin:0 0 24px;font-size:14px;color:#8a8a8a;line-height:1.8;border-bottom:2px solid #07c160;padding-bottom:12px">
  今天在 GitHub 上又看到了不少有意思的开源项目。今天 ${repos.length} 个项目上榜，累计新增 ${total.toLocaleString()} star。
  ${cn ? `其中 ${cn} 个有 <b>中文体验入口</b>` : ""}，直接点下面的链接就能打开，不用自己折腾部署。
</p>

${top ? `<section style="background:#07c160;color:#fff;border-radius:10px;padding:18px 20px;margin:0 0 28px">
  <p style="margin:0 0 6px;font-size:12px;opacity:.9">今日最热</p>
  <p style="margin:0 0 8px;font-size:20px;font-weight:700">${esc(repoShort(top.repo))}</p>
  <p style="margin:0 0 10px;font-size:13px;line-height:1.75;opacity:.96">${esc(top.desc).slice(0, 130)}</p>
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
let cidMap = {};
await withBrowser(async () => {
  const page = await browser.newPage();
  page.setViewportSize({ width: 1280, height: 800 });
  for (const [i, r] of data.repos.entries()) {
  const md = await readme(r.repo);
  r.links = classify(parseLinks(md), r.repo, r.homepage);
  r.install = installCmd(md);
  r.videos = extractVideos(md, r.url);
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
      const shotDir = join(ROOT, "shots");
      mkdirSync(shotDir, { recursive: true });
      const shotPath = join(shotDir, `${r.repo.replace("/", "__")}.png`);
      await page.screenshot({ path: shotPath, fullPage: false, clip: { x: 0, y: 0, width: 1200, height: 675 } });
      const cid = `shot-${i}`;
      r.shotCid = cid;
      cidMap[r.repo] = cid;
      cidMap[cid] = { path: shotPath };
    }
    process.stderr.write(`  ${i + 1}/${data.repos.length} ${r.repo} → 演示${r.links.demo.length} 中文${r.links.cnDemo.length}\n`);
    await new Promise((s) => setTimeout(s, 300));
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

await transport.sendMail({
  from: `"GitHub 日报" <${user}>`,
  to: process.env.MAIL_TO || user,
  subject: `【公众号初稿】GitHub 热榜 ${data.day} · ${data.repos.length} 个项目`,
  html,
  attachments,
});
console.error(`[文章] 已发送 ${data.repos.length} 个项目到邮箱，附件截图 ${attachments.length} 张`);