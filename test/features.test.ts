import { describe, expect, test } from 'bun:test';
import { parse } from '../src/parse/parse.ts';
import { Evaluator } from '../src/eval/evaluator.ts';
import { buildDefaultFacet, defaultParserFacet } from '../src/facet/defaultFacet.ts';
import { ThereEnv, TableElement, stringify } from '../src/runtime/types.ts';

function makeThere(): { there: ThereEnv; output: string[]; inputs: string[] } {
  const there = new ThereEnv();
  const output: string[] = [];
  const inputs: string[] = [];
  there.out = (text) => { output.push(text); };
  there.ask = (_text, cb) => { cb(inputs.shift() ?? ''); };
  return { there, output, inputs };
}

async function run(src: string, inputs: string[] = []) {
  const { there, output, inputs: q } = makeThere();
  q.push(...inputs);
  const parsed = parse(src, defaultParserFacet);
  const ev = new Evaluator(there, buildDefaultFacet());
  await ev.run(parsed.head, parsed.resources);
  return { there, output };
}

describe('tables', () => {
  test('column construction and row insert', async () => {
    const { there } = await run(`t = |key value|; t + ['a' 1] and ['b' 2];`);
    const t = there.properties.t as TableElement;
    expect(t.count).toBe(2);
    expect(t.columns).toEqual(['key', 'value']);
  });

  test('row iteration binds columns as resources', async () => {
    const { output } = await run(`
      t = |k v|;
      t + ['a' 1] and ['b' 2];
      t _ { '' + $k + '=' + $v $print };
    `);
    expect(output).toEqual(['a=1', 'b=2']);
  });

  test('row delete by index', async () => {
    const { there } = await run(`
      t = |k v|;
      t + ['a' 1] and ['b' 2] and ['c' 3];
      t - 1;
    `);
    const t = there.properties.t as TableElement;
    expect(t.count).toBe(2);
    expect(t.struct.k!.map(stringify)).toEqual(['a', 'c']);
  });

  test('row get by index returns the row', async () => {
    const { output } = await run(`
      t = |k v|;
      t + ['a' 1] and ['b' 2];
      t * 0 $print;
      t * 1 $print;
    `);
    expect(output).toEqual(['a,1', 'b,2']);
  });

  test('row get out-of-bounds returns count', async () => {
    const { output } = await run(`
      t = |k v|;
      t + ['a' 1] and ['b' 2];
      t * 5 $print;
    `);
    expect(output).toEqual(['2']);
  });

  test('list search with * wildcard', async () => {
    const { output } = await run(`
      t = |k v|;
      t + ['a' 1] and ['b' 2] and ['a' 3];
      t * ['a' *] $print;
    `);
    // Two rows where k='a': [a,1] and [a,3].
    expect(output[0]).toContain('a,1');
    expect(output[0]).toContain('a,3');
  });

  test('regex row search', async () => {
    const { output } = await run(`
      t = |k v|;
      t + ['apple' 1] and ['banana' 2] and ['avocado' 3];
      t * '^a' $print;
    `);
    // Rows whose joined "k v" starts with 'a': apple, avocado.
    expect(output[0]).toContain('apple,1');
    expect(output[0]).toContain('avocado,3');
    expect(output[0]).not.toContain('banana');
  });
});

describe('ranges', () => {
  test('numeric range with default step', async () => {
    const { output } = await run(`(1 .. 4) _ { $el $print };`);
    expect(output).toEqual(['1', '2', '3', '4']);
  });

  test('dynamic range resolves $a / $b from properties', async () => {
    const { output } = await run(`a = 1; b = 3; ($a .. $b) _ { $el $print };`);
    expect(output).toEqual(['1', '2', '3']);
  });

  test('numeric range with step', async () => {
    const { output } = await run(`(2 .. 10 2) _ { $el $print };`);
    expect(output).toEqual(['2', '4', '6', '8', '10']);
  });

  test('alpha range', async () => {
    const { output } = await run(`(a .. c) _ { $el $print };`);
    expect(output).toEqual(['a', 'b', 'c']);
  });
});

describe('auto-read', () => {
  test('positional fallback for unknown resources', async () => {
    const { output } = await run(`
      mode auto-read on;
      g = { '' + $color $print };
      g blue;
    `);
    expect(output).toEqual(['blue']);
  });
});

describe('parser spec extras', () => {
  test('$$name closure shorthand captures by value', async () => {
    const { output } = await run(`
      a = 7;
      adder = { $a + $b } ($$a $b);
      adder 100 $print;
      adder 200 $print;
    `);
    // Captured a=7 (cloned). Each call sees the captured 7. Mutation on
    // the param clone doesn't bleed into the original a.
    expect(output).toEqual(['107', '207']);
  });

  test('arity-via-number parser spec', async () => {
    const { output } = await run(`
      take3 = { '' + $1 + ' ' + $2 + ' ' + $3 $print } (3);
      take3 red green blue;
    `);
    expect(output).toEqual(['red green blue']);
  });

  test('regex parser slot matches alternation; cursor rolls back on miss', async () => {
    const { output } = await run(`
      f = { '' + $a + ':' + $b $print } ($a [black|white] $b);
      f cat black mouse;
      f dog brown spider;
      f bird white feather;
      'end' $print;
    `);
    // dog/brown/spider doesn't match — vector is a no-op.
    expect(output).toEqual(['cat:mouse', 'bird:feather', 'end']);
  });

  test('range iteration honors early-stop on falsy body return', async () => {
    const { output } = await run(`
      sum = 0;
      (1 .. 10) _ { sum + $el; $el ?! 5 };
      sum $print;
    `);
    expect(output).toEqual(['15']);
  });
});

describe('value vector ~', () => {
  test('literal value', async () => {
    const { output } = await run(`x ~ 'hello'; x $print;`);
    expect(output).toEqual(['hello']);
  });

  test('block value evaluated and cached', async () => {
    const { output } = await run(`y ~ { 2 + 3 }; y $print;`);
    expect(output).toEqual(['5']);
  });

  test('block value is lazy — re-runs on each access', async () => {
    const { output } = await run(`
      there is apple;
      apple is red;
      n ~ { apple ? red };
      n $print;
      apple is red;
      apple is red;
      n $print;
      apple is! red;
      n $print;
    `);
    expect(output).toEqual(['1', '3', '2']);
  });
});

describe('resource prompting', () => {
  test('asks for unresolved top-level $name', async () => {
    const { output } = await run(`'color: ' + $color $print;`, ['green']);
    expect(output).toEqual(['color: green']);
  });
});
