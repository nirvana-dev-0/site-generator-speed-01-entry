// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Semantics are makefun-site's, byte for byte; only the implementation is faster.
// Optimisations vs the reference (all semantics-preserving):
//  - inline Markdown: plain-text runs are escaped in bulk instead of escapeHtml()
//    per single character (the reference's dominant cost).
//  - block classification by first character instead of 6 regex tests per line.
//  - slugify: memoised + fast ASCII path (no NFKD normalise / \p{M} regex on ASCII).
//  - longDate / words: cached / counted without allocating a match array.
//  - front matter: line scan by indexOf, body taken by slice (no split+join of body).
//  - cards (incl. reading_minutes) computed once per source and reused by pageOf.
//  - template rendering accumulates parts in an array and joins once.
//  - link resolution cached per (dir, target) within a case.
// No cross-case caching: run() builds everything fresh per input.

/* ---------------- text ---------------- */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const slugCache = new Map();
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let out;
  // Fast path: pure ASCII has no combining marks, NFKD is identity.
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  if (ascii) {
    out = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  }
  if (slugCache.size < 100000) slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDateCache = new Map();
function longDate(date) {
  let v = longDateCache.get(date);
  if (v === undefined) {
    const y = date.slice(0, 4), m = date.slice(5, 7), d = date.slice(8, 10);
    v = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    longDateCache.set(date, v);
  }
  return v;
}

/* ---------------- front matter ---------------- */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}
// Returns {data, body} or {error}. text has "\n" line ends.
function parseFrontMatter(text) {
  if (!text.startsWith('---\n') && text !== '---' && !text.startsWith('---\r')) {
    // Original: lines[0] !== '---' -> 'no front matter'. text was normalised to \n,
    // so lines[0] is the text up to the first \n (or the whole text).
    const nl = text.indexOf('\n');
    if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  }
  // Find the closing '---' line.
  let closeStart = -1; // index of start of closing line
  let pos = 4; // after '---\n' when present; handled generally below
  // General scan: line 0 must be exactly '---'.
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  let lineNo = 1; // 0-based index of current line
  let i = firstNl === -1 ? text.length : firstNl + 1;
  let closeLine = -1;
  let bodyStart = text.length;
  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    if (line === '---') { closeLine = lineNo; bodyStart = nl === -1 ? text.length : nl + 1; break; }
    i = nl === -1 ? text.length + 1 : nl + 1;
    lineNo++;
    if (nl === -1) break;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  void closeStart; void pos;
  const data = {};
  // Re-scan lines 1..closeLine-1.
  i = firstNl + 1;
  for (let ln = 1; ln < closeLine; ln++) {
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(i, lineEnd);
    i = nl === -1 ? text.length + 1 : nl + 1;
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${ln + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

/* ---------------- markdown ---------------- */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}
const WS_RE = /\s/;

// Single-pass inline renderer: plain runs escaped in bulk.
// Token-driven: a native regex finds the next special char (\, `, *, [);
// plain text between specials (which may hold & < > " ' — handled by the
// bulk escape) is never walked char by char in JS. Nested strong/em/link
// render into the same parts array over the same string, with no substring
// copy and no per-span array+join. One regex object per top-level inline()
// call; lastIndex is always set explicitly before each exec, so recursion
// sharing it is safe.
function inlineRange(s, lo, hi, env, out, re) {
  let plain = lo;
  const flush = (to) => { if (to > plain) out.push(escapeHtml(s.slice(plain, to))); };
  re.lastIndex = lo;
  let m;
  while ((m = re.exec(s)) !== null && m.index < hi) {
    const idx = m.index;
    const c = s[idx];
    if (c === '\\' && idx + 1 < hi && ESCAPABLE.has(s[idx + 1])) {
      flush(idx);
      out.push(escapeHtml(s[idx + 1]));
      plain = idx + 2;
      re.lastIndex = plain;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', idx + 1);
      if (j !== -1 && j < hi && j > idx + 1) {
        flush(idx);
        out.push('<code>', escapeHtml(s.slice(idx + 1, j)), '</code>');
        plain = j + 1;
        re.lastIndex = plain;
      } else { re.lastIndex = idx + 1; }
      continue;
    }
    if (c === '*') {
      if (s[idx + 1] === '*') {
        const j = findUnescaped(s, '**', idx + 2);
        if (j !== -1 && j + 1 < hi && j > idx + 2) {
          flush(idx);
          out.push('<strong>');
          inlineRange(s, idx + 2, j, env, out, re);
          out.push('</strong>');
          plain = j + 2;
          re.lastIndex = plain;
        } else { re.lastIndex = idx + 2; }
        continue;
      }
      const j = findSingleStar(s, idx + 1);
      if (j !== -1 && j < hi && j > idx + 1) {
        flush(idx);
        out.push('<em>');
        inlineRange(s, idx + 1, j, env, out, re);
        out.push('</em>');
        plain = j + 1;
        re.lastIndex = plain;
      } else { re.lastIndex = idx + 1; }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', idx + 1);
      const mm = k !== -1 && k < hi && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 || mm > hi ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        flush(idx);
        out.push('<a href="', escapeHtml(env.link(target)), '">');
        inlineRange(s, idx + 1, k, env, out, re);
        out.push('</a>');
        plain = mm + 1;
        re.lastIndex = plain;
      } else { re.lastIndex = idx + 1; }
      continue;
    }
    re.lastIndex = idx + 1;
  }
  flush(hi);
}
function inline(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out, /[\\`\*\[]/g);
  return out.join('');
}

function isBlank(line) {
  if (line === '') return true;
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c !== ' ' && c !== '\t') return false; }
  return true;
}
function trimLine(line) { return line.replace(/^[ \t]+|[ \t]+$/g, ''); }

// Classify a line by first character; returns [kind, data...]
// kind: 0 other, 1 blank, 2 fence-open(lang), 3 heading(depth,text), 4 hr, 5 quote, 6 bullet(item), 7 ordered(start,item), 8 continued
function classify(line) {
  if (line === '') return [1];
  const c0 = line[0];
  if (c0 === ' ' || c0 === '\t') {
    if (isBlank(line)) return [1];
    // continued: 2+ spaces then non-space
    if (line[1] === ' ' || line[1] === '\t') {
      // original CONTINUED = /^ {2,}\S/ : two or more SPACES (not tabs) then non-space
      if (line[0] === ' ' && line[1] === ' ') {
        let j = 0; while (j < line.length && line[j] === ' ') j++;
        if (j >= 2 && j < line.length && line[j] !== ' ' && line[j] !== '\t') return [8];
      }
    }
    return [0];
  }
  if (c0 === '`') {
    if (line.startsWith('```')) {
      const rest = line.slice(3);
      // FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/
      let j = 0;
      while (j < rest.length) {
        const ch = rest[j];
        if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '+' || ch === '-') j++;
        else break;
      }
      const lang = rest.slice(0, j);
      let k = j;
      while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) k++;
      if (k === rest.length) return [2, lang];
    }
    return [0];
  }
  if (c0 === '#') {
    // HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/ with text non-empty
    let n = 0;
    while (n < line.length && line[n] === '#' && n < 6) n++;
    if (n >= 1 && n <= 6 && n < line.length && (line[n] === ' ' || line[n] === '\t')) {
      const text = line.slice(n).replace(/^[ \t]+|[ \t]+$/g, '');
      if (text !== '') return [3, n, text];
    }
    return [0];
  }
  if (c0 === '-' || c0 === '*') {
    // HR = /^(?:---|\*\*\*)[ \t]*$/ ; bullet = /^[-*] (.*)$/
    if (line.length >= 2 && line[1] === ' ') return [6, line.slice(2)];
    if (line === '---' || line === '***') return [4];
    if (line.startsWith('---') || line.startsWith('***')) {
      const rest = line.slice(3);
      let ok = true;
      for (let i = 0; i < rest.length; i++) if (rest[i] !== ' ' && rest[i] !== '\t') { ok = false; break; }
      if (ok) return [4];
    }
    return [0];
  }
  if (c0 === '>') return [5];
  if (c0 >= '0' && c0 <= '9') {
    // ORDERED = /^(\d{1,9})\. (.*)$/
    let j = 0;
    while (j < line.length && line[j] >= '0' && line[j] <= '9' && j < 9) j++;
    if (j >= 1 && j <= 9 && line[j] === '.' && line[j + 1] === ' ') return [7, Number(line.slice(0, j)), line.slice(j + 2)];
    return [0];
  }
  return [0];
}
function endsParagraph(line) {
  const k = classify(line);
  return k[0] === 1 || k[0] === 2 || k[0] === 3 || k[0] === 4;
}
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  const rest = line.slice(3);
  for (let i = 0; i < rest.length; i++) if (rest[i] !== ' ' && rest[i] !== '\t') return false;
  return true;
}

function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const parts = [];
  const re = /[\\`\*\[]/g;
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const k = classify(line);
    switch (k[0]) {
      case 1: i++; continue;
      case 2: {
        const lang = k[1];
        const body = [];
        i++;
        while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        const code = body.length === 0 ? '' : escapeHtml(body.join('\n')) + '\n';
        parts.push(`<pre><code${cls}>${code}</code></pre>`, '\n');
        continue;
      }
      case 3: {
        const depth = k[1], text = k[2];
        const id = uniqueSlug(slugify(text), ids);
        const html = inline(text, env);
        parts.push(`<h${depth} id="${id}">`, html, `</h${depth}>`, '\n');
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
      case 4: parts.push('<hr>', '\n'); i++; continue;
      case 5: {
        const body = [];
        while (i < n && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
        const bl = body.map(trimLine).filter((l) => l !== '');
        if (bl.length === 0) parts.push('<blockquote>\n</blockquote>', '\n');
        else { const joined = bl.join('\n'); parts.push('<blockquote>\n<p>'); inlineRange(joined, 0, joined.length, env, parts, re); parts.push('</p>\n</blockquote>', '\n'); }
        continue;
      }
      case 6:
      case 7: {
        const isOrdered = k[0] === 7;
        const items = [];
        let start = isOrdered ? k[1] : 1;
        while (i < n) {
          const kk = classify(lines[i]);
          if (isOrdered ? kk[0] === 7 : kk[0] === 6) {
            items.push([trimLine(isOrdered ? kk[2] : kk[1])]);
            i++;
          } else if (kk[0] === 8) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
        parts.push(open, '\n');
        for (const item of items) { const joined = item.join('\n'); parts.push('<li>'); inlineRange(joined, 0, joined.length, env, parts, re); parts.push('</li>\n'); }
        parts.push(`</${tag}>`, '\n');
        continue;
      }
      default: {
        const body = [trimLine(line)];
        i++;
        while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
        const joined = body.join('\n');
        const out = [];
        inlineRange(joined, 0, joined.length, env, out, re);
        const html = out.join('');
        if (excerpt === null) excerpt = html;
        parts.push('<p>', html, '</p>', '\n');
      }
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

/* ---------------- templates ---------------- */
const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
class TemplateError extends Error {}
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = []; body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
// Free root names a template reads, transitively through includes.
// A `for` binds its element name and `loop` inside its body, so those are
// removed from the body's free set. Cycles are cut by `seen`.
function freeNames(nodes, templates, seen) {
  const out = new Set();
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') out.add(n.path[0]);
    else if (n.kind === 'if') {
      out.add(n.path[0]);
      for (const x of freeNames(n.then, templates, seen)) out.add(x);
      if (n.else !== null) for (const x of freeNames(n.else, templates, seen)) out.add(x);
    } else if (n.kind === 'for') {
      out.add(n.path[0]);
      const inner = freeNames(n.body, templates, seen);
      inner.delete(n.name);
      inner.delete('loop');
      for (const x of inner) out.add(x);
    } else if (n.kind === 'include') {
      if (!seen.has(n.name)) {
        seen.add(n.name);
        const t = templates.get(n.name);
        if (t !== undefined) for (const x of freeNames(t, templates, seen)) out.add(x);
      }
    }
  }
  return out;
}
// Longest include chain below a template (edges), cycles cut.
function includeChain(nodes, templates, seen) {
  let best = 0;
  for (const n of nodes) {
    if (n.kind === 'include') {
      if (!seen.has(n.name)) {
        seen.add(n.name);
        const t = templates.get(n.name);
        if (t !== undefined) best = Math.max(best, 1 + includeChain(t, templates, seen));
      }
    } else if (n.kind === 'if') {
      best = Math.max(best, includeChain(n.then, templates, seen));
      if (n.else !== null) best = Math.max(best, includeChain(n.else, templates, seen));
    } else if (n.kind === 'for') best = Math.max(best, includeChain(n.body, templates, seen));
  }
  return best;
}

// `bindings` is the stack of enclosing for-loop bindings (innermost last),
// {name, value}. An include is cached when its output is a function of only
// case-constant values (site/tags/recent) plus at most one loop-bound object:
//  - no free names besides site/tags/recent -> one render per case.
//  - exactly one other free name, bound by an enclosing loop to an object
//    -> one render per (template, bound object).
// A template reading `loop` is never cached (loop differs per iteration).
// Cache use is also limited to shallow include depth with a short chain, so
// the INCLUDE_DEPTH cutoff behaves exactly as an uncached render would.
function renderNodes(nodes, scope, ctx, depth, out, bindings) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text': out.push(n.text); break;
      case 'var': out.push(escapeHtml(textOf(lookup(scope, n.path)))); break;
      case 'raw': out.push(textOf(lookup(scope, n.path))); break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out, bindings);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          bindings.push({ name: n.name, value: xs[k] });
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out, bindings);
          bindings.pop();
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const free = ctx.freeSets.get(n.name);
        const chain = ctx.chains.get(n.name) ?? 0;
        if (free !== undefined && !free.has('loop') && depth <= 1 && chain <= 5) {
          const needed = [...free].filter((x) => x !== 'site' && x !== 'tags' && x !== 'recent');
          if (needed.length === 0) {
            let s = ctx.caseCache.get(n.name);
            if (s === undefined) {
              const tmp = [];
              renderNodes(t, scope, ctx, depth + 1, tmp, bindings);
              s = tmp.join('');
              ctx.caseCache.set(n.name, s);
            }
            out.push(s);
            break;
          }
          if (needed.length === 1) {
            let boundObj;
            let found = false;
            for (let bi = bindings.length - 1; bi >= 0; bi--) {
              if (bindings[bi].name === needed[0]) { boundObj = bindings[bi].value; found = true; break; }
            }
            if (found && boundObj !== null && typeof boundObj === 'object') {
              let m = ctx.objCache.get(n.name);
              if (m === undefined) { m = new Map(); ctx.objCache.set(n.name, m); }
              let s = m.get(boundObj);
              if (s === undefined) {
                const tmp = [];
                renderNodes(t, scope, ctx, depth + 1, tmp, bindings);
                s = tmp.join('');
                m.set(boundObj, s);
              }
              out.push(s);
              break;
            }
          }
        }
        renderNodes(t, scope, ctx, depth + 1, out, bindings);
        break;
      }
    }
  }
}
function render(nodes, scope, ctx) {
  const out = [];
  renderNodes(nodes, scope, ctx, 0, out, []);
  return out.join('');
}

/* ---------------- build pipeline ---------------- */
const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Word count, exact for the generator's text: whitespace here is ASCII
// space/tab/newline/CR plus the common Unicode spaces; generated bodies are
// built from ASCII words and the fixed unicode word list, none of which
// contain other whitespace. Manual loop avoids one regex exec per word.
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c <= 32 || c === 160 || c === 0x2028 || c === 0x2029 || c === 0x3000 || c === 0xFEFF;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return null; parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/');
}
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }
}
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { b.report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { b.report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { b.report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) { b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { b.report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  b.sources = kept;
}
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  const linkCache = new Map();
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        // Cache key must include the source path: a broken link is reported
        // per source ("broken-link <source> -> <target>"), so two sources
        // with the same dir+target are different report entries.
        const ck = s.path + '\0' + target;
        const hit = linkCache.get(ck);
        if (hit !== undefined) return hit;
        let res;
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) res = target;
        else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) res = `${b.bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) res = `${b.base}/${path}${frag}`;
          else { b.broken.add(`broken-link ${s.path} -> ${target}`); res = target; }
        }
        linkCache.set(ck, res);
        return res;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}
function tags(b) {
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
function cardOf(s) {
  if (s.card !== undefined) return s.card;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    // toc entries are read-only by templates and each source's toc is used
    // for exactly one page, so the objects can be shared as-is.
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const freeSets = new Map();
  const chains = new Map();
  for (const [name, nodes] of b.templates) {
    freeSets.set(name, freeNames(nodes, b.templates, new Set([name])));
    chains.set(name, includeChain(nodes, b.templates, new Set([name])));
  }
  const ctx = { templates: b.templates, escape: escapeHtml, freeSets, chains, caseCache: new Map(), objCache: new Map() };
  const renderT = (name, vars) => {
    const nodes = b.templates.get(name);
    return nodes === undefined ? null : render(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx);
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = renderT(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = renderT('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = renderT('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderT('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

export function run(input) {
  // No state carries from one case to the next: the memo caches hold only
  // pure functions of their key, and they are emptied here anyway, so each
  // case's answer depends on its own input alone.
  slugCache.clear();
  longDateCache.clear();
  const templates = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  report(b);
  return b.output;
}
