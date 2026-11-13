// 日志模块：内存环形 + 落盘 JSONL
'use strict';

const fs = require('fs');
const path = require('path');

// 本地时间戳（勿用 toISOString —— 那是 UTC，会和实际时间差时区）
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function todayStamp() { return stamp().slice(0, 10); }

class Log {
  constructor(dataDir) {
    this.dir = dataDir;
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    this.file = path.join(dataDir, 'logs', `dashboard-${todayStamp()}.jsonl`);
    this.ring = [];
    this.seq = 0;
  }

  _push(source, message, level) {
    const e = {
      id: ++this.seq,
      timestamp: stamp(),
      source, message, level,
    };
    this.ring.push(e);
    if (this.ring.length > 500) this.ring.splice(0, this.ring.length - 500);
    try {
      fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    } catch {}
    return e;
  }

  info(source, message) { return this._push(source, message, 'info'); }
  warn(source, message) { return this._push(source, message, 'warning'); }
  error(source, message) { return this._push(source, message, 'error'); }
  debug(source, message) { return this._push(source, message, 'debug'); }

  tail(n = 200) { return this.ring.slice(-n).reverse(); }
}

module.exports = Log;
