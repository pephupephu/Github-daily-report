#!/usr/bin/env node
// 抓 GitHub 日/周/月榜 -> 生成中文 Markdown -> 写 reports/YYYY-MM-DD.md 并追加到 README 索引
// 用法: node trending.mjs [daily|weekly|monthly]
// 可选: GITHUB_TOKEN 提高 API 限额; OPENAI_API_KEY + OPENAI_MODEL 自动生成中文点评

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const since = process.argv[2] || "daily";

// 分析后端：自备 key（唯一可靠的 LLM 路径）。没 key 就降级到机器翻译。
const LLM = process.env.OPENAI_API_KEY
  ? { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: process.env.OPENAI_MODEL || "gpt-4o-mini", how: "自备 key" }
  : null;
const HAS_LLM = !!LLM;
const UA = { "user-agent": "gh-trending-daily", "accept-language": "en-US,en" };
const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const cn = (n) => (n == null ? "" : String(n).replace(/,/g, ""));

async function scrape() {
  // github.com 的 HTML 页面偶发连接超时，重试 3 次
  let html, lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      html = await (await fetch(`https://github.com/trending?since=${since}`, {
        headers: UA,
        signal: AbortSignal.timeout(30000),
      })).text();
      break;
    } catch (e) {
      lastErr = e;
      process.stderr.write(`抓取失败(${i + 1}/3)：${e.cause?.code || e.message}\n`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  if (!html) throw new Error(`无法访问 github.com/trending：${lastErr?.cause?.code || lastErr?.message}`);
  return html.split('<article class="Box-row"').slice(1).map((a) => ({
    repo: (a.match(/<h2[\s\S]*?href="\/([^"]+)"/) || [])[1],
    lang: (a.match(/itemprop="programmingLanguage">([^<]+)</) || [])[1] || "—",
    desc: strip((a.match(/<p class="col-9[^"]*"[\s\S]*?>([\s\S]*?)<\/p>/) || [])[1] || ""),
    today: cn((a.match(/([\d,]+)\s*stars today/) || [])[1]),
  })).filter((r) => r.repo);
}

async function meta(repo) {
  const h = { ...UA, accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const j = await (await fetch(`https://api.github.com/repos/${repo}`, { headers: h })).json();
  return {
    stars: j.stargazers_count ?? 0,
    forks: j.forks_count ?? 0,
    created: (j.created_at || "").slice(0, 10),
    license: j.license?.spdx_id || "",
    topics: (j.topics || []).slice(0, 8),
    homepage: j.homepage || "",
    description: j.description || "",
  };
}

async function readme(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: { ...UA, accept: "application/vnd.github.raw" } });
  return res.ok ? (await res.text()).slice(0, 8000) : "(无 README)";
}

// 翻译源：按顺序试，记住第一个能用的（sticky），后面不再重试坏源。
// googleapis 的 gtx 端点是未公开接口，会被数据中心 IP 屏蔽，所以必须有备胎。
const TRANSLATORS = [
  { name: "googleapis", build: (t) => `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(t)}`,
    parse: (j) => (j?.[0] || []).map((s) => s[0]).join("") },
  { name: "mymemory", build: (t) => `https://api.mymemory.translated.net/get?q=${encodeURIComponent(t)}&langpair=en|zh-CN`,
    parse: (j) => j?.responseData?.translatedText || "" },
  { name: "simplytranslate", build: (t) => `https://simplytranslate.org/api/translate/?engine=google&from=en&to=zh-CN&text=${encodeURIComponent(t)}`,
    parse: (j) => j?.translation?.translated || "" },
];
let activeTranslator = TRANSLATORS[0];
const translatorStats = {};

async function translate(text) {
  if (!text?.trim()) return "";
  const t = text.slice(0, 1800);
  for (const api of [activeTranslator, ...TRANSLATORS.filter((x) => x !== activeTranslator)]) {
    try {
      const r = await fetch(api.build(t), { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const out = api.parse(await r.json());
      if (out && /[一-龥]/.test(out)) {          // 确认真的翻出中文了
        activeTranslator = api;                  // 粘住好用的源
        translatorStats[api.name] = (translatorStats[api.name] || 0) + 1;
        return out.replace(/[ \t]+/g, " ").trim();
      }
      throw new Error("返回结果里没有中文");
    } catch {
      translatorStats[`${api.name}:失败`] = (translatorStats[`${api.name}:失败`] || 0) + 1;
    }
  }
  return "";
}

// 翻译前先清掉噪音：徽章、图片、原始 HTML、HTML 注释 —— 它们占一半篇幅且翻译不出信息
function cleanMarkdown(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")          // HTML 注释
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")    // 图片
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "") // 徽章
    .replace(/<[^>]+>/g, "")                 // 原始 HTML 标签
    .replace(/^\s*\|[\s:|-]+\|\s*$/gm, "")   // 表格分隔行
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 按段落切块，每块不超过 limit；代码块整块跳过（翻译代码只会变噪音）
function chunkForTranslate(md, limit = 1500) {
  const out = [];
  let buf = "", inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; buf += line + "\n"; continue; }
    if (inFence) { buf += line + "\n"; }
    else if (buf.length + line.length > limit) { out.push(buf.trim()); buf = ""; buf += line + "\n"; }
    else { buf += line + "\n"; }
    if (buf.length > limit * 2) { out.push(buf.trim()); buf = ""; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

// 整篇翻译 README，带进度和节流。预算 3500 字符/项目 —— MyMemory 匿名额度是全站
// 每天 5 万字符，12 个项目 × 3500 才 4.2 万，留点余量。
async function translateReadme(repo, budget = 3500) {
  const md = cleanMarkdown(await readme(repo.repo));
  if (!md) return { text: "", chunks: 0, truncated: false };
  const chunks = chunkForTranslate(md);
  const parts = [];
  let used = 0;
  for (const [i, c] of chunks.entries()) {
    if (used >= budget) return { text: parts.join("\n\n"), chunks: i, truncated: true };
    process.stderr.write(`    翻译 ${repo.repo} 块 ${i + 1}/${chunks.length}\n`);
    const t = await translate(c);
    parts.push(t || c);
    used += c.length;
    await new Promise((r) => setTimeout(r, 250)); // 别把 Google 打到限流
  }
  return { text: parts.join("\n\n"), chunks: chunks.length, truncated: false };
}

// 不同后端对 response_format 支持不一致，靠提示词 + 抽取 + 重试兜底
const NO_MD = "\n\n只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块、不要 OK/好的之类的前缀。";

// 从模型回复里抠出 JSON（模型爱加 ```json 包裹、前后废话）
function extractJSON(text) {
  if (!text) throw new Error("空回复");
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1] : text).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) return JSON.parse(raw.slice(s, e + 1));
    throw new Error("回复里找不到 JSON");
  }
}

async function askJSON(system, user, temperature = 0.3) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${LLM.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${LLM.key}` },
        body: JSON.stringify({
          model: LLM.model,
          temperature,
          messages: [
            { role: "system", content: system + NO_MD },
            { role: "user", content: user + (attempt ? `\n\n【第 ${attempt + 1} 次尝试】上一次你的回复不是合法 JSON。必须只输出 JSON 对象本身，第一个字符是 {，最后一个字符是 }。` : "") },
          ],
        }),
      });
      // 后端返回的不是 JSON（比如被网关拦截返回 "OK"）—— 明确报错，别让 JSON.parse 崩掉
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
      try {
        return extractJSON(JSON.parse(text).choices?.[0]?.message?.content);
      } catch (e) {
        throw new Error(`后端未返回预期 JSON（content-type: ${res.headers.get("content-type")}, 开头: ${JSON.stringify(text.slice(0, 40))}）`);
      }
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

const ANALYST = "你是开源情报分析师。读项目的 README 后用**中文**解释它，不要翻译 tagline，要讲清实际工作流程、核心技术机制、谁在用、有什么坑。\n"
  + '输出 JSON，字段固定为：{"是什么":"3-5句，讲清打开它之后具体能干什么，具体到功能/命令/工作流层面",'
  + '"核心机制":["4-8条，每条一个技术要点，具体到协议/架构/算法名词"],'
  + '"使用场景":["3-5条，谁在什么情况下用"],'
  + '"坑":["2-4条，许可/硬件/成熟度/合规风险等"],'
  + '"一句话判断":"值不值得抄作业，一句话"}';

const EMPTY = { 是什么: "", 核心机制: [], 使用场景: [], 坑: [], 一句话判断: "", readmeCN: "" };

// 逐仓库：无 key 就翻译整篇 README，有 key 就深读分析
async function analyze(repo) {
  const md = await readme(repo.repo);
  if (!LLM) {
    const descT = await translate(repo.desc);
    const r = await translateReadme(repo);
    return {
      ...EMPTY,
      是什么: descT || repo.desc,
      一句话判断: descT || repo.desc,
      readmeCN: r.text,
      truncated: r.truncated,
      降级: true,
    };
  }
  try {
    const j = await askJSON(ANALYST, `仓库：${repo.repo}\n语言：${repo.lang}\n简介：${repo.desc}\n\nREADME 摘录：\n${md}`);
    return {
      ...EMPTY,
      是什么: j.是什么 || repo.desc,
      核心机制: Array.isArray(j.核心机制) ? j.核心机制 : [j.核心机制].filter(Boolean),
      使用场景: Array.isArray(j.使用场景) ? j.使用场景 : [j.使用场景].filter(Boolean),
      坑: Array.isArray(j.坑) ? j.坑 : [j.坑].filter(Boolean),
      一句话判断: j.一句话判断 || repo.desc,
    };
  } catch (e) {
    return { ...EMPTY, 是什么: `分析失败（${e.message.slice(0, 80)}）`, 一句话判断: repo.desc };
  }
}

// 汇总当日趋势
async function themes(repos, notes) {
  const list = repos.map((r, i) => `${i + 1}. ${r.repo} (+${r.today}/天) —— ${notes[i]?.是什么 ?? ""}`).join("\n");
  try {
    return await askJSON(
      "用中文总结这批 GitHub 热门项目反映出的趋势和可抄作业的机会。\n"
      + '输出 JSON，字段固定为：{"信号":["3-5条，每条说明一个可利用的趋势信号"],"可抄作业":["3-5条具体的、能动手做的小项目 idea"]}',
      `今天 GitHub ${since} 榜：\n${list}`,
      0.5,
    );
  } catch {
    return null;
  }
}

const repos = await scrape();
for (const r of repos) Object.assign(r, await meta(r.repo).catch(() => ({})));

const notes = [];
if (!HAS_LLM) process.stderr.write("未配置 OPENAI_API_KEY —— 走全文机翻模式\n");
for (const [i, r] of repos.entries()) {
  // 串行：LLM 模式怕撞速率限制；翻译模式怕被 Google 限流
  process.stderr.write(`处理 ${i + 1}/${repos.length} ${r.repo}\n`);
  notes.push(await analyze(r));
}
const sum = HAS_LLM ? await themes(repos, notes).catch(() => null) : null;

// ---- 纯计算部分：不需要模型 ----
const day = new Date().toISOString().slice(0, 10);
const num = (r) => +(r.today || 0).replace(/,/g, "");
const total = repos.reduce((s, r) => s + num(r), 0);
const maxed = repos.filter((r) => num(r) >= 2000);
const fresh = repos.filter((r) => r.created && (new Date(day) - new Date(r.created)) / 864e5 < 120);

// 和昨天比：哪些是新面孔。首次运行时 reports/ 还不存在，直接当空。
const REPORTS = join(ROOT, "reports");
const prevFile = existsSync(REPORTS)
  ? readdirSync(REPORTS).filter((f) => f.startsWith(`${since}-`) && f.endsWith(".md") && f !== "README.md").sort().at(-2)
  : undefined;
const prev = prevFile
  ? [...readFileSync(join(REPORTS, prevFile), "utf8").matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/g)].map((m) => m[1])
  : [];
const newcomers = repos.map((r) => r.repo).filter((n) => !prev.includes(n));

const stats = [
  `在榜项目 **${repos.length}** 个，今日新增 star 合计 **+${total.toLocaleString()}**`,
  fresh.length ? `**${fresh.length}/${repos.length}** 是 120 天内新建的仓库（${fresh.map((r) => r.repo.split("/")[1]).join("、")}）—— 冷启动极快` : "在榜项目全部已存在超过半年，没有新项目冒头",
  maxed.length ? `**${maxed.length}** 个项目单日破 2000 star：${maxed.map((r) => `${r.repo}（+${r.today}）`).join("、")}` : "无单日破 2000 的爆发项目",
  prev.length ? (newcomers.length ? `对比上次榜单，**新面孔 ${newcomers.length}** 个：${newcomers.join("、")}` : "与上次榜单完全一致，无新项目") : "首次生成，下次起会做对比",
  `语言分布：${Object.entries(repos.reduce((m, r) => ((m[r.lang] = (m[r.lang] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
];
// 榜首涨速 vs 尾部：判断是不是马太效应
const sorted = [...repos].sort((a, b) => num(b) - num(a));
const top3 = sorted.slice(0, 3).reduce((s, r) => s + num(r), 0);
stats.push(`前三名占今日总增量的 **${Math.round((top3 / total) * 100)}%**（${sorted[0].repo} 单个占 ${Math.round((num(sorted[0]) / total) * 100)}%）`);

const L = (arr) => (arr?.length ? arr.map((x) => `- ${x}`).join("\n") : "- 无");
const degraded = !HAS_LLM;
const lines = [
  `# GitHub ${since} 热点 · ${day}`,
  "",
  ...(degraded
    ? [`> 📖 本次走**全文机翻模式**（未配置大模型 key）。下面是各项目 README 的机器翻译版，非人工分析、非模型总结。翻译源：**${activeTranslator.name}**（${Object.entries(translatorStats).map(([k, v]) => `${k} ${v}`).join(" · ") || "无成功记录"}）。代码示例、安装步骤建议回原仓库核对。`, ""]
    : [`> 分析后端：**${LLM.how}**（model: \`${LLM.model}\`）`, ""]),
  "## 一览",
  "",
  "| # | 项目 | 语言 | ⭐ 总量 | 今日新增 | 描述 |",
  "|---|---|---|---|---|---|",
  ...repos.map((r, i) => `| ${i + 1} | [${r.repo}](https://github.com/${r.repo}) | ${r.lang} | ${(r.stars ?? 0).toLocaleString()} | **+${r.today}** | ${(notes[i]?.一句话判断 || r.desc).replace(/\|/g, "\\|")} |`),
  "",
  "## 数据观察",
  "",
  ...stats.map((s) => `- ${s}`),
  "",
];
for (const [i, r] of repos.entries()) {
  const n = notes[i] || {};
  const head = `**${(r.stars ?? 0).toLocaleString()}⭐ · 今日 +${r.today} · ${r.lang}**${r.created ? ` · 创建于 ${r.created}` : ""} · [仓库](https://github.com/${r.repo})`;
  lines.push(`## ${i + 1}. ${r.repo}`, "", head, "");
  if (degraded) {
    lines.push(`**简介**：${n.是什么 || r.desc}`, "");
    if (n.readmeCN) {
      lines.push("### README（机器翻译）", "", n.readmeCN, "");
      if (n.truncated) lines.push("*（README 较长，以上为开头部分的翻译，点击仓库看全文）*", "");
    } else {
      lines.push("*README 翻译失败或为空，点击仓库链接看原文。*", "");
    }
  } else {
    lines.push(
      `**它到底是什么**：${n.是什么 || r.desc}`,
      "",
      `**核心机制**：`, L(n.核心机制), "",
      `**使用场景**：`, L(n.使用场景), "",
      `**需要注意的坑**：`, L(n.坑), "",
    );
  }
}
if (sum) lines.push("## 今日趋势信号", "", L(sum.信号), "", "## 可抄作业的 idea", "", L(sum.可抄作业), "");
if (degraded) {
  lines.push("---", "", "想要真正的深度分析（读 README 后输出「它到底是什么/核心机制/使用场景/坑」）而非机翻？加一个 `OPENAI_API_KEY`。DeepSeek 注册送额度，够用很久：key 填 `OPENAI_API_KEY`，`OPENAI_BASE_URL` 填 `https://api.deepseek.com/v1`。代码无需改动。", "");
}
lines.push("---", `生成于 ${new Date().toISOString()} · [历史报告](https://github.com/${process.env.GITHUB_REPOSITORY || "pephupephu/Github-daily-report"}/tree/main/reports)`);

mkdirSync(join(ROOT, "reports"), { recursive: true });
writeFileSync(join(ROOT, "reports", `${since}-${day}.md`), lines.join("\n"));

// 结构化数据给 article.mjs 用（抓演示链接、生成公众号文章）
writeFileSync(join(ROOT, "reports", "latest.json"), JSON.stringify({
  day,
  since,
  mode: degraded ? "translate" : LLM.how,
  repos: repos.map((r, i) => ({
    repo: r.repo, lang: r.lang, desc: r.desc,
    stars: r.stars ?? 0, today: r.today, forks: r.forks ?? 0,
    created: r.created, license: r.license, topics: r.topics, homepage: r.homepage,
    url: `https://github.com/${r.repo}`,
    summary: notes[i]?.是什么 || "",
    readmeCN: notes[i]?.readmeCN || "",
  })),
}, null, 2));

const idx = join(ROOT, "reports", "README.md");
const row = `- [${since}-${day}](./${since}-${day}.md) — 榜首 ${repos[0]?.repo} (+${repos[0]?.today})\n`;
if (!existsSync(idx)) writeFileSync(idx, `# 报告索引\n\n${row}`);
else appendFileSync(idx, row);

console.log(lines.join("\n"));