// teleagent-dashboard — 会话保活 + 每日积分 + 电源管理 + 机器状态
// 参考 muyicn/ctyun-dashboard 的架构思路，面向 TeleAgent 平台（agent.teleai.com.cn）
// 鉴权：读取本机 TeleAgent 客户端的 token.json（Chromium Safe Storage 加密），
//       DPAPI 解 os_crypt 密钥（Windows）→ Node 原生 AES-256-GCM 解出 JWT。
// 用法：node server.js  （配置见 data/config.json，首次运行自动生成）
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const Auth = require('./lib/auth');
const Login = require('./lib/login');
const Api = require('./lib/api');
const KeepAlive = require('./lib/keepalive');
const Power = require('./lib/power');
const SysMon = require('./lib/sysmon');
const Scheduler = require('./lib/scheduler');
const Log = require('./lib/log');
const Notifier = require('./lib/notify');

const ROOT = __dirname;
const DATA_DIR = process.env.TA_DATA_DIR || path.join(ROOT, 'data');
const PORT = parseInt(process.env.PORT || '8590', 10);

fs.mkdirSync(DATA_DIR, { recursive: true });

const log = new Log(DATA_DIR);
const login = new Login(DATA_DIR, log);
const config = loadConfig();
const auth = new Auth(config, log, login);
const api = new Api(auth, config, log);
const notifier = new Notifier(config, log);
const ka = new KeepAlive(auth, config, log, notifier);
const power = new Power(config, log);
const sysmon = new SysMon();
const scheduler = new Scheduler({ config, log, api, ka, power, notifier });

// ---------- 配置 ----------
function loadConfig() {
  const def = {
    port: PORT,
    // token 来源（Windows 客户端路径；Docker 里改用 TA_TOKEN_FILE 直接放明文 JWT 文件）
    teleagent_dir: process.env.TA_DIR || 'D:/TeleAgent/data',
    token_file: process.env.TA_TOKEN_FILE || '',        // 显式 JWT 文件优先
    // 账号密码登录（异地部署主力：页面登录 → JWT 落盘 data/jwt.txt，自动重登续期）
    auth: { account: '', passwordEnc: '', autoRelogin: true, reloginDays: 7 },
    // 保活（ticket 模式：instance/connect 换票 + 自愈 instance/start）
    keepalive: { enabled: true, mode: 'ticket', refreshSec: 300 },
    // 积分（poll_minutes：认证 API 定期轮询，兼作账号活动心跳）
    points: { claim_time: '08:05', catchup_on_start: true, poll_minutes: 10 },
    // 电源（local=云电脑本机部署，重启可用；remote=Docker 等异地部署，重启禁用）
    power: { mode: process.env.TA_MODE || 'local' },
    // 通知（企业微信 webhook，掉线/拉起/积分事件推送）
    notify: { enabled: false, wecomWebhook: '', cooldownMin: 30 },
    // 平台
    api_base: 'https://agent.teleai.com.cn/superCowork/sapi',
    reinstall_url: 'https://agent.teleai.com.cn/teleagent?setting=securityCenter',
  };
  const fp = path.join(DATA_DIR, 'config.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
  const merged = deepMerge(def, cur);
  fs.writeFileSync(fp, JSON.stringify(merged, null, 2));
  merged._file = fp;
  // TA_MODE 仅作运行时覆盖，不落盘（避免临时环境变量污染持久配置）
  if (process.env.TA_MODE) merged.power = Object.assign({}, merged.power || {}, { mode: process.env.TA_MODE });
  return merged;
}
function deepMerge(a, b) {
  const out = Array.isArray(a) ? [...a] : { ...a };
  if (!b || typeof b !== 'object') return out;
  for (const k of Object.keys(b)) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) {
      out[k] = deepMerge(a[k], b[k]);
    } else if (b[k] !== undefined) {
      out[k] = b[k];
    }
  }
  return out;
}

// ---------- 状态聚合 ----------
function status() {
  return {
    time: new Date().toISOString(),
    auth: auth.status(),
    keepalive: ka.status(),
    points: api.pointsSnapshot(),
    power: power.status(),
    system: sysmon.snapshot(),
    scheduler: scheduler.status(),
  };
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(ROOT, 'public', 'index.html')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status()));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(log.tail(200)));
      return;
    }
    // 刷新积分状态（只读 API）
    if (req.method === 'POST' && url.pathname === '/api/points/refresh') {
      const r = await api.refreshPoints();
      json(res, r);
      return;
    }
    // 手动触发领取（UIA 后备通道）
    if (req.method === 'POST' && url.pathname === '/api/points/claim') {
      const r = await scheduler.triggerClaim('manual');
      json(res, r);
      return;
    }
    // 保活开关 / 立即保活一轮
    if (req.method === 'POST' && url.pathname === '/api/keepalive/toggle') {
      const r = ka.toggle();
      json(res, r);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/keepalive/reconnect') {
      const r = await ka.reconnect();
      json(res, r);
      return;
    }
    // 一键打开云电脑（换票生成官方网页入口）
    if (req.method === 'POST' && url.pathname === '/api/desktop/open') {
      try {
        const u = await ka.freshConnectUrl();
        json(res, { ok: true, url: u });
      } catch (e) {
        json(res, { ok: false, error: e.message }, 500);
      }
      return;
    }
    // 账号密码登录：换取 JWT 并接管凭据（密码密文存 data/config.json，明文不落盘）
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      let body = '';
      for await (const c of req) body += c;
      const b = JSON.parse(body || '{}');
      const account = String(b.account || '').trim();
      const password = String(b.password || '');
      if (!account || !password) return json(res, { ok: false, error: '账号和密码都要填' }, 400);
      try {
        const r = await auth.loginAndStore(account, password, { remember: b.remember !== false });
        json(res, r);
      } catch (e) {
        json(res, { ok: false, error: e.message }, 400);
      }
      return;
    }
    // 用已保存的账号密码立即重登（手动续期）
    if (req.method === 'POST' && url.pathname === '/api/auth/relogin') {
      try {
        json(res, await auth.reloginSaved());
      } catch (e) {
        json(res, { ok: false, error: e.message }, 400);
      }
      return;
    }
    // 清除登录凭据（回退客户端 token.json 模式）
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      json(res, await auth.clearLogin());
      return;
    }
    // 通知配置 / 测试
    if (req.method === 'POST' && url.pathname === '/api/notify') {
      let body = '';
      for await (const c of req) body += c;
      const patch = JSON.parse(body || '{}');
      config.notify = deepMerge(config.notify || {}, patch);
      fs.writeFileSync(config._file, JSON.stringify({ ...config, _file: undefined }, null, 2));
      notifier.reset();
      json(res, { ok: true, notify: { enabled: config.notify.enabled, has_webhook: !!config.notify.wecomWebhook } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/notify/test') {
      const r = await notifier.send('测试通知', `来自 teleagent-dashboard\n时间：${new Date().toLocaleString('zh-CN')}`);
      json(res, r.ok ? { ok: true } : { ok: false, error: r.error || '未配置 webhook' }, r.ok ? 200 : 400);
      return;
    }
    // 电源：重启（倒计时）
    if (req.method === 'POST' && url.pathname === '/api/power/restart') {
      const sec = Math.max(30, parseInt(url.searchParams.get('delay') || '60', 10));
      const r = power.scheduleRestart(sec);
      json(res, r);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/power/cancel') {
      json(res, power.cancelRestart());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/power/reinstall') {
      // 官方安全中心直达（重装为危险操作，交由官方界面确认）
      res.writeHead(302, { location: config.reinstall_url });
      res.end();
      power.openReinstallInBrowser();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      let body = '';
      for await (const c of req) body += c;
      const patch = JSON.parse(body || '{}');
      const allowed = ['points', 'keepalive', 'notify'];
      for (const k of allowed) if (patch[k]) config[k] = deepMerge(config[k], patch[k]);
      // auth 节仅允许改开关（账号/密码只能通过 /api/auth/login 设置，禁止外部直接写入）
      if (patch.auth && typeof patch.auth === 'object') {
        const a = config.auth || {};
        if (typeof patch.auth.autoRelogin === 'boolean') a.autoRelogin = patch.auth.autoRelogin;
        if (patch.auth.reloginDays != null) a.reloginDays = Math.max(1, parseInt(patch.auth.reloginDays, 10) || 7);
        config.auth = a;
      }
      fs.writeFileSync(config._file, JSON.stringify({ ...config, _file: undefined }, null, 2));
      scheduler.reschedule();
      // 保活间隔变化时同步到 ka
      ka.refreshSec = Math.max(60, parseInt(config.keepalive.refreshSec || '300', 10));
      json(res, { ok: true, points: config.points, keepalive: config.keepalive });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  } catch (e) {
    json(res, { error: String(e && e.message || e) }, 500);
  }
});

function json(res, obj, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- 启动 ----------
server.listen(PORT, '127.0.0.1', () => {
  log.info('System', `teleagent-dashboard 已就绪: http://127.0.0.1:${PORT}`);
});

auth.onToken(async (jwt) => {
  log.info('Auth', `会话凭据已加载（有效期至 ${auth.expiryText()}），开始初始化各模块`);
  api.bindToken(jwt);
  ka.bindToken(jwt);
  if (process.env.TA_OFFLINE === '1') {
    log.warn('System', 'TA_OFFLINE=1：离线自检模式，跳过平台连接（API/保活/领取）');
    return;
  }
  if (config.keepalive.enabled) ka.start(jwt);
  await api.refreshPoints();
  scheduler.start();
});
auth.init().catch((e) => log.error('Auth', `初始化失败: ${e.message}`));

process.on('SIGINT', () => { try { ka.stop(); } catch {} process.exit(0); });
