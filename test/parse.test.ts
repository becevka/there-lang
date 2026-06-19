import { describe, expect, test } from 'bun:test';
import { tokenize } from '../src/parse/tokenize.ts';
import { parse } from '../src/parse/parse.ts';
import { extractInlineFacet } from '../src/parse/inlineFacet.ts';
import { defaultParserFacet } from '../src/facet/defaultFacet.ts';

function tokenValues(head: ReturnType<typeof tokenize>['head']): { type: string; value: string | number }[] {
  const out: { type: string; value: string | number }[] = [];
  let cur = head;
  while (cur) {
    out.push({ type: cur.type, value: cur.value });
    cur = cur.next;
  }
  return out;
}

describe('tokenize', () => {
  test('words, numbers, strings', () => {
    const { head } = tokenize('apple 42 "hi"', {});
    expect(tokenValues(head)).toEqual([
      { type: 'word', value: 'apple' },
      { type: 'number', value: 42 },
      { type: 'string', value: 'hi' },
    ]);
  });

  test('comments are skipped', () => {
    const { head } = tokenize('# comment\napple', {});
    expect(tokenValues(head)).toEqual([{ type: 'word', value: 'apple' }]);
  });

  test('aliases apply at tokenization', () => {
    const { head } = tokenize('apple is red', { is: '+' });
    expect(tokenValues(head)).toEqual([
      { type: 'word', value: 'apple' },
      { type: 'word', value: '+' },
      { type: 'word', value: 'red' },
    ]);
  });

  test('resources strip $', () => {
    const { head, resources } = tokenize('$rand 3', {});
    expect(tokenValues(head)).toEqual([
      { type: 'resource', value: 'rand' },
      { type: 'number', value: 3 },
    ]);
    expect(resources).toContain('rand');
  });

  test('blocks/sequences are matched but not yet parsed inside', () => {
    const { head } = tokenize('{ a b } (c d)', {});
    expect(head?.type).toBe('block');
    expect(head?.next?.type).toBe('sequence');
  });

  test('string escape sequences', () => {
    const { head } = tokenize("'\\nWelcome'", {});
    expect(head?.type).toBe('string');
    expect(head?.value).toBe('\nWelcome');
  });

  test('semicolon as switch', () => {
    const { head } = tokenize('a; b', {});
    const vals = tokenValues(head);
    expect(vals[1]).toEqual({ type: 'switch', value: ';' });
  });
});

describe('inline facet extraction', () => {
  test('extracts resources block', () => {
    const src = '```facet\nresources = { rand : `${return 1;}` (n) }\n```\nhero;';
    const { stripped, inline } = extractInlineFacet(src);
    expect(stripped.includes('```facet')).toBe(false);
    expect(inline.resources).toHaveLength(1);
    expect(inline.resources[0]!.name).toBe('rand');
    expect(inline.resources[0]!.paramNames).toEqual(['n']);
  });

  test('extracts phrases block', () => {
    const src = "```facet\nphrases = { 'the hero': 'hero' }\n```";
    const { inline } = extractInlineFacet(src);
    expect(inline.phrases).toEqual([{ pattern: 'the hero', replacement: 'hero' }]);
  });
});

describe('parse with default facet', () => {
  test('phrase rewriting applies', () => {
    const result = parse('let a be 5', defaultParserFacet);
    // "let a be 5" → "a = 5"
    const tokens: { type: string; value: string | number }[] = [];
    let cur = result.head;
    while (cur) { tokens.push({ type: cur.type, value: cur.value }); cur = cur.next; }
    expect(tokens).toEqual([
      { type: 'word', value: 'a' },
      { type: 'word', value: '=' },
      { type: 'number', value: 5 },
    ]);
  });

  test('lazy compound parsing', () => {
    const result = parse('{ a b }', defaultParserFacet);
    const block = result.head!;
    expect(block.type).toBe('block');
    const inner = block.getSequence?.();
    expect(inner?.value).toBe('a');
    expect(inner?.next?.value).toBe('b');
  });
});
