#!/usr/bin/env node
// 抓 GitHub 日/周/月榜 -> 生成中文 Markdown -> 写 reports/YYYY-MM-DD.md 并追加到 README 索引
// 用法: node trending.mjs [daily|weekly|monthly]
// 可选: GITHUB_TOKEN 提高 API 限额; OPENAI_API_KEY + OPENAI_MODEL 自动生成中文点评

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
if (!process.env.OPENAI_API_KEY) {
  console.error("缺少 OPENAI_API_KEY —— 中文分析靠大模型。先 set OPENAI_API_KEY（可选 OPENAI_BASE_URL / OPENAI_MODEL）再跑。");
  process.exit(1);
}
const since = process.argv[2] || "daily";
const UA = { "user-agent": "gh-trending-daily", "accept-language": "en-US,en" };
const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const cn = (n) => (n == null ? "" : String(n).replace(/,/g, ""));

async function scrape() {
  const html = await (await fetch(`https://github.com/trending?since=${since}`, { headers: UA })).text();
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

// 逐仓库深读 README，输出中文结构化分析
async function analyze(repo) {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  if (!key) throw new Error("缺少 OPENAI_API_KEY：中文分析依赖大模型，配置后重跑");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          "你是开源情报分析师。读项目的 README 后用**中文**解释它，不要翻译 tagline，要讲清实际工作流程、核心技术机制、谁在用、有什么坑。\n" +
          "严格输出 JSON：{\"是什么\":\"3-5句，讲清打开它之后具体能干什么，具体到功能/命令/工作流层面\","
          + "\"核心机制\":[\"4-8条，每条一个技术要点，具体到协议/架构/算法名词\"],"
          + "\"使用场景\":[\"3-5条，谁在什么情况下用\"],"
          + "\"坑\":[\"2-4条，许可/硬件/成熟度/合规风险等\"],"
          + "\"一句话判断\":\"值不值得抄作业，一句话\"}" },
        { role: "user", content: `仓库：${repo.repo}\n语言：${repo.lang}\n简介：${repo.desc}\n\nREADME 摘录：\n${await readme(repo.repo)}` },
      ],
    }),
  }).then((r) => r.json());
  try {
    return JSON.parse(res.choices[0].message.content);
  } catch (e) {
    return { 是什么: `分析失败：${e.message}`, 核心机制: [], 使用场景: [], 坑: [], 一句话判断: "" };
  }
}

// 汇总当日趋势
async function themes(repos, notes) {
  const key = process.env.OPENAI_API_KEY;
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  const list = repos.map((r, i) => `${i + 1}. ${r.repo} (+${r.today}/天) —— ${notes[i]?.是什么 ?? ""}`).join("\n");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.5,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "用中文总结这批 GitHub 热门项目反映出的趋势和可抄作业的机会。输出 JSON：{\"信号\":[\"3-5条，每条说明一个可利用的趋势信号\"],\"可抄作业\":[\"3-5条具体的、能动手做的小项目 idea\"]}" },
        { role: "user", content: `今天 GitHub ${since} 榜：\n${list}` },
      ],
    }),
  }).then((r) => r.json());
  try { return JSON.parse(res.choices[0].message.content); } catch { return null; }
}

const repos = await scrape();
for (const r of repos) Object.assign(r, await meta(r.repo).catch(() => ({})));
const notes = [];
for (const [i, r] of repos.entries()) {
  process.stderr.write(`分析 ${i + 1}/${repos.length} ${r.repo}\n`);
  notes.push(await analyze(r));
}
const sum = await themes(repos, notes).catch(() => null);

const day = new Date().toISOString().slice(0, 10);
const L = (arr) => (arr?.length ? arr.map((x) => `- ${x}`).join("\n") : "- 无");
const lines = [
  `# GitHub ${since} 热点 · ${day}`,
  "",
  "| # | 项目 | 语言 | ⭐ 总量 | 今日新增 | 一句话 |",
  "|---|---|---|---|---|---|",
  ...repos.map((r, i) => `| ${i + 1} | [${r.repo}](https://github.com/${r.repo}) | ${r.lang} | ${(r.stars ?? 0).toLocaleString()} | **+${r.today}** | ${(notes[i]?.一句话判断 || r.desc).replace(/\|/g, "\\|")} |`),
  "",
];
for (const [i, r] of repos.entries()) {
  const n = notes[i] || {};
  lines.push(
    `## ${i + 1}. ${r.repo}`,
    "",
    `**${(r.stars ?? 0).toLocaleString()} stars · +${r.today} 今天 · ${r.lang}** · [仓库](https://github.com/${r.repo})`,
    "",
    `**它到底是什么**：${n.是什么 ?? r.desc}`,
    "",
    `**核心机制**：`,
    L(n.核心机制),
    "",
    `**使用场景**：`,
    L(n.使用场景),
    "",
    `**需要注意的坑**：`,
    L(n.坑),
    "",
  );
}
if (sum) lines.push("## 今日趋势信号", "", L(sum.信号), "", "## 可抄作业的 idea", "", L(sum.可抄作业), "");
lines.push("---", `生成于 ${new Date().toISOString()} · [订阅更新](https://github.com/${process.env.GITHUB_REPOSITORY || "OWNER/REPO"}/commits/main.atom)`);
lines.push("---", `生成于 ${new Date().toISOString()} · [订阅 RSS](https://github.com/${process.env.GITHUB_REPOSITORY || "OWNER/REPO"}/commits/main.atom)`);

mkdirSync(join(ROOT, "reports"), { recursive: true });
writeFileSync(join(ROOT, "reports", `${since}-${day}.md`), lines.join("\n"));

const idx = join(ROOT, "reports", "README.md");
const row = `- [${since}-${day}](./${since}-${day}.md) — 榜首 ${repos[0]?.repo} (+${repos[0]?.today})\n`;
if (!existsSync(idx)) writeFileSync(idx, `# 报告索引\n\n${row}`);
else appendFileSync(idx, row);

console.log(lines.join("\n"));