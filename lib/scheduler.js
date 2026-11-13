// 调度模块：每日积分领取（Windows 用 UIA 客户端自动化，已验证通道）+ 补跑
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

class Scheduler {
  constructor({ config, log, api, ka, power, notifier }) {
    this.config = config;
    this.log = log;
    this.api = api;
    this.ka = ka;
    this.power = power;
    this.notifier = notifier || { event: async () => {} };
    this.state = loadState(path.join(config._file, '..', 'state.json'));
    this.timer = null;
    this.running = false;
    this.lastResult = this.state.last_result || null;
    this.nextAt = null;
  }

  status() {
    return {
      claim_time: this.config.points.claim_time,
      poll_minutes: this.config.points.poll_minutes || 10,
      next_claim_at: this.nextAt ? new Date(this.nextAt).toISOString() : null,
      next_claim_text: this.nextAt ? new Date(this.nextAt).toLocaleString('zh-CN') : null,
      last_result: this.lastResult,
      last_claim_date: this.state.last_claim_date || null,
      claiming: this.running,
      catchup_on_start: !!this.config.points.catchup_on_start,
    };
  }

  start() {
    this.scheduleNext();
    // 认证活动轮询：每 poll_minutes 分钟带 JWT 查一次积分（确定的账号活动信号，兼作保活心跳）
    const pm = Math.max(2, parseInt(this.config.points.poll_minutes || '10', 10));
    this.pollTimer = setInterval(() => {
      this.api.refreshPoints().catch(() => {});
    }, pm * 60 * 1000);
    this.pollTimer.unref && this.pollTimer.unref();
    if (this.config.points.catchup_on_start && this.state.last_claim_date !== today()) {
      this.log.info('Scheduler', `启动补跑：今日（${today()}）尚未领取，3 秒后执行`);
      setTimeout(() => this.triggerClaim('catchup'), 3000);
    } else {
      this.log.info('Scheduler', `今日已领取过（${this.state.last_claim_date}），等待下一周期`);
    }
  }

  reschedule() {
    clearTimeout(this.timer);
    this.scheduleNext();
    this.log.info('Scheduler', `计划已更新：每日 ${this.config.points.claim_time} 领取`);
  }

  scheduleNext() {
    const [h, m] = String(this.config.points.claim_time || '08:05').split(':').map((x) => parseInt(x, 10));
    const now = new Date();
    const next = new Date(now);
    next.setHours(h || 8, m || 5, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    this.nextAt = next.getTime();
    const wait = this.nextAt - Date.now();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.triggerClaim('scheduled'), wait);
    this.timer.unref && this.timer.unref();
    this.log.info('Scheduler', `下一次领取：${next.toLocaleString('zh-CN')}`);
  }

  async triggerClaim(source) {
    if (this.running) return { ok: false, error: '领取任务执行中' };
    if (process.platform !== 'win32') {
      const msg = '当前平台无客户端 UIA 通道（Docker/Linux 部署时请在源机领取或手动领取）';
      this.log.warn('Claim', msg);
      return { ok: false, error: msg };
    }
    this.running = true;
    this.log.info('Claim', `开始领取（触发：${source}）`);
    try {
      const r = await this.runClaimScript();
      this.lastResult = { ...r, source, at: new Date().toISOString() };
      this.state.last_result = this.lastResult;
      if (r.status === 'claimed' || r.status === 'already_claimed') {
        this.state.last_claim_date = today();
      }
      saveState(path.join(this.config._file, '..', 'state.json'), this.state);
      this.log.info('Claim', `结果：${r.status}${r.balance ? '，余额 ' + r.balance : ''}`);
      if (r.status === 'claimed' && this.notifier) {
        this.notifier.event('claim', '积分已领取', `今日 +100 积分\n余额：${r.balance || '未知'}\n时间：${new Date().toLocaleString('zh-CN')}`, 60);
      }
      // 领取后刷新积分状态
      setTimeout(() => this.api.refreshPoints().catch(() => {}), 3000);
      return { ok: true, ...r };
    } catch (e) {
      this.log.error('Claim', `异常: ${e.message}`);
      if (this.notifier) {
        this.notifier.event('claim-fail', '积分领取异常', `原因：${e.message}`, 60);
      }
      return { ok: false, error: e.message };
    } finally {
      this.running = false;
      if (source !== 'manual') this.scheduleNext();
    }
  }

  runClaimScript() {
    const script = path.join(__dirname, '..', 'scripts', 'claim_points.py');
    const py = process.env.TA_PYTHON || findPython();
    return new Promise((resolve, reject) => {
      const p = spawn(py, [script], { windowsHide: true, cwd: path.dirname(script) });
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (out += c));
      p.on('error', reject);
      p.on('close', () => {
        // 取最后一行 RESULT: {...}
        const lines = out.trim().split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = lines[i].match(/RESULT:\s*(\{.*\})\s*$/);
          if (m) {
            try { return resolve(JSON.parse(m[1])); } catch {}
          }
        }
        reject(new Error(`脚本无结果输出（${out.slice(-160).replace(/\s+/g, ' ')}）`));
      });
    });
  }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function loadState(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; }
}
function saveState(fp, s) {
  try { fs.writeFileSync(fp, JSON.stringify(s, null, 2)); } catch {}
}
function findPython() {
  const cands = [
    'D:/TeleAgent/data/runtimes/python/python.exe',
    process.env.TA_PYTHON, 'python', 'python3',
  ].filter(Boolean);
  return cands[0] || 'python';
}

module.exports = Scheduler;
