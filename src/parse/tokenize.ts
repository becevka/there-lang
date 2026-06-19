import type { Token, TokenType } from './token.ts';

const OPENERS: Record<string, { close: string; type: TokenType; nested: boolean }> = {
  '{': { close: '}', type: 'block', nested: true },
  '(': { close: ')', type: 'sequence', nested: true },
  '[': { close: ']', type: 'list', nested: true },
  '|': { close: '|', type: 'table', nested: false },
};

const STRING_QUOTES = new Set(['"', "'", '`']);

const STOP_CHARS = new Set([' ', '\t', '\n', '\r', ';', '{', '(', '[', '|', '}', ')', ']']);

export interface Tokenized {
  head: Token | undefined;
  resources: string[];
}

function processEscapes(s: string, quote: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length) {
      const next = s[i + 1]!;
      if (next === quote || next === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if (next === 'n') { out += '\n'; i += 2; continue; }
      if (next === 't') { out += '\t'; i += 2; continue; }
      if (next === 'r') { out += '\r'; i += 2; continue; }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function tokenize(
  source: string,
  aliases: Record<string, string>
): Tokenized {
  let i = 0;
  let line = 1;
  let column = 1;
  const resources: string[] = [];
  let head: Token | undefined;
  let tail: Token | undefined;

  const peek = (off = 0): string | undefined => source[i + off];

  const advance = (): string => {
    const ch = source[i]!;
    i += 1;
    if (ch === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return ch;
  };

  const skipWhitespaceAndComments = () => {
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        advance();
      } else if (ch === '#') {
        while (i < source.length && source[i] !== '\n') advance();
      } else {
        break;
      }
    }
  };

  const readString = (quote: string, startLine: number, startCol: number): Token => {
    advance();
    let body = '';
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === '\\' && i + 1 < source.length) {
        body += ch;
        advance();
        body += source[i]!;
        advance();
        continue;
      }
      if (ch === quote) {
        advance();
        const type: TokenType = quote === '`' ? 'template' : 'string';
        const value = processEscapes(body, quote);
        const tok: Token = { type, value, raw: body, line: startLine, position: startCol };
        return tok;
      }
      body += ch;
      advance();
    }
    throw new Error(`Unclosed string at line ${startLine}`);
  };

  const readDelimited = (
    open: string,
    close: string,
    type: TokenType,
    nested: boolean,
    startLine: number,
    startCol: number,
  ): Token => {
    advance();
    let body = '';
    let depth = 1;
    while (i < source.length) {
      const ch = source[i]!;
      if (ch === '\\' && i + 1 < source.length) {
        body += ch;
        advance();
        body += source[i]!;
        advance();
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        body += ch;
        advance();
        while (i < source.length) {
          const c2 = source[i]!;
          if (c2 === '\\' && i + 1 < source.length) {
            body += c2;
            advance();
            body += source[i]!;
            advance();
            continue;
          }
          body += c2;
          advance();
          if (c2 === ch) break;
        }
        continue;
      }
      if (nested && ch === open) {
        depth += 1;
        body += ch;
        advance();
        continue;
      }
      if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          advance();
          return { type, value: body.trim(), raw: body, line: startLine, position: startCol };
        }
        body += ch;
        advance();
        continue;
      }
      body += ch;
      advance();
    }
    throw new Error(`Unclosed ${type} at line ${startLine}`);
  };

  const readBare = (): string => {
    let s = '';
    while (i < source.length) {
      const ch = source[i]!;
      if (STOP_CHARS.has(ch)) break;
      s += ch;
      advance();
    }
    return s;
  };

  const classify = (text: string, startLine: number, startCol: number): Token => {
    if (text === ';') return { type: 'switch', value: ';', line: startLine, position: startCol };
    if (text.startsWith('$')) {
      const name = text.slice(1);
      if (name && !resources.includes(name)) resources.push(name);
      return { type: 'resource', value: name, line: startLine, position: startCol };
    }
    if (/^-?\d/.test(text) && !isNaN(Number(text))) {
      return { type: 'number', value: Number(text), line: startLine, position: startCol };
    }
    return { type: 'word', value: text, line: startLine, position: startCol };
  };

  const push = (tok: Token) => {
    if (!head) {
      head = tok;
      tail = tok;
    } else {
      tail!.next = tok;
      tail = tok;
    }
  };

  while (i < source.length) {
    skipWhitespaceAndComments();
    if (i >= source.length) break;

    const ch = source[i]!;
    const startLine = line;
    const startCol = column;

    if (ch === ';') {
      advance();
      push({ type: 'switch', value: ';', line: startLine, position: startCol });
      continue;
    }

    if (STRING_QUOTES.has(ch)) {
      push(readString(ch, startLine, startCol));
      continue;
    }

    if (ch === '|' && source[i + 1] === '|') {
      advance(); advance();
      push({ type: 'word', value: '||', line: startLine, position: startCol });
      continue;
    }

    const opener = OPENERS[ch];
    if (opener) {
      push(readDelimited(ch, opener.close, opener.type, opener.nested, startLine, startCol));
      continue;
    }

    const raw = readBare();
    if (!raw) {
      advance();
      continue;
    }

    const aliased = Object.prototype.hasOwnProperty.call(aliases, raw) ? aliases[raw]! : raw;
    push(classify(aliased, startLine, startCol));
  }

  return { head, resources };
}
