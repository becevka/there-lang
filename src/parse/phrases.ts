import type { Token } from './token.ts';
import { tokenize } from './tokenize.ts';

/**
 * Phrases match a token sequence and rewrite it. The pattern is pre-tokenized
 * so we can match against the token stream; the replacement is kept as raw
 * source text so `$N` captures can be substituted *recursively* (e.g. inside
 * a replacement like `($1 is? healthy)` we need $1 inside the sequence body
 * to be replaced too, not just at the top level).
 */
export interface Phrase {
  pattern: Token[];
  rawReplacement: string;
}

function isResourceCapture(t: Token): boolean {
  return t.type === 'resource' && t.value === '';
}

function tokensToArray(head: Token | undefined): Token[] {
  const out: Token[] = [];
  let cur = head;
  while (cur) {
    out.push(cur);
    cur = cur.next;
  }
  return out;
}

function arrayToList(arr: Token[]): Token | undefined {
  if (arr.length === 0) return undefined;
  for (let i = 0; i < arr.length - 1; i += 1) arr[i]!.next = arr[i + 1];
  arr[arr.length - 1]!.next = undefined;
  return arr[0];
}

function matchPhrase(tokens: Token[], start: number, phrase: Phrase): { length: number; captures: Token[] } | null {
  const captures: Token[] = [];
  let ti = start;
  for (const pat of phrase.pattern) {
    if (ti >= tokens.length) return null;
    const tok = tokens[ti]!;
    if (isResourceCapture(pat)) {
      captures.push(tok);
      ti += 1;
      continue;
    }
    if (pat.type !== tok.type || String(pat.value) !== String(tok.value)) return null;
    ti += 1;
  }
  return { length: ti - start, captures };
}

function tokenToSource(tok: Token): string {
  switch (tok.type) {
    case 'string': {
      const s = String(tok.value);
      if (!s.includes("'")) return `'${s}'`;
      if (!s.includes('"')) return `"${s}"`;
      return `'${s.replace(/'/g, "\\'")}'`;
    }
    case 'template': return '`' + String(tok.raw ?? tok.value) + '`';
    case 'number':   return String(tok.value);
    case 'switch':   return ';';
    case 'resource': return '$' + String(tok.value);
    case 'word':     return String(tok.value);
    case 'block':    return '{' + String(tok.raw ?? tok.value) + '}';
    case 'sequence': return '(' + String(tok.raw ?? tok.value) + ')';
    case 'list':     return '[' + String(tok.raw ?? tok.value) + ']';
    case 'table':    return '|' + String(tok.raw ?? tok.value) + '|';
  }
}

function substituteCaptures(raw: string, captures: Token[]): string {
  return raw.replace(/\$(\d+)/g, (m, idx) => {
    const cap = captures[Number(idx) - 1];
    return cap ? tokenToSource(cap) : m;
  });
}

export function applyPhrases(
  head: Token | undefined,
  phrases: Phrase[],
  aliases: Record<string, string> = {},
  resources?: string[],
): Token | undefined {
  if (!head || phrases.length === 0) return head;
  let tokens = tokensToArray(head);
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (const phrase of phrases) {
      const m = matchPhrase(tokens, i, phrase);
      if (m) {
        const substituted = substituteCaptures(phrase.rawReplacement, m.captures);
        const reparsed = tokenize(substituted, aliases);
        const expanded = tokensToArray(reparsed.head);
        if (resources) {
          for (const r of reparsed.resources) if (!resources.includes(r)) resources.push(r);
        }
        tokens.splice(i, m.length, ...expanded);
        i += expanded.length;  // advance past the substitution; don't re-scan it
        matched = true;
        break;
      }
    }
    if (!matched) i += 1;
  }
  return arrayToList(tokens);
}
