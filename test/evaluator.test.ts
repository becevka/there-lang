import { describe, expect, test } from 'bun:test';
import { parse } from '../src/parse/parse.ts';
import { Evaluator } from '../src/eval/evaluator.ts';
import { buildDefaultFacet, defaultParserFacet } from '../src/facet/defaultFacet.ts';
import { ThereEnv, NumberElement, StringElement, ThereElement, VectorElement } from '../src/runtime/types.ts';

function makeThere(): { there: ThereEnv; output: string[] } {
  const there = new ThereEnv();
  const output: string[] = [];
  there.out = (text) => { output.push(text); };
  there.ask = (_text, cb) => { cb(''); };
  return { there, output };
}

async function runProgram(src: string): Promise<{ output: string[]; there: ThereEnv }> {
  const parsed = parse(src, defaultParserFacet);
  const { there, output } = makeThere();
  const ev = new Evaluator(there, buildDefaultFacet());
  await ev.run(parsed.head);
  return { output, there };
}

describe('evaluator basics', () => {
  test('elements get added to there via +', async () => {
    const { there } = await runProgram('there + apple;');
    expect(there.properties.apple).toBeInstanceOf(ThereElement);
  });

  test('multiset state count via ?', async () => {
    const { output } = await runProgram(`
      there + apple;
      apple + red;
      apple + red;
      apple ? red $print;
    `);
    expect(output).toEqual(['2']);
  });

  test('? is_not / ?! returns 0 / 1', async () => {
    const { output } = await runProgram(`
      there + apple;
      apple + red;
      apple ?! blue $print;
      apple ?! red $print;
    `);
    expect(output).toEqual(['1', '0']);
  });

  test('iteration over number with $i works', async () => {
    const { output } = await runProgram(`
      total = 0;
      11 _ { total + $i };
      total $print;
    `);
    expect(output).toEqual(['55']);
  });

  test('assignment stores vector', async () => {
    const { there } = await runProgram('rolls = { 1 };');
    expect(there.properties.rolls).toBeInstanceOf(VectorElement);
  });

  test('|| runs body when prior iteration did not', async () => {
    const { output } = await runProgram(`
      0 _ { 'then' $print } || { 'else' $print };
      1 _ { 'then' $print } || { 'else' $print };
    `);
    expect(output).toEqual(['else', 'then']);
  });

  test('continuation fires on + match', async () => {
    const { output } = await runProgram(`
      (rotten) ... { $el + brown };
      there + apple;
      apple + rotten;
      apple ? brown $print;
    `);
    expect(output).toEqual(['1']);
  });

  test('continuation matches isOf — param element with effect as state', async () => {
    const { output } = await runProgram(`
      (rotten) ... { $el + brown };
      there + apple;
      apple + rotten;
      apple ? brown $print;
    `);
    // The continuation should also fire when the param's element type
    // matches via isOf (size > 0). Same effect as the above for now —
    // this guarantees the path through callMethod that yields a
    // ThereElement('rotten') param matches the continuation.
    expect(output).toEqual(['1']);
  });

  test('constructor instantiates and caches the block result', async () => {
    const { there, output } = await runProgram(`
      a = { book is $1; book is $2 };
      (book) : { a red green };
      book ? red $print;
      book ? green $print;
    `);
    expect(output).toEqual(['1', '1']);
    expect(there.properties.book).toBeDefined();
  });

  test('string concat with + and $print', async () => {
    const { output } = await runProgram(`
      'hello' + ' world' $print;
    `);
    expect(output).toEqual(['hello world']);
  });

  test('parser specifier with closure default block', async () => {
    const { output } = await runProgram(`
      attacking = {
        $opp + attacked;
      } ($opp);
      (* attacked) ... { $el + hit };
      there + hero;
      there + dragon;
      hero attacking dragon;
      dragon ? hit $print;
    `);
    expect(output).toEqual(['1']);
  });
});
