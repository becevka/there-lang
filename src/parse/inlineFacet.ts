export interface InlineResource {
  name: string;
  body: string;
  paramNames: string[];
}

export interface RawPhrase {
  pattern: string;
  replacement: string;
}

export interface InlineFacet {
  aliases: Record<string, string>;
  phrases: RawPhrase[];
  resources: InlineResource[];
  globals: InlineResource[];
}

export function emptyInlineFacet(): InlineFacet {
  return { aliases: {}, phrases: [], resources: [], globals: [] };
}

export function extractInlineFacet(source: string): { stripped: string; inline: InlineFacet } {
  const inline = emptyInlineFacet();
  const fence = '```facet';
  const end = '```';
  let stripped = source;

  while (true) {
    const start = stripped.indexOf(fence);
    if (start < 0) break;
    const after = start + fence.length;
    const close = stripped.indexOf(end, after);
    if (close < 0) throw new Error('Unclosed ```facet block');
    const body = stripped.slice(after, close);
    parseFacetBody(body, inline);
    stripped = stripped.slice(0, start) + stripped.slice(close + end.length);
  }

  return { stripped, inline };
}

function parseFacetBody(body: string, inline: InlineFacet): void {
  let i = 0;
  const n = body.length;

  const skipWs = () => {
    while (i < n) {
      const ch = body[i]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        i += 1;
      } else if (ch === '#') {
        while (i < n && body[i] !== '\n') i += 1;
      } else {
        break;
      }
    }
  };

  while (true) {
    skipWs();
    if (i >= n) break;

    let key = '';
    while (i < n && /[A-Za-z_]/.test(body[i]!)) {
      key += body[i]!;
      i += 1;
    }
    if (!key) { i += 1; continue; }
    skipWs();
    if (body[i] !== '=') throw new Error(`Expected = after ${key}`);
    i += 1;
    skipWs();
    if (body[i] !== '{') throw new Error(`Expected { after ${key} =`);

    const blockBody = readBalanced(body, i, '{', '}');
    i = blockBody.endIndex;

    if (key === 'resources') parseResources(blockBody.text, inline.resources);
    else if (key === 'globals') parseResources(blockBody.text, inline.globals);
    else if (key === 'aliases') parseStringPairs(blockBody.text, (k, v) => { inline.aliases[k] = v; });
    else if (key === 'phrases') parseStringPairs(blockBody.text, (k, v) => { inline.phrases.push({ pattern: k, replacement: v }); });
    else throw new Error(`Unknown facet key: ${key}`);
  }
}

function readBalanced(src: string, start: number, open: string, close: string): { text: string; endIndex: number } {
  if (src[start] !== open) throw new Error(`Expected ${open}`);
  let depth = 0;
  let i = start;
  let inString: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      i += 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { text: src.slice(start + 1, i), endIndex: i + 1 };
    }
    i += 1;
  }
  throw new Error(`Unclosed ${open}...${close}`);
}

function parseResources(body: string, out: InlineResource[]): void {
  let i = 0;
  const n = body.length;
  const skipWs = () => {
    while (i < n) {
      const ch = body[i]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') i += 1;
      else if (ch === '#') { while (i < n && body[i] !== '\n') i += 1; }
      else break;
    }
  };

  while (true) {
    skipWs();
    if (i >= n) break;
    let name = '';
    while (i < n && /[A-Za-z0-9_]/.test(body[i]!)) { name += body[i]!; i += 1; }
    if (!name) break;
    skipWs();
    if (body[i] !== ':') throw new Error(`Expected : after resource name ${name}`);
    i += 1;
    skipWs();
    if (body[i] !== '`') throw new Error(`Expected template literal for resource ${name}`);
    const tpl = readTemplate(body, i);
    i = tpl.endIndex;
    let paramNames: string[] = [];
    skipWs();
    if (body[i] === '(') {
      const params = readBalanced(body, i, '(', ')');
      i = params.endIndex;
      paramNames = params.text.split(/[\s,]+/).filter(Boolean);
    }
    out.push({ name, body: tpl.text, paramNames });
  }
}

function readTemplate(src: string, start: number): { text: string; endIndex: number } {
  let i = start + 1;
  let body = '';
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length) {
      body += ch + src[i + 1]!;
      i += 2;
      continue;
    }
    if (ch === '`') return { text: body, endIndex: i + 1 };
    if (ch === '$' && src[i + 1] === '{') {
      const inner = readBalanced(src, i + 1, '{', '}');
      body += '${' + inner.text + '}';
      i = inner.endIndex;
      continue;
    }
    body += ch;
    i += 1;
  }
  throw new Error('Unclosed template literal');
}

function parseStringPairs(body: string, cb: (key: string, value: string) => void): void {
  let i = 0;
  const n = body.length;
  const skipWs = () => {
    while (i < n) {
      const ch = body[i]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') i += 1;
      else if (ch === '#') { while (i < n && body[i] !== '\n') i += 1; }
      else break;
    }
  };
  const readString = (): string => {
    const q = body[i]!;
    if (q !== "'" && q !== '"') throw new Error('Expected string');
    i += 1;
    let s = '';
    while (i < n && body[i] !== q) {
      if (body[i] === '\\' && i + 1 < n) {
        s += body[i + 1]!;
        i += 2;
        continue;
      }
      s += body[i]!;
      i += 1;
    }
    i += 1;
    return s;
  };
  while (true) {
    skipWs();
    if (i >= n) break;
    const key = readString();
    skipWs();
    if (body[i] !== ':') throw new Error('Expected : in pair');
    i += 1;
    skipWs();
    const value = readString();
    cb(key, value);
  }
}
