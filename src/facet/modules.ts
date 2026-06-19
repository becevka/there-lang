import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type ParseResult } from '../parse/parse.ts';
import { Evaluator } from '../eval/evaluator.ts';
import { ThereEnv } from '../runtime/types.ts';
import { buildDefaultFacet, defaultParserFacet } from './defaultFacet.ts';
import { applyInlineFacet } from './inlineHost.ts';
import type { InlineFacet } from '../parse/inlineFacet.ts';

/**
 * Module loading (SPEC § 4.12 / § 8). A module is a directory with an
 * `index.th` (or a plain `name.th` file). Resolution order:
 *   1. relative to the requiring program's directory,
 *   2. the runtime's built-in `src/modules/` directory.
 * The module runs once per process in its own `there`, sharing the parent's
 * IO, and its env is what `@` returns.
 */

const MODULES_ROOT = fileURLToPath(new URL('../modules/', import.meta.url));

export interface LoadedModule {
  env: ThereEnv;
  inline: InlineFacet;
}

const cache = new Map<string, Promise<LoadedModule>>();

export function resolveModulePath(name: string, baseDir: string): string | null {
  const candidates = [
    join(resolve(baseDir), name),
    join(resolve(baseDir), `${name}.th`),
    join(MODULES_ROOT, name),
    join(MODULES_ROOT, `${name}.th`),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (statSync(c).isDirectory()) {
      const index = join(c, 'index.th');
      if (existsSync(index)) return index;
      continue;
    }
    return c;
  }
  return null;
}

export async function loadModuleAt(filePath: string, parent: ThereEnv): Promise<LoadedModule> {
  const key = resolve(filePath);
  const existing = cache.get(key);
  if (existing) return await existing;
  const promise = (async (): Promise<LoadedModule> => {
    const source = readFileSync(key, 'utf8');
    const parsed: ParseResult = parse(source, defaultParserFacet);
    const env = new ThereEnv();
    env.out = parent.out;
    env.ask = parent.ask;
    applyInlineFacet(env, parsed.inline);
    const ev = new Evaluator(env, buildDefaultFacet());
    ev.baseDir = dirname(key);
    installModuleLoader(ev);
    await ev.run(parsed.head, parsed.resources);
    return { env, inline: parsed.inline };
  })();
  cache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    cache.delete(key);
    throw err;
  }
}

export function installModuleLoader(ev: Evaluator): void {
  ev.moduleLoader = async (name, requester) => {
    const path = resolveModulePath(name, requester.baseDir);
    if (!path) throw new Error(`Module not found: ${name}`);
    const { env } = await loadModuleAt(path, requester.there);
    return env;
  };
}

/** Used by the where runner to merge a module's dialect into the parser. */
export async function loadModuleByName(name: string, baseDir: string, parent: ThereEnv): Promise<LoadedModule> {
  const path = resolveModulePath(name, baseDir);
  if (!path) throw new Error(`Module not found: ${name}`);
  return await loadModuleAt(path, parent);
}
