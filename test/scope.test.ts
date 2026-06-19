import { describe, expect, test } from 'bun:test';
import { parse } from '../src/parse/parse.ts';
import { Evaluator } from '../src/eval/evaluator.ts';
import { buildDefaultFacet, defaultParserFacet } from '../src/facet/defaultFacet.ts';
import { ThereEnv } from '../src/runtime/types.ts';

async function run(src: string): Promise<string[]> {
  const there = new ThereEnv();
  const output: string[] = [];
  there.out = (text) => { output.push(text); };
  there.ask = (_t, cb) => { cb(''); };
  const parsed = parse(src, defaultParserFacet);
  const ev = new Evaluator(there, buildDefaultFacet());
  await ev.run(parsed.head, parsed.resources);
  return output;
}

describe('import / export', () => {
  test('multi-return collects exported values as a list', async () => {
    const out = await run(`
      gen = { a = 12; b = 10; a >>; b >>; };
      r = gen;
      '' + (r * 0) + ',' + (r * 1) $print;
    `);
    expect(out).toEqual(['12,10']);
  });

  test('export with a name publishes into the parent', async () => {
    const out = await run(`
      stash = { secret = 42; secret >> kept; };
      stash;
      '' + kept $print;
    `);
    expect(out).toEqual(['42']);
  });

  test('value import binds a local name', async () => {
    const out = await run(`
      f = { x << $v; '' + x $print } ($v);
      f 7;
    `);
    expect(out).toEqual(['7']);
  });
});

describe('vector chaining', () => {
  test('a callable result is applied to the following value token', async () => {
    // `pick` returns a vector; the trailing `9` is consumed by it (SPEC 4.3
    // step 6), so the whole expression evaluates to 4 + 9.
    const out = await run(`
      pick = { { 4 + $n } ($n) } (0);
      r = (pick 9);
      '' + r $print;
    `);
    expect(out).toEqual(['13']);
  });
});

describe('local assignment scoping', () => {
  test('assignment in a vector body shadows an ancestor binding', async () => {
    const out = await run(`
      total = 100;
      bump = { total = 1; '' + total $print };
      bump;
      '' + total $print;
    `);
    // Inside bump, total is a fresh local (shadow); outer total is untouched.
    expect(out).toEqual(['1', '100']);
  });
});
