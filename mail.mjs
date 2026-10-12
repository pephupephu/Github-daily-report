// 把 reports/ 里最新的报告发到 163 邮箱
// 需要环境变量: MAIL_USER(完整邮箱) MAIL_PASS(163 客户端授权码)
// 可选: MAIL_TO(默认发给自己) MAIL_HOST(默认 smtp.163.com) MAIL_PORT(默认 465)

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTransport } from "nodemailer";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIR = join(ROOT, "reports");
const user = process.env.MAIL_USER;
const pass = process.env.MAIL_PASS;
if (!user || !pass) {
  console.error("缺少 MAIL_USER / MAIL_PASS（163 的客户端授权码，不是登录密码）");
  process.exit(1);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
const latest = files.at(-1);
if (!latest) {
  console.error("reports/ 里没有报告，先跑 node trending.mjs");
  process.exit(1);
}

const md = readFileSync(join(DIR, latest), "utf8");
// 报告是 Markdown，转成简单 HTML 塞进邮件正文
const html = `<html><body style="font-family:-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7;color:#222">
<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px">${md.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</pre>
<hr style="border:none;border-top:1px solid #eee">
<p style="color:#888;font-size:12px">由 pephupephu/Github-daily-report 自动生成 · <a href="https://github.com/pephupephu/Github-daily-report">查看历史报告</a></p>
</body></html>`;

const port = Number(process.env.MAIL_PORT || 465);
const transport = createTransport({
  host: process.env.MAIL_HOST || "smtp.163.com",
  port,
  secure: port === 465,
  auth: { user, pass },
});

const to = process.env.MAIL_TO || user;
await transport.sendMail({
  from: `"GitHub 日报" <${user}>`,
  to,
  subject: `GitHub 日热点 · ${latest.replace(".md", "").replace(/^[a-z]+-/, "")}`,
  html,
});

// 日志里不打印邮箱地址（公开仓库的 Actions 日志是公开的）
console.log(`已发送 ${latest}（收件人已脱敏）`);