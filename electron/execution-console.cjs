const fs = require('node:fs');
const path = require('node:path');

// Keep useful tool inputs and results, while excluding credentials and media
// payloads. The console is a bounded execution record, not a reasoning dump.
function safeDetail(value, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/^[\[{]/.test(value.trim())) {
      try { return safeDetail(JSON.parse(value), depth + 1); } catch { /* Plain diagnostic text. */ }
    }
    return value.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
      .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)["']?\s*[=:]\s*["']?)[^\s,;"']+/gi, '$1[已隐藏]')
      .slice(0, 6000);
  }
  if (depth > 5) return '[内容已折叠]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => safeDetail(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 500);
  return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [key,
    /^(api_key|token|access_token|refresh_token|authorization|headers|password|secret|credentials)$/i.test(key)
      ? '[已隐藏]' : /^(data|image_base64|reasoning_content|think|thinking_content)$/i.test(key)
        ? '[内容已省略]' : safeDetail(item, depth + 1)]));
}

class ExecutionConsole {
  constructor(data, emit, limit = 1200) {
    this.file = path.join(data, 'execution-console.jsonl');
    this.emit = emit;
    this.limit = limit;
    this.entries = [];
    this.sequence = 0;
    try {
      this.entries = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-limit)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { /* First launch. */ }
  }
  add(raw) {
    const entry = safeDetail({ ...raw, id: `kimi-${Date.now()}-${++this.sequence}`, timestamp: new Date().toISOString(), source: 'kimi' });
    this.entries.push(entry);
    this.entries = this.entries.slice(-this.limit);
    try {
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
      if (fs.statSync(this.file).size > 2 * 1024 * 1024)
        fs.writeFileSync(this.file, this.entries.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
    } catch { /* A log failure must not abort generation. */ }
    this.emit?.({ type: 'entry', entry });
    return entry;
  }
  state() { return this.entries; }
  clear() {
    this.entries = [];
    try { fs.writeFileSync(this.file, '', 'utf8'); } catch { /* Keep UI usable. */ }
    this.emit?.({ type: 'reset' });
    return { cleared: true };
  }
}
module.exports = { ExecutionConsole, safeDetail };
