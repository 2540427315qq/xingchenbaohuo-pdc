// 电源模块：重启（本地模式 + 倒计时/取消）、重装（官方页直达，任意部署模式均可用）
// 部署模式门禁：mode=local（工具跑在云电脑本机，shutdown 重启的就是云电脑）
//              mode=remote（Docker/NAS/VPS 等异地部署，shutdown 会作用于部署机，必须拒绝）
'use strict';

const { exec, spawn } = require('child_process');

class Power {
  constructor(config, log, notifier) {
    this.config = config;
    this.log = log;
    this.notifier = notifier || { event: async () => {} };
    this.pending = null; // { at, delay, command }
    this.mode = (config.power && config.power.mode) || process.env.TA_MODE || 'local';
    // 定时重启计划（每日/每周；仅 local 模式生效）
    this.plan = Power.normalizePlan(config.power && config.power.restart_plan);
    this.busyCheck = null;   // () => boolean，外部注入（如积分领取进行中则延后）
    this.lastPlanDay = '';   // 当日已触发标记（防重复）
    if (this.mode !== 'local') {
      this.log.info('Power', `部署模式 remote：重启功能已禁用（避免 shutdown 作用于部署机而非云电脑）`);
    }
    this.planTimer = setInterval(() => this.planTick(), 30 * 1000);
    this.planTimer.unref && this.planTimer.unref();
  }

  static normalizePlan(p) {
    if (!p || typeof p !== 'object') return { enabled: false, mode: 'daily', time: '04:30', weekday: 0 };
    const wd = Number(p.weekday);
    return {
      enabled: !!p.enabled,
      mode: p.mode === 'weekly' ? 'weekly' : 'daily',
      time: /^\d{2}:\d{2}$/.test(String(p.time)) ? String(p.time) : '04:30',
      weekday: Number.isInteger(wd) && wd >= 0 && wd <= 6 ? wd : 0,
    };
  }

  setBusyCheck(fn) { this.busyCheck = fn; }

  applyPlan(p) {
    this.plan = Power.normalizePlan(p);
    this.log.info('Power', `重启计划已更新：${this.planText()}`);
  }

  planText() {
    if (this.mode !== 'local') return '远程模式不可用';
    if (!this.plan.enabled) return '无';
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][this.plan.weekday];
    return this.plan.mode === 'weekly' ? `每周${wd} ${this.plan.time}` : `每日 ${this.plan.time}`;
  }

  // 定时计划检查（每 30 秒）：命中时间点且无冲突 → 30 秒缓冲重启
  planTick() {
    const p = this.plan;
    if (!p.enabled || this.mode !== 'local') return;
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hm !== p.time) return;
    if (p.mode === 'weekly' && now.getDay() !== p.weekday) return;
    const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (this.lastPlanDay === dayKey) return;
    if (this.pending) { this.log.warn('Power', '定时重启：已有待执行重启，本轮跳过'); return; }
    if (this.busyCheck && this.busyCheck()) {
      this.log.warn('Power', '定时重启：有任务进行中（如积分领取），本轮跳过');
      return;
    }
    this.lastPlanDay = dayKey;
    this.log.warn('Power', `⏰ 定时重启触发：${this.planText()}`);
    this.notifier.event('restart-plan', '定时重启执行', `计划：${this.planText()}\n时间：${now.toLocaleString('zh-CN')}\n30 秒后重启，重启后服务自动恢复。`, 60);
    this.scheduleRestart(30);
  }

  status() {
    return {
      mode: this.mode,
      restart_available: this.mode === 'local',
      pending_restart: this.pending,
      pending_restart_text: this.pending
        ? `${new Date(this.pending.at).toLocaleTimeString('zh-CN')} 触发（剩余 ${Math.max(0, Math.round((this.pending.at - Date.now()) / 1000))} 秒）`
        : null,
      restart_plan: this.plan,
      restart_plan_text: this.planText(),
    };
  }

  // 重启：仅本地模式允许（shutdown 作用于本机 = 云电脑本身）
  scheduleRestart(delaySec = 60) {
    if (this.mode !== 'local') {
      this.log.warn('Power', '已拒绝重启指令：远程部署模式下 shutdown 将作用于部署机而非云电脑');
      return {
        ok: false,
        error: '远程部署模式不支持重启云电脑：shutdown 只能作用于部署机。请在云电脑本机运行本工具（local 模式），或通过 TeleAgent 客户端 / 官方安全中心操作。',
      };
    }
    if (this.pending) return { ok: false, error: '已有待执行的重启（先取消再试）' };
    const at = Date.now() + delaySec * 1000;
    const cmd = process.platform === 'win32'
      ? `shutdown /r /t ${delaySec} /c "teleagent-dashboard 例行重启"`
      : `shutdown -r +${Math.max(1, Math.floor(delaySec / 60))}`;
    exec(cmd, { windowsHide: true }, (err) => {
      if (err) { this.log.error('Power', `重启指令失败: ${err.message}`); return; }
    });
    this.pending = { at, delay: delaySec, command: cmd };
    this.log.warn('Power', `⚡ 已下发重启指令：${delaySec} 秒后执行（可取消）`);
    return { ok: true, at, delay: delaySec, cancellable: true };
  }

  cancelRestart() {
    if (!this.pending) return { ok: false, error: '当前没有待执行的重启' };
    const cmd = process.platform === 'win32' ? 'shutdown /a' : 'shutdown -c';
    exec(cmd, { windowsHide: true }, () => {});
    this.log.info('Power', '已取消待执行的重启');
    const was = this.pending;
    this.pending = null;
    return { ok: true, cancelled: was };
  }

  // 重装：302 跳转到官方安全中心（在访问者的浏览器打开，与部署位置无关）。
  // 本地模式额外自动弹出浏览器（云电脑屏幕上的浏览器）作为便利。
  openReinstallInBrowser() {
    const url = this.config.reinstall_url;
    if (this.mode !== 'local') {
      this.log.info('Power', '远程模式：仅提供官方安全中心跳转链接（重装由访问者浏览器打开官方页确认）');
      return;
    }
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    this.log.info('Power', '已打开官方安全中心页面（重装入口）');
  }
}

module.exports = Power;
