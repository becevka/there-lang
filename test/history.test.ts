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

describe('history mode', () => {
  test('undo reverts the last group, redo re-applies', async () => {
    const out = await run(`
      mode history on;
      there is apple;
      apple is red;
      apple is shiny;
      apple undo;
      '' + (apple ? shiny) $print;
      apple redo;
      '' + (apple ? shiny) $print;
    `);
    expect(out).toEqual(['0', '1']);
  });

  test('repeat re-applies the most recent group', async () => {
    const out = await run(`
      mode history on;
      there is apple;
      apple is red;
      apple repeat;
      '' + (apple ? red) $print;
    `);
    expect(out).toEqual(['2']);
  });

  test('learn groups a block; forget reverts it by tag', async () => {
    const out = await run(`
      mode history on;
      there is apple;
      apple learn { apple is green; apple is green };
      '' + (apple ? green) $print;
      apple forget lesson;
      '' + (apple ? green) $print;
    `);
    expect(out).toEqual(['2', '0']);
  });

  test('start/stop tag a session; forget reverts only that tag', async () => {
    const out = await run(`
      mode history on;
      there is apple;
      apple is red;
      apple start session;
      apple is blue;
      apple stop session;
      apple forget session;
      '' + (apple ? red) + ',' + (apple ? blue) $print;
    `);
    expect(out).toEqual(['1,0']);
  });

  test('history is off by default — undo is a no-op', async () => {
    const out = await run(`
      there is apple;
      apple is red;
      apple undo;
      '' + (apple ? red) $print;
    `);
    expect(out).toEqual(['1']);
  });
});
