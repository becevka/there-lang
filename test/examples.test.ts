import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from '../src/parse/parse.ts';
import { Evaluator } from '../src/eval/evaluator.ts';
import { buildDefaultFacet, defaultParserFacet } from '../src/facet/defaultFacet.ts';
import { applyInlineFacet } from '../src/facet/inlineHost.ts';
import { installModuleLoader } from '../src/facet/modules.ts';
import { runWhere } from '../src/cli/where.ts';
import { ThereEnv } from '../src/runtime/types.ts';

const ROOT = resolve(import.meta.dir, '..');

async function runProgram(relPath: string, inputs: string[] = []): Promise<string[]> {
  const file = join(ROOT, relPath);
  const source = readFileSync(file, 'utf8');
  const parsed = parse(source, defaultParserFacet);
  const there = new ThereEnv();
  const output: string[] = [];
  there.out = (text) => { output.push(text); };
  const queue = [...inputs];
  there.ask = (_t, cb) => { cb(queue.shift() ?? ''); };
  applyInlineFacet(there, parsed.inline);
  const ev = new Evaluator(there, buildDefaultFacet());
  ev.baseDir = dirname(file);
  installModuleLoader(ev);
  await ev.run(parsed.head, parsed.resources);
  return output;
}

describe('example programs', () => {
  test('fizzbuzz produces the classic sequence', async () => {
    const out = await runProgram('examples/fizzbuzz.th');
    expect(out).toEqual([
      'FizzBuzz', '1', '2', 'Fizz', '4', 'Buzz', 'Fizz', '7', '8', 'Fizz',
    ]);
  });

  test('lang-steps runs end to end', async () => {
    const out = await runProgram('examples/lang-steps.th');
    expect(out[0]).toBe('Red: 1');
    expect(out).toContain('Pear: 0');
    // The continuation section: rot makes green→yellow, red→brown.
    expect(out[out.length - 1]).toBe('berry is red: 0');
  });
});

describe('where test suites', () => {
  test('anagram suite all green', async () => {
    const out: string[] = [];
    const { passes, failures } = await runWhere(
      join(ROOT, 'examples/anagram/test.th'),
      { out: (t) => out.push(t), ask: (_t, cb) => cb('') },
    );
    expect(failures).toBe(0);
    expect(passes).toBeGreaterThanOrEqual(10);
  });

  test('clock suite all green', async () => {
    const out: string[] = [];
    const { passes, failures } = await runWhere(
      join(ROOT, 'examples/clock/test.th'),
      { out: (t) => out.push(t), ask: (_t, cb) => cb('') },
    );
    expect(failures).toBe(0);
    expect(passes).toBeGreaterThanOrEqual(13);
  });
});
