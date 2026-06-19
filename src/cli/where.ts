import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from '../parse/parse.ts';
import { Evaluator } from '../eval/evaluator.ts';
import { buildDefaultFacet, defaultParserFacet } from '../facet/defaultFacet.ts';
import { loadModuleByName, installModuleLoader } from '../facet/modules.ts';
import { applyInlineFacet } from '../facet/inlineHost.ts';
import { ThereEnv } from '../runtime/types.ts';
import type { ParserFacet } from '../parse/parse.ts';

/**
 * `bin/where <path>` — run a test file (or a directory's test.th) inside the
 * `where` facet. The sibling `index.th` (the code under test) is evaluated
 * first in the same env, then the tests, then `all;`.
 */
export async function runWhere(
  path: string,
  io?: { out?: ThereEnv['out']; ask?: ThereEnv['ask'] },
): Promise<{ passes: number; failures: number }> {
  let testFile = resolve(path);
  if (existsSync(testFile) && statSync(testFile).isDirectory()) {
    testFile = join(testFile, 'test.th');
  } else if (!existsSync(testFile) && existsSync(`${testFile}.th`)) {
    testFile = `${testFile}.th`;
  }
  if (!existsSync(testFile)) throw new Error(`Test file not found: ${path}`);
  const dir = dirname(testFile);

  const bootstrap = new ThereEnv();
  if (io?.out) bootstrap.out = io.out;
  if (io?.ask) bootstrap.ask = io.ask;
  const whereModule = await loadModuleByName('where', dir, bootstrap);
  const env = whereModule.env;
  if (io?.out) env.out = io.out;
  if (io?.ask) env.ask = io.ask;

  // Tests parse with the where dialect (its phrases) on top of the default.
  const parserFacet: ParserFacet = {
    aliases: { ...defaultParserFacet.aliases },
    phrases: [...defaultParserFacet.phrases, ...whereModule.inline.phrases],
  };

  const ev = new Evaluator(env, buildDefaultFacet());
  ev.baseDir = dir;
  installModuleLoader(ev);

  const sources: string[] = [];
  const indexFile = join(dir, 'index.th');
  if (existsSync(indexFile) && resolve(indexFile) !== testFile) {
    sources.push(readFileSync(indexFile, 'utf8'));
  }
  sources.push(readFileSync(testFile, 'utf8'));
  sources.push("all;\n'done' $print;");

  for (const src of sources) {
    const parsed = parse(src, parserFacet);
    applyInlineFacet(env, parsed.inline);
    await ev.run(parsed.head, parsed.resources);
  }

  const count = (name: string): number => {
    const v = env.properties[name] as { val?: unknown } | undefined;
    return typeof v?.val === 'number' ? v.val : 0;
  };
  return { passes: count('passes'), failures: count('failures') };
}
