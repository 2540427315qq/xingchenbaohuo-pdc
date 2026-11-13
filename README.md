# teleagent-dashboard

TeleAgent 云电脑的**实例保活 + 一键打开云电脑 + 每日积分 + 电源管理 + 机器状态**控制台。

保活机制参考社区逆向成果（teleagent-keepalive v1.3.0）：调用平台实例管理 API（`teleagent-manager/v1`）实现换票保活与自动拉起，鉴权复用本机客户端凭据。

## 功能

- 🔌 **实例保活（ticket 模式）**：每 5 分钟调 `instance/connect` 换票（活跃信号，不占客户端位、不顶浏览器会话）；发现实例关机/排队时自动 `instance/start` **远程拉起**
- 🚀 **一键打开云电脑**：页面按钮直达官方网页端（临时票据 URL，点击即用）
- 🎁 **每日积分**：自动/手动领取积分福利社 100 积分（驱动本机客户端 UI，已验证通道），状态实时展示
- ⚡ **电源管理**：一键重启（60 秒倒计时可取消）；重装直达官方安全中心
- 🖥️ **机器状态**：CPU/内存/运行时长/凭据有效期
- 📢 **企微通知**：掉线/自动拉起/积分到账推送（webhook，带冷却去重）
- 📜 活动日志 + 领取时间/保活间隔设置

## 本机运行（Windows 云电脑上）

```powershell
cd teleagent-dashboard
npm install          # 仅需 ws 一个依赖
node server.js       # 打开 http://127.0.0.1:8590
```

鉴权自动完成：读取 TeleAgent 客户端 `data/users/*/app-auth/token.json`，DPAPI + AES-GCM 解出 JWT；客户端续期后自动跟进（每分钟检测文件变化）。

依赖：Python 侧领取脚本需要 `uiautomation comtypes pywin32`（`pip install uiautomation comtypes pywin32`）。

## Docker 部署（其他机器）

容器内无 Windows 客户端，鉴权改用挂载的 JWT 文件：

```powershell
# 1) 在源云电脑导出 JWT（单行文本）
python scripts/export_jwt.py > data/jwt.txt
# 2) 拷贝整个 teleagent-dashboard 目录到目标机，然后：
docker compose up -d --build
# 打开 http://<目标机IP>:8590
```

> JWT 有效期约 23 天，过期后重新导出并替换 `data/jwt.txt`，容器会自动检测更新（60 秒内）。
> Docker 模式下「立即领取」按钮不可用（无客户端 UI），领取请在源机进行或手动领取；状态/心跳/重启均可用。

## 安全说明

- JWT 只保存在本机 `data/` 目录；控制台默认只监听 127.0.0.1
- 重启有 60 秒缓冲与取消；重装跳转官方页面由官方确认流程把关
- 部署到公网前请自行加反向代理鉴权

## 配置（data/config.json）

| 键 | 说明 | 默认 |
|---|---|---|
| `keepalive.enabled` | 保活开关 | true |
| `keepalive.mode` | 保活模式（ticket=换票不占位；claim 暂未实现） | ticket |
| `keepalive.refreshSec` | 换票间隔秒数（最小 60） | 300 |
| `notify.enabled / notify.wecomWebhook` | 企微推送 | false / 空 |
| `points.claim_time` | 每日领取时间 | 08:05 |
| `points.catchup_on_start` | 启动时补领 | true |
| `power.mode` | **local**=云电脑本机部署（重启可用，shutdown 重启的就是云电脑）；**remote**=Docker 等异地部署（重启自动禁用，避免误重启部署机） | local（Docker 镜像默认 remote） |
| `teleagent_dir` | 客户端 data 目录（本机模式） | D:/TeleAgent/data |
| `token_file` | 明文 JWT 文件（Docker 模式，或环境变量 TA_TOKEN_FILE） | - |

> ⚠️ **部署位置决定重启语义**：`shutdown` 永远作用于"工具所在的那台机器"。只有工具跑在云电脑本机上，重启才是重启云电脑。Docker 部署到 NAS/VPS/其他服务器时，本工具已通过 `TA_MODE=remote`（或 `power.mode: remote`）自动禁用重启按钮并拒绝重启指令；重装为 302 跳转官方页（在你自己的浏览器打开），与部署位置无关。

> AI生成
