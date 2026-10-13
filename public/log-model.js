export const ROW_HEIGHT = 26;
const encoder = new TextEncoder();
export class LogBuffer {
  constructor(maxLines = 20000, maxBytes = 4 * 1024 * 1024) {
    this.maxLines = maxLines; this.maxBytes = maxBytes; this.rows = new Array(maxLines); this.reset();
  }
  reset() { this.rows.fill(undefined); this.start = 0; this.size = 0; this.bytes = 0; this.next = 1; this.dropped = 0; }
  append(lines) {
    for (const text of lines) {
      const bytes = encoder.encode(text).byteLength;
      if (bytes > this.maxBytes) { this.dropped++; continue; }
      while (this.size && (this.size >= this.maxLines || this.bytes + bytes > this.maxBytes)) {
        this.bytes -= this.rows[this.start].bytes; this.rows[this.start] = undefined;
        this.start = (this.start + 1) % this.maxLines; this.size--; this.dropped++;
      }
      const level = /\b(ERROR|FATAL|SEVERE)\b|"level"\s*:\s*"(error|fatal)"/i.test(text) ? 'error' : /\bWARN(?:ING)?\b|"level"\s*:\s*"warn"/i.test(text) ? 'warn' : /\bDEBUG\b|"level"\s*:\s*"debug"/i.test(text) ? 'debug' : 'info';
      this.rows[(this.start + this.size) % this.maxLines] = { number: this.next++, text, lower: text.toLowerCase(), level, bytes };
      this.size++; this.bytes += bytes;
    }
  }
  at(index) { return this.rows[(this.start + index) % this.maxLines]; }
  filter(query = '', level = 'all') {
    const result = [], search = query.toLowerCase();
    for (let i = 0; i < this.size; i++) { const row = this.at(i); if ((level === 'all' || level === row.level) && (!search || row.lower.includes(search))) result.push(i); }
    return result;
  }
}
export function visibleRange(scrollTop, viewportHeight, count, overscan = 8) {
  const start = Math.max(0, Math.min(count, Math.floor(scrollTop / ROW_HEIGHT)) - overscan);
  return { start, end: Math.min(count, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + overscan) };
}
