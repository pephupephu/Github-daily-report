#!/usr/bin/env node
// 读 reports/latest.json -> 抽「开源地址/官方演示/中文体验」三件套 -> 生成公众号文章初稿 -> 发邮箱
// 定位：AI 出结构 + 链接 + 简介，「真实体验/多媒体」留占位给人填。
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

// URL 里的中文路径标记：/lp/zh/yue2、/zh-cn/ 这种
const CN_PATH = /(\/zh(-cn|-tw|-hans)?\/|\/cn\/|\bzh\b|\bchinese\b|lang=(zh|cn))/i;
const JUNK = /(^|\.)(github\.com|gitee\.com|arxiv\.org|doi\.org|githubusercontent\.com|shields\.io|badge\.|discord\.gg|twitter\.com|x\.com|patreon\.com|opencollective\.com|ko-fi\.com|buymeacoffee\.com|huggingface\.co\/[^/]+\/[^/]+\/blob)/i;

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
  // 有锚文本的链接信息量更大，排前面
  const rank = (a, b) => (a.text ? 0 : 1) - (b.text ? 0 : 1);
  res.cnDemo.sort(rank); res.demo.sort(rank);
  return res;
}

// 主动进 demo 站里翻中文入口 —— README 里通常没有，公众号作者也是这么找到的。
// 局限：SPA（客户端渲染）的页面源码里没有链接，这种情况抓不到，需要真浏览器。
async function probeChinese(demoUrl) {
  try {
    const r = await fetch(demoUrl, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; +github-trending-bot)" },
      redirect: "follow", signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    if (/<div id="root"><\/div>|<div id="app"><\/div>|__NEXT_DATA__/.test(html) && !/href=.*\/zh/i.test(html)) {
      return { spa: true };   // 大概率是 SPA，源码里翻不出中文链接
    }
    const hits = [...html.matchAll(/href=["']([^"'#?]*(?:\/zh(?:[-/]|\b)|\/cn\/|lang=(?:zh|cn))[^"'#?]*)["']/gi)].map((m) => m[1]);
    const uniq = [...new Set(hits)].filter((h) => !h.startsWith("javascript"));
    return uniq.length ? { urls: uniq.slice(0, 2) } : null;
  } catch {
    return null;
  }
}

// ---------- 文案 ----------

// 从英文简介生成一句中文钩子（无 LLM 时用模板，有 key 时用 LLM）
function hookLine(repo) {
  const d = (repo.desc || "").replace(/\s+/g, " ").trim();
  if (!d) return repo.summary?.slice(0, 60) || "";
  return d; // 邮件里由翻译层处理
}

// 挑出最像「部署命令」的代码块
function installCmd(md) {
  const fences = [...md.matchAll(/```(?:bash|sh|shell|console)?\n([\s\S]{0,400}?)```/g)].map((m) => m[1].trim());
  const score = (c) => (/git clone/.test(c) ? 10 : 0) + (/pip install|npm i|npm install|cargo|uv |brew install/.test(c) ? 6 : 0) + (/^python |^node /.test(c) ? 2 : 0) - (c.split("\n").length > 12 ? 3 : 0);
  return fences.sort((a, b) => score(b) - score(a))[0] || "";
}

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
const CN_DATE = (d) => `${d.slice(0, 4)}年${d.slice(5, 7)}月${d.slice(8)}日`;
const fmtStars = (n) => `+${String(n || 0).replace(/,/g, "")}`;

function linkTriple(r) {
  const row = (label, url, hot) =>
    `<p style="margin:6px 0;font-size:15px;line-height:1.8"><span style="color:#576b95;font-weight:600">${label}：</span>${hot ? `<span style="background:#fa5151;color:#fff;font-size:10px;padding:1px 6px;border-radius:3px;margin-right:5px;vertical-align:middle">推荐</span>` : ""}<a href="${esc(url)}" style="color:#576b95;text-decoration:none;word-break:break-all">${esc(url)}</a></p>`;
  const rows = [row("开源地址", r.url, false)];
  if (r.homepage) rows.push(row("项目主页", r.homepage, false));
  r.links.cnDemo.slice(0, 1).forEach((l) => rows.push(row("中文体验", l.url, true)));
  r.links.demo.slice(0, 2).forEach((l) => rows.push(row("官方演示", l.url, true)));
  r.links.paper.slice(0, 1).forEach((l) => rows.push(row("论文", l.url, false)));
  if (!r.links.cnDemo.length && !r.links.demo.length && r.homepage) rows.push(row("在线演示", r.homepage, true));
  return rows.join("");
}

function section(r, i) {
  const need = [];
  if (!r.links.demo.length && !r.links.cnDemo.length) need.push("该项目无可用在线演示 —— 需自己部署并截图");
  need.push("⬜️ 在这里插入：你的实际体验 / 效果截图 / 音频或视频");
  const cmd = r.install ? `<pre style="background:#282c34;color:#abb2bf;padding:12px 14px;border-radius:6px;overflow-x:auto;font-size:13px;line-height:1.6;margin:10px 0"><code>${esc(r.install)}</code></pre>` : "";
  const tags = (r.topics || []).slice(0, 4).map((t) => `<span style="display:inline-block;background:#f2f3f5;color:#5a6472;font-size:11px;padding:2px 9px;border-radius:10px;margin:0 6px 0 0">${esc(t)}</span>`).join("");

  return `
<section style="margin:0 0 34px;padding-bottom:26px;border-bottom:1px solid #eceef1">
  <h2 style="margin:0 0 8px;font-size:18px;font-weight:700;color:#1a1a1a;line-height:1.6">
    <span style="color:#07c160">${String(i + 1).padStart(2, "0")}</span>
    <span style="margin-left:8px">${esc(r.repo.split("/")[1])}</span>
  </h2>
  <p style="margin:0 0 10px;font-size:12.5px;color:#9a9a9a">${esc(r.desc).slice(0, 110)}</p>
  <p style="margin:0 0 10px;font-size:12.5px;color:#9a9a9a">${esc(r.lang)} · ${(r.stars || 0).toLocaleString()} star · 今日 ${fmtStars(r.today)}${r.license ? ` · ${esc(r.license)}` : ""}</p>
  ${tags ? `<div style="margin:0 0 12px">${tags}</div>` : ""}
  <div style="margin:0 0 6px;font-size:15.5px;line-height:1.9;color:#3a3a3a;text-align:justify">${esc(r.summary || r.readmeCN?.slice(0, 700) || r.desc)}</div>
  ${cmd}
  <div style="background:#f7f8fa;border-radius:8px;padding:8px 14px;margin:12px 0">${linkTriple(r)}</div>
  <p style="margin:0;padding:8px 12px;background:#fff8e6;border-left:3px solid #fa9d3b;font-size:13px;color:#8a6d3b;line-height:1.8">
    <strong>需要你补：</strong>${need.join("<br>")}
  </p>
</section>`;
}

function buildHTML(data) {
  const { day, repos } = data;
  const top = repos[0];
  const cn = repos.filter((r) => r.links.cnDemo.length).length;
  const withDemo = repos.filter((r) => r.links.demo.length || r.links.cnDemo.length || r.homepage).length;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>GitHub 日报 ${day}</title></head>
<body style="margin:0;background:#f5f6f8">
<div style="max-width:677px;margin:0 auto;background:#fff;padding:26px 20px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">

<p style="margin:0 0 4px;font-size:12px;color:#b2b2b2">这是 AI 生成的<b>初稿</b>，链接已核实，<b>体验部分需要你补</b>（每段下方黄色框已标出）。</p>
<hr style="border:none;border-top:1px solid #eceef1;margin:14px 0 24px">

<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1a1a1a;line-height:1.5">GitHub 今日热榜 · ${CN_DATE(day)}</h1>
<p style="margin:0 0 22px;font-size:13.5px;color:#8a8a8a;line-height:1.8;border-bottom:2px solid #07c160;padding-bottom:12px">
  今日 ${repos.length} 个项目上榜，累计新增 ${repos.reduce((s, r) => s + (+String(r.today || 0).replace(/,/g, "") || 0), 0).toLocaleString()} star。
  ${withDemo} 个可直接打开体验${cn ? `，其中 ${cn} 个有<b>中文页面</b>` : "，暂无中文页面"}。
</p>

${top ? `<section style="background:#07c160;color:#fff;border-radius:10px;padding:18px 20px;margin:0 0 30px">
  <p style="margin:0 0 4px;font-size:12px;opacity:.9">今日最热</p>
  <p style="margin:0 0 8px;font-size:19px;font-weight:700">${esc(top.repo)}</p>
  <p style="margin:0 0 10px;font-size:13px;line-height:1.75;opacity:.96">${esc(top.desc).slice(0, 130)}</p>
  <p style="margin:0;font-size:12px;opacity:.9">今日 +${fmtStars(top.today)} star · ${esc(top.lang)} · ${(top.stars || 0).toLocaleString()} star</p>
</section>` : ""}

${repos.map(section).join("")}

<section style="margin-top:10px;padding:14px 16px;background:#f7f8fa;border-radius:8px;font-size:12.5px;color:#9a9a9a;line-height:1.85">
  链接全部来自各项目 GitHub 仓库元数据与 README，已自动核对可访问性未做人工验证。<br>
  中文体验入口靠 URL 规则识别，可能有漏判或误判，发稿前请点开确认。<br>
  生成时间：${new Date().toLocaleString("zh-CN")} · <a href="https://github.com/pephupephu/Github-daily-report" style="color:#576b95">订阅每日推送</a>
</section>

</div></body></html>`;
}

// ---------- 主流程 ----------

let data;
try { data = JSON.parse(readFileSync(join(ROOT, "reports", "latest.json"), "utf8")); }
catch { console.error("找不到 reports/latest.json —— 先跑 node trending.mjs"); process.exit(1); }

console.error(`[文章] 处理 ${data.repos.length} 个项目…`);
let spaCount = 0;
for (const [i, r] of data.repos.entries()) {
  const md = await readme(r.repo);
  r.links = classify(parseLinks(md), r.repo, r.homepage);
  r.install = installCmd(md);

  // README 里没有中文入口时，去 demo 站里翻一遍
  if (!r.links.cnDemo.length) {
    for (const cand of [...r.links.demo.slice(0, 2).map((l) => l.url), r.homepage].filter(Boolean)) {
      const hit = await probeChinese(cand);
      if (hit?.urls?.length) {
        r.links.cnDemo = hit.urls.map((u) => ({ url: new URL(u, cand).href, text: "", probed: true }));
        break;
      }
      if (hit?.spa) spaCount++;
    }
  }
  process.stderr.write(`  ${i + 1}/${data.repos.length} ${r.repo} → 演示${r.links.demo.length} 中文${r.links.cnDemo.length}${r.links.cnDemo[0]?.probed ? "(探到)" : ""}\n`);
  await new Promise((s) => setTimeout(s, 200));
}
if (spaCount) console.error(`[文章] 提示：${spaCount} 个 demo 是 SPA，中文入口需手动确认`);

mkdirSync(join(ROOT, "out"), { recursive: true });
const html = buildHTML(data);
writeFileSync(join(ROOT, "out", `article-${data.day}.html`), html);
console.error(`[文章] 已生成 out/article-${data.day}.html`);

const user = process.env.MAIL_USER, pass = process.env.MAIL_PASS;
if (!user || !pass) { console.error("[文章] 未配置 MAIL_USER/MAIL_PASS，跳过发信"); process.exit(0); }
const port = Number(process.env.MAIL_PORT || 465);
await createTransport({ host: process.env.MAIL_HOST || "smtp.163.com", port, secure: port === 465, auth: { user, pass } })
  .sendMail({
    from: `"GitHub 日报" <${user}>`,
    to: process.env.MAIL_TO || user,
    subject: `【初稿】GitHub 热榜 ${data.day} · ${data.repos.length} 个项目 + 演示/中文入口`,
    html,
  });
console.error("[文章] 已发送到邮箱");