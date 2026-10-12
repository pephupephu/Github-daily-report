# Github-daily-report

每天抓 GitHub 官方 Trending，**读每个项目 README 生成中文深度分析**，发到邮箱并归档。

报告里每个项目包含：它到底是什么（讲实际工作流程，不是翻译 tagline）、核心机制、使用场景、需要注意的坑、一句话判断，外加当日趋势信号。

---

## 隐私

**仓库里不含任何邮箱、密钥或个人信息。** 具体做法：

| 泄露途径 | 处理 |
|---|---|
| 邮箱写进代码 | 不写。`mail.mjs` 只读环境变量 |
| Git 提交记录 | workflow 里用 `report-bot / actions@github.com`，不用真实邮箱 |
| Actions 运行日志 | 公开仓库的日志是公开的，`mail.mjs` **不打印收件人地址** |
| 报告内容 | 只有 GitHub 公开信息，无个人信息 |
| 密钥 | 全部走 GitHub Secrets（加密存储，日志自动打码） |

**建议**：如果不希望报告公开，把仓库改成 Private（Settings → General → Danger Zone）。改成私有后 Actions 仍可用（免费额度）。

---

## 配置（一次性）

### 1. 拿 163 邮箱的客户端授权码

登录 163 邮箱网页版 → 设置 → POP3/SMTP/IMAP → 开启 SMTP → **生成授权码**。

> ⚠️ 是**授权码**，不是你的登录密码。163 从 2014 年起就禁止用密码直接发 SMTP 了。

### 2. 在仓库里加 Secrets

Settings → Secrets and variables → Actions → New repository secret：

| 名称 | 值 |
|---|---|
| `MAIL_USER` | 你的完整 163 邮箱地址 |
| `MAIL_PASS` | 上一步的**授权码** |
| `MAIL_TO` | 收件邮箱（不填就发给自己） |
| `OPENAI_API_KEY` | 大模型 key，中文分析靠它 |
| `OPENAI_BASE_URL` | 可选，`https://api.deepseek.com/v1` 之类 |

Variables（可选）：`OPENAI_MODEL` 默认 `gpt-4o-mini`。

### 3. 开权限

Settings → Actions → General → Workflow permissions → **Read and write**。

### 4. 手动跑一次验证

Actions → Daily report + email → Run workflow。成功后每天 UTC 01:17（北京时间 09:17）自动执行。

---

## 本地跑

```bash
npm install
set OPENAI_API_KEY=sk-xxx
set MAIL_USER=xxx@163.com
set MAIL_PASS=你的授权码
node trending.mjs daily
node mail.mjs
```

9 个项目各一次调用，一天约 10 次请求，几分钱。嫌慢把 `trending.mjs` 里的 for 循环改成 `Promise.all`。

---

## 输出

- 邮件：每天一封，Markdown 转 HTML
- `reports/daily-YYYY-MM-DD.md`：归档
- `reports/README.md`：索引

---

## 注意

**模型权重许可 ≠ 代码许可**（若后续打包分发模型）。当前仓库只做分析和邮件分发，不分发任何模型。