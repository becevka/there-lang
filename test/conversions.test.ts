import { describe, expect, test } from 'bun:test';
import { parse } from '../src/parse/parse.ts';
import { Evaluator } from '../src/eval/evaluator.ts';
import { buildDefaultFacet, defaultParserFacet } from '../src/facet/defaultFacet.ts';
import {
  ThereEnv, NumberElement, StringElement, ListElement,
} from '../src/runtime/types.ts';

async function run(src: string) {
  const there = new ThereEnv();
  const output: string[] = [];
  there.out = (text) => { output.push(text); };
  there.ask = (_t, cb) => { cb(''); };
  const parsed = parse(src, defaultParserFacet);
  const ev = new Evaluator(there, buildDefaultFacet());
  await ev.run(parsed.head, parsed.resources);
  return { there, output };
}

describe('type conversions', () => {
  test('number coerces a string', async () => {
    const { there } = await run(`x = (number '12');`);
    const x = there.properties.x as NumberElement;
    expect(x).toBeInstanceOf(NumberElement);
    expect(x.val).toBe(12);
  });

  test('string coerces a number', async () => {
    const { there } = await run(`x = (string 12);`);
    const x = there.properties.x as StringElement;
    expect(x).toBeInstanceOf(StringElement);
    expect(x.val).toBe('12');
  });

  test('element makes a named element', async () => {
    const { output } = await run(`x = (element 'apple'); '' + x $print;`);
    expect(output).toEqual(['apple']);
  });

  test('list wraps a single value', async () => {
    const { there } = await run(`x = (list 'solo');`);
    const x = there.properties.x as ListElement;
    expect(x).toBeInstanceOf(ListElement);
    expect(x.states.map((s) => (s as StringElement).val)).toEqual(['solo']);
  });

  test('list copies an existing list', async () => {
    const { there } = await run(`x = (list ['a' 'b']);`);
    const x = there.properties.x as ListElement;
    expect(x.states.length).toBe(2);
  });

  test('conversion word stays a probe after ? (value-only)', async () => {
    // `? list` must read as a size probe, not consume `list` as a conversion.
    const { output } = await run(`
      xs = ['a' 'b' 'c'];
      n = (xs ? list);
      '' + n $print;
    `);
    expect(output).toEqual(['3']);
  });

  test('sequence/block round-trip a list into runnable code', async () => {
    const { output } = await run(`
      there is plum;
      b = (block ['plum' '+' 'red']);
      b;
      '' + (plum ? red) $print;
    `);
    expect(output).toEqual(['1']);
  });
});
