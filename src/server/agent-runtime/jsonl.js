// Line-delimited JSON reader for CLI event streams.
//
// Agent CLIs stream stdout in arbitrary chunks: a UTF-8 character, a JSON
// object, or a whole burst can be split anywhere. The parser must never lose or
// invent events, must survive garbage lines (progress spinners, warnings), and
// must bound memory when a child writes a runaway line without newlines.
import { StringDecoder } from 'node:string_decoder';

export const MAX_JSONL_LINE_BYTES = 4 * 1024 * 1024;
const SKIPPED_KEEP = 20;
const SKIPPED_LINE_CHARS = 500;

export class JsonlParser {
  constructor({ maxLineBytes = MAX_JSONL_LINE_BYTES } = {}) {
    this.#decoder = new StringDecoder('utf8');
    this.#buffer = '';
    this.maxLineBytes = maxLineBytes;
    this.parseFailures = 0;
    /** Most recent unparsable lines, bounded, for diagnostics only. */
    this.skipped = [];
  }

  #decoder;
  #buffer;

  #skip(raw, reason) {
    this.parseFailures += 1;
    this.skipped.push({ reason, raw: raw.slice(0, SKIPPED_LINE_CHARS) });
    if (this.skipped.length > SKIPPED_KEEP) this.skipped.shift();
  }

  /** Feed one chunk; returns every complete JSON value parsed from it. */
  push(chunk) {
    this.#buffer += this.#decoder.write(chunk);
    const out = [];
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this.#skip(line, 'oversized');
        continue;
      }
      try {
        out.push(JSON.parse(line));
      } catch {
        this.#skip(line, 'not-json');
      }
    }
    if (Buffer.byteLength(this.#buffer, 'utf8') > this.maxLineBytes) {
      // Runaway line without a newline: drop it instead of growing forever.
      this.#skip(this.#buffer, 'oversized-tail');
      this.#buffer = '';
    }
    return out;
  }

  /** Flush after stream end. Some CLIs omit the final newline. */
  end() {
    const tail = (this.#buffer + this.#decoder.end()).replace(/\r$/, '');
    this.#buffer = '';
    if (!tail.trim()) return [];
    try {
      return [JSON.parse(tail)];
    } catch {
      this.#skip(tail, 'not-json');
      return [];
    }
  }
}
