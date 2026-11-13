# teleagent-dashboard

TeleAgent 云电脑的**实例保活 + 一键打开云电脑 + 每日积分 + 电源管理 + 机器状态**控制台（为异地部署设计，也可以跑在云电脑本机）。

保活机制参考社区逆向成果（teleagent-keepalive v1.3.0）：调用平台实例管理 API（`teleagent-manager/v1`）实现换票保活与自动拉起。凭据通过账号密码登录获取，自动续期。

## 功能

- 🔌 **实例保活（ticket 模式）**：每 5 分钟调 `instance/connect` 换票（活跃信号，不占客户端位、不顶浏览器会话）；发现实例关机/排队时自动 `instance/start` **远程拉起**
- 🚀 **一键打开云电脑**：页面按钮直达官方网页端（临时票据 URL，点击即用）
- 🎁 **每日积分**：自动/手动领取积分福利社 100 积分（平台 API，任意部署环境可用），状态实时展示
- ⚡ **电源管理**：一键重启（60 秒倒计时可取消）；**定时重启计划**（每日/每周可选，领取任务进行中自动避让）；重装直达官方安全中心
- 🔑 **账号密码登录**：任意部署环境打开页面即可登录获取凭据（滑块验证码自动识别），登录态快过期时自动重登
- 🖥️ **机器状态**：CPU/内存/运行时长/凭据有效期
- 📢 **企微通知**：掉线/自动拉起/积分到账推送（webhook，带冷却去重）
- 📜 活动日志 + 领取时间/保活间隔设置

## 运行（任意平台）

```powershell
cd teleagent-dashboard
npm install          # 仅需 ws 一个依赖
node server.js       # 打开 http://127.0.0.1:8590 → 「🔑 账号登录」登录
```

登录后 JWT 落盘 `data/jwt.txt` 并自动接管凭据；重启后自动恢复（无需重复登录），登录态快过期时自动重登。

> 每日积分自动领取走平台 API（带 JWT 调 `checkTask`），任意部署环境可用；领取失败会通过企微通知提醒。

## Docker 部署（其他机器）

容器内无 Windows 客户端，**直接用页面登录即可**，无需任何 token 文件：

```powershell
# 1) 克隆仓库
git clone https://github.com/TimerDev/teleagent-dashboard.git
cd teleagent-dashboard
# 2) 启动
cp .env.example .env   # 首次部署；编辑 .env 填 TA_PANEL_PASSWORD（公网/隧道必须）
docker compose up -d --build
# 3) 打开 http://<目标机IP>:8590 → 「🔑 账号登录」卡片 → 输入手机号+密码登录
```

> 面板登录密码不写在 `docker-compose.yml` 里（避免 `git pull` 冲突），统一由同目录 `.env`
> 或部署平台（Portainer / NAS 面板等）的 Environment variables 注入；`.env` 已被 .gitignore 排除。
> 修改 `.env` 后重新 `docker compose up -d` 即生效（配置变了会自动重建容器）。

登录后 JWT 写入容器内 `data/jwt.txt`（挂载卷持久化），工具自动接管并按 `reloginDays` 自动重登续期，无需人工维护。

> 每日积分领取走平台 API（带 JWT 调 `checkTask`），Docker 下同样可用（无客户端依赖），“立即领取”随时可点。

## 安全说明

- JWT/密码只保存在本机 `data/` 目录（密码为 AES-256-GCM 密文，密钥在 `data/.secret`），`data/` 已被 .gitignore 排除；控制台默认只监听 127.0.0.1
- 密码明文仅在登录瞬间存在于内存，接口不回显、配置不可外部写入
- 重启有 60 秒缓冲与取消；重装跳转官方页面由官方确认流程把关
- **面板自带登录页（可选）**：未登录访问自动跳到内置登录页（深色风格，错误提示/摇动反馈），密码验证走标准 Basic 凭证（浏览器记住后续免输）；公网/隧道暴露前建议开启
  - Docker：同目录 `.env` 填 `TA_PANEL_USER` / `TA_PANEL_PASSWORD`（或部署平台的 Environment variables），`docker compose up -d` 生效；勿改 `docker-compose.yml`，`git pull` 会冲突
  - 本机：同上环境变量，或 `data/config.json` 写 `{ "panel": { "pass_hash": "<sha256(\"user:密码\") 的 hex>" } }`
  - 登录页显示用户名提示（`TA_PANEL_HINT=0` 可关）；未认证时 API 一律 401，不会重定向泄露入口
  - 公网暴露建议三层叠加：边缘身份（如 Cloudflare Access）+ 面板密码 + origin 只绑回环（`127.0.0.1:8590:8590`）
- 未开启 Basic Auth 时，任何能访问面板的人可调用 `/api/desktop/open` 拿到进入云电脑的临时票据 URL，请勿裸露

## 配置（data/config.json）

| 键 | 说明 | 默认 |
|---|---|---|
| `auth.account / auth.passwordEnc` | 登录账号与密码密文（仅页面登录写入，不可外部配置） | 空 |
| `auth.autoRelogin / auth.reloginDays` | 登录态剩余不足 N 天时自动重登 | true / 7 |
| `keepalive.enabled` | 保活开关 | true |
| `keepalive.mode` | 保活模式（ticket=换票不占位；claim 暂未实现） | ticket |
| `keepalive.refreshSec` | 换票间隔秒数（最小 60） | 300 |
| `notify.enabled / notify.wecomWebhook` | 企微推送 | false / 空 |
| `panel.pass_hash` | 面板 Basic Auth（sha256("user:密码") 的 hex；不设则不启用，优先级：env `TA_PANEL_PASSWORD_HASH` > `TA_PANEL_PASSWORD` > 此处） | 空 |
| `points.claim_time` | 每日领取时间 | 08:05 |
| `points.catchup_on_start` | 启动时补领 | true |
| `power.mode` | **local**=云电脑本机部署（重启可用，shutdown 重启的就是云电脑）；**remote**=Docker 等异地部署（重启自动禁用，避免误重启部署机） | local（Docker 镜像默认 remote） |
| `power.restart_plan` | 定时重启计划：enabled / mode（daily,weekly）/ time / weekday(0=周日)；面板可配，仅 local 模式生效，领取进行中自动跳过 | false / daily / 04:30 / 0 |
| `teleagent_dir` | 客户端 data 目录（本机模式） | D:/TeleAgent/data |

> ⚠️ **部署位置决定重启语义**：`shutdown` 永远作用于"工具所在的那台机器"。只有工具跑在云电脑本机上，重启才是重启云电脑。Docker 部署到 NAS/VPS/其他服务器时，本工具已通过 `TA_MODE=remote`（或 `power.mode: remote`）自动禁用重启按钮并拒绝重启指令；重装为 302 跳转官方页（在你自己的浏览器打开），与部署位置无关。

> AI生成
