'use strict';
// 面板自带 Basic Auth（纵深防御第二层；边缘身份交给 Cloudflare Access 等网关）
// 启用方式（任选其一）：
//   1) env TA_PANEL_USER（默认 admin）+ TA_PANEL_PASSWORD —— 启动时算 sha256 存内存，不落盘
//   2) env TA_PANEL_PASSWORD_HASH —— sha256("user:password") 的 64 位 hex（不想明文进 compose 时用）
//   3) data/config.json -> { "panel": { "pass_hash": "<同上 hex>" } }
// 三者都未配置 = 不启用（本机 127.0.0.1 模式默认）。
// 优先级：PASSWORD_HASH > PASSWORD > config.panel.pass_hash
const crypto = require('crypto');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

class PanelAuth {
  constructor(config, log) {
    this.log = log;
    this.user = String(process.env.TA_PANEL_USER || 'admin').trim() || 'admin';
    let hash = String(process.env.TA_PANEL_PASSWORD_HASH || '').trim().toLowerCase();
    const pass = String(process.env.TA_PANEL_PASSWORD || '');
    if (!hash && pass) hash = sha256(this.user + ':' + pass);
    if (!hash && config && config.panel && config.panel.pass_hash) {
      hash = String(config.panel.pass_hash).trim().toLowerCase();
    }
    this.enabled = /^[0-9a-f]{64}$/.test(hash);
    this.hash = this.enabled ? hash : '';
  }

  // 校验请求；未启用直接放行
  check(req) {
    if (!this.enabled) return true;
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(String(req.headers.authorization || ''));
    if (!m) return false;
    let pair = '';
    try { pair = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
    if (!pair || pair.length > 256) return false;
    const got = Buffer.from(sha256(pair));
    const want = Buffer.from(this.hash);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  challenge(res) {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="teleagent-dashboard", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    });
    res.end('401 Unauthorized');
  }
}

module.exports = PanelAuth;
