#!/usr/bin/env node
// 抓 GitHub 日/周/月榜 -> 生成中文 Markdown -> 写 reports/YYYY-MM-DD.md 并追加到 README 索引
// 用法: node trending.mjs [daily|weekly|monthly]
// 可选: GITHUB_TOKEN 提高 API 限额; OPENAI_API_KEY + OPENAI_MODEL 自动生成中文点评

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const since = process.argv[2] || "daily";

// ---- 分析后端分级：自带 key > GitHub Models(免费) > Google 翻译(永远可用) ----
const GH_MODELS = "https://models.github.ai/inference";
const LLM = process.env.OPENAI_API_KEY
  ? { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1", model: process.env.OPENAI_MODEL || "gpt-4o-mini", how: "自备 key" }
  : process.env.GITHUB_TOKEN
    ? { key: process.env.GITHUB_TOKEN, base: GH_MODELS, model: process.env.OPENAI_MODEL || "openai/gpt-4o-mini", how: "GitHub Models（免费）" }
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
  return { stars: j.stargazers_count ?? 0, forks: j.forks_count ?? 0, created: (j.created_at || "").slice(0, 10) };
}

async function readme(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: { ...UA, accept: "application/vnd.github.raw" } });
  return res.ok ? (await res.text()).slice(0, 8000) : "(无 README)";
}

// Google 翻译公开接口，免 key 免注册
async function translate(text) {
  if (!text) return "";
  try {
    const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text.slice(0, 1800))}`,
      { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return (j[0] || []).map((s) => s[0]).join("").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

// 无 key 时：从 README 抽出结构化片段再翻译（翻译整篇既慢又没信息量）
function digestReadme(md) {
  const heads = [...md.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim());
  const bullets = [...md.matchAll(/^[-*]\s+(.{10,160})$/gm)].map((m) => m[1].trim());
  const picked = [...new Set([...heads.slice(0, 12), ...bullets.slice(0, 14)])];
  return picked.join(" | ").slice(0, 1800);
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
      }).then((r) => r.json());
      if (res.error) throw new Error(JSON.stringify(res.error).slice(0, 200));
      return extractJSON(res.choices?.[0]?.message?.content);
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

const EMPTY = { 是什么: "", 核心机制: [], 使用场景: [], 坑: [], 一句话判断: "" };

// 逐仓库深读 README，输出中文结构化分析
async function analyze(repo) {
  const md = await readme(repo.repo);
  if (!LLM) {
    // 降级：机器翻译。没有推理能力，但保证读者看到的是中文而不是英文。
    const [descT, headT] = await Promise.all([translate(repo.desc), translate(digestReadme(md))]);
    return {
      ...EMPTY,
      是什么: descT || repo.desc,
      核心机制: headT ? headT.split(" | ").filter((x) => x.length > 3).slice(0, 8).map((s) => `（README 原文要点，机翻）${s}`) : [],
      一句话判断: descT || repo.desc,
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
if (HAS_LLM) {
  // 串行 + 每个项目内部重试 3 次，避免撞 GitHub Models 速率限制
  for (const [i, r] of repos.entries()) {
    process.stderr.write(`分析 ${i + 1}/${repos.length} ${r.repo}\n`);
    notes.push(await analyze(r));
  }
} else {
  process.stderr.write("未配置 OPENAI_API_KEY —— 生成榜单 + 数据统计（无 AI 深读点评）\n");
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
    ? [`> ⚠️ 本次走**机器翻译降级模式**（无大模型可用）。描述和 README 要点是机翻的，只保证中文可读，没有深度分析。`, ""]
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
  lines.push(
    `## ${i + 1}. ${r.repo}`,
    "",
    head,
    "",
    `**它到底是什么**：${n.是什么 || r.desc}`,
    "",
    ...(degraded
      ? (n.核心机制?.length ? ["**README 要点（机翻，非分析）**：", L(n.核心机制), ""] : [])
      : [`**核心机制**：`, L(n.核心机制), "", `**使用场景**：`, L(n.使用场景), "", `**需要注意的坑**：`, L(n.坑), ""]),
  );
}
if (sum) lines.push("## 今日趋势信号", "", L(sum.信号), "", "## 可抄作业的 idea", "", L(sum.可抄作业), "");
if (degraded) {
  lines.push("---", "", "想要真正的深度分析（而非机翻）？在仓库 Secrets 加 `OPENAI_API_KEY`，或在 workflow 里加一行 `GITHUB_TOKEN`（GitHub Models 免费可用）。代码无需改动。", "");
}
lines.push("---", `生成于 ${new Date().toISOString()} · [历史报告](https://github.com/${process.env.GITHUB_REPOSITORY || "pephupephu/Github-daily-report"}/tree/main/reports)`);

mkdirSync(join(ROOT, "reports"), { recursive: true });
writeFileSync(join(ROOT, "reports", `${since}-${day}.md`), lines.join("\n"));

const idx = join(ROOT, "reports", "README.md");
const row = `- [${since}-${day}](./${since}-${day}.md) — 榜首 ${repos[0]?.repo} (+${repos[0]?.today})\n`;
if (!existsSync(idx)) writeFileSync(idx, `# 报告索引\n\n${row}`);
else appendFileSync(idx, row);

console.log(lines.join("\n"));