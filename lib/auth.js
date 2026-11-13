// 鉴权模块：优先解密本机 TeleAgent 客户端 token.json（Windows）；
// token_file 指向明文 JWT 文件（Docker/Linux）；亦可用账号密码登录换取（lib/login）。
// 路线：Local State(os_crypt.encrypted_key) --DPAPI--> AES key --AESGCM--> JWT
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

class Auth {
  constructor(config, log, login) {
    this.config = config;
    this.log = log;
    this.login = login || null;      // lib/login 实例（账号密码登录）
    this.jwt = null;
    this.jwtExp = null;
    this.listeners = [];
    this.lastTokenMtime = 0;
    this.osCryptKey = null;
    this.timer = null;
    this.error = null;
    this.lastReloginCheck = 0;
    this.relogging = false;
  }

  onToken(fn) { this.listeners.push(fn); }

  status() {
    const a = this.config.auth || {};
    return {
      ok: !!this.jwt,
      expires_at: this.jwtExp ? new Date(this.jwtExp * 1000).toISOString() : null,
      expires_text: this.expiryText(),
      days_left: this.jwtExp ? Math.max(0, ((this.jwtExp * 1000 - Date.now()) / 86400000)).toFixed(1) : null,
      source: this.jwt ? (this.config.token_file ? 'jwt-file' : 'client-token.json') : 'none',
      account_masked: this.maskAccount(a.account || ''),
      has_password: !!a.passwordEnc,
      auto_relogin: !!a.autoRelogin,
      relogin_days: a.reloginDays || 7,
      relogin_check_text: a.autoRelogin && a.account && a.passwordEnc
        ? `剩 ${a.reloginDays || 7} 天时自动重登` : '未配置',
      error: this.error,
    };
  }

  maskAccount(acc) {
    if (!acc) return '';
    if (/^\d{11}$/.test(acc)) return acc.slice(0, 3) + '****' + acc.slice(7);
    return acc.length > 4 ? acc.slice(0, 2) + '***' + acc.slice(-1) : acc;
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.config._file, JSON.stringify({ ...this.config, _file: undefined }, null, 2));
    } catch (e) {
      this.log.error('Auth', `配置落盘失败: ${e.message}`);
    }
  }

  expiryText() {
    if (!this.jwtExp) return '未知';
    const d = new Date(this.jwtExp * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async init() {
    if (this.config.token_file && fs.existsSync(this.config.token_file)) {
      const raw = fs.readFileSync(this.config.token_file, 'utf8').trim();
      this.acceptJwt(raw.split(/\r?\n/)[0].trim(), 'jwt-file');
    } else {
      await this.loadFromClient();
    }
    // 监听 token.json 变化（客户端自动续期后自动跟进）；顺带做登录态自动续期检查
    this.timer = setInterval(() => {
      this.pollTokenFile().catch(() => {});
      this.ensureFresh().catch(() => {});
    }, 60 * 1000);
    this.timer.unref();
  }

  async loadFromClient() {
    const base = this.config.teleagent_dir;
    // 找 owner 用户目录（v1_public_*）
    const tokenPath = this.findTokenPath(base);
    if (!tokenPath) {
      this.error = `未找到 token.json（${base} 下无用户目录）`;
      throw new Error(this.error);
    }
    this.tokenPath = tokenPath;
    this.localStatePath = path.join(base, 'Local State');
    const key = await this.getOsCryptKey();
    const jwt = this.decryptTokenFile(tokenPath, key);
    this.acceptJwt(jwt, 'client-token.json');
  }

  findTokenPath(base) {
    const usersDir = path.join(base, 'users');
    if (fs.existsSync(usersDir)) {
      for (const d of fs.readdirSync(usersDir)) {
        const p = path.join(usersDir, d, 'app-auth', 'token.json');
        if (fs.existsSync(p)) return p;
      }
    }
    const direct = path.join(base, 'app-auth', 'token.json');
    return fs.existsSync(direct) ? direct : null;
  }

  // DPAPI 解 os_crypt 密钥（仅 Windows；PowerShell 一次性执行）
  async getOsCryptKey() {
    if (this.osCryptKey) return this.osCryptKey;
    if (process.platform !== 'win32') throw new Error('非 Windows 平台请用 TA_TOKEN_FILE 提供明文 JWT');
    const ls = JSON.parse(fs.readFileSync(this.localStatePath, 'utf8'));
    const enc = ls.os_crypt && ls.os_crypt.encrypted_key;
    if (!enc) throw new Error('Local State 缺少 os_crypt.encrypted_key');
    const ps = `
$k = [Convert]::FromBase64String('${enc}')
# Local State 的 encrypted_key 前缀为 ASCII "DPAPI"（5 字节），跳过后再解
if ([Text.Encoding]::ASCII.GetString($k[0..4]) -eq 'DPAPI') { $k = $k[5..($k.Length-1)] }
Add-Type -AssemblyName System.Security
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($k, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($plain) | Write-Output -NoEnumerate
`;
    const out = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 20000, windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
    this.osCryptKey = Buffer.from(out.trim(), 'base64');
    if (this.osCryptKey.length !== 32) throw new Error(`os_crypt 密钥长度异常: ${this.osCryptKey.length}`);
    return this.osCryptKey;
  }

  decryptTokenFile(tokenPath, key) {
    const tok = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    if (tok.encrypted === false && tok.token) return tok.token; // 兼容未来明文格式
    const blob = Buffer.from(tok.encryptedToken, 'base64');
    if (blob.slice(0, 3).toString('utf8') !== 'v10' && blob.slice(0, 3).toString('utf8') !== 'v11') {
      throw new Error('token.json 非预期加密格式');
    }
    const nonce = blob.slice(3, 15);
    const ct = blob.slice(15, blob.length - 16);
    const tag = blob.slice(blob.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    if (!pt || pt.split('.').length !== 3) throw new Error('解密结果非 JWT');
    this.lastTokenMtime = fs.statSync(tokenPath).mtimeMs;
    return pt;
  }

  acceptJwt(jwt, source) {
    this.jwt = jwt;
    this.error = null;
    try {
      const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
      this.jwtExp = p.exp || null;
    } catch { this.jwtExp = null; }
    this.log.info('Auth', `JWT 已加载（来源 ${source}，长度 ${jwt.length}，过期 ${this.expiryText()}）`);
    for (const fn of this.listeners) {
      try { fn(jwt); } catch (e) { this.log.error('Auth', `回调失败: ${e.message}`); }
    }
  }

  // ---------- 账号密码登录（Docker/异地部署主力通道） ----------
  // 登录成功 → JWT 写 data/jwt.txt 并把凭据来源切到该文件；remember=true 时保存账号密码（供自动重登）
  async loginAndStore(account, password, opts = {}) {
    if (!this.login) throw new Error('登录模块未初始化');
    const remember = opts.remember !== false;
    const r = await this.login.loginByPassword(String(account).trim(), password);
    const jwt = r.operationToken;

    const jp = this.login.jwtPath();
    fs.writeFileSync(jp, jwt + '\n', { mode: 0o600 });
    this.lastTokenMtime = fs.statSync(jp).mtimeMs;

    if (remember) {
      this.config.auth = Object.assign({}, this.config.auth, {
        account: String(account).trim(),
        passwordEnc: this.login.encryptPassword(password),
      });
    }
    // 凭据来源切到登录文件（客户端 token.json 让位；clearLogin 可恢复）
    this.config.token_file = jp;
    this.saveConfig();

    this.acceptJwt(jwt, 'password-login');
    return {
      ok: true,
      expires_at: this.status().expires_at,
      expires_text: this.expiryText(),
      days_left: this.status().days_left,
    };
  }

  // 用已保存的账号密码立即重登（手动续期）
  async reloginSaved() {
    const a = this.config.auth || {};
    if (!a.account || !a.passwordEnc) throw new Error('未保存账号密码，请先登录');
    if (this.relogging) throw new Error('重登进行中');
    this.relogging = true;
    try {
      const password = this.login.decryptPassword(a.passwordEnc);
      return await this.loginAndStore(a.account, password, { remember: false });
    } finally {
      this.relogging = false;
    }
  }

  // 登录态保鲜：每 12h 检查一次，剩余天数不足 reloginDays 且配置了账号密码 → 自动重登
  async ensureFresh() {
    if (!this.login) return;
    const now = Date.now();
    if (now - this.lastReloginCheck < 12 * 3600 * 1000) return;
    this.lastReloginCheck = now;
    const a = this.config.auth || {};
    if (!a.autoRelogin || !a.account || !a.passwordEnc) return;
    const daysLeft = this.jwtExp ? (this.jwtExp * 1000 - now) / 86400000 : -1;
    if (daysLeft > Number(a.reloginDays || 7)) return;
    if (this.relogging) return;
    this.relogging = true;
    try {
      const password = this.login.decryptPassword(a.passwordEnc);
      await this.loginAndStore(a.account, password, { remember: false });
      this.log.info('Auth', '自动重登成功，登录态已刷新');
    } catch (e) {
      this.log.error('Auth', `自动重登失败: ${e.message}`);
    } finally {
      this.relogging = false;
    }
  }

  // 清除登录凭据，恢复客户端 token.json 模式（本机）；Docker 下凭据清空等待重新登录
  async clearLogin() {
    const a = this.config.auth || {};
    try { fs.unlinkSync(this.login.jwtPath()); } catch {}
    this.config.token_file = '';
    this.config.auth = { account: '', passwordEnc: '', autoRelogin: a.autoRelogin, reloginDays: a.reloginDays };
    this.saveConfig();
    this.lastTokenMtime = 0;
    this.log.info('Auth', '已清除登录凭据，尝试回退到客户端 token.json');
    try {
      await this.loadFromClient();
      return { ok: true, restored: true };
    } catch (e) {
      this.jwt = null;
      this.jwtExp = null;
      this.error = `凭据已清除，且无客户端 token.json（${e.message}）`;
      this.log.warn('Auth', this.error);
      return { ok: true, restored: false };
    }
  }

  async pollTokenFile() {
    const target = this.config.token_file && fs.existsSync(this.config.token_file)
      ? this.config.token_file : this.tokenPath;
    if (!target || !fs.existsSync(target)) return;
    const mtime = fs.statSync(target).mtimeMs;
    if (mtime <= this.lastTokenMtime) return;
    this.log.info('Auth', '检测到 token 文件更新，正在重新解密…');
    try {
      if (target === this.config.token_file) {
        const raw = fs.readFileSync(target, 'utf8').trim().split(/\r?\n/)[0].trim();
        this.lastTokenMtime = mtime;
        this.acceptJwt(raw, 'jwt-file');
      } else {
        const key = await this.getOsCryptKey();
        const jwt = this.decryptTokenFile(target, key);
        this.acceptJwt(jwt, 'client-token.json(续期)');
      }
    } catch (e) {
      this.log.error('Auth', `续期解密失败: ${e.message}`);
    }
  }
}

module.exports = Auth;
