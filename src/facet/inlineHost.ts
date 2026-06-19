import type { InlineResource, InlineFacet } from '../parse/inlineFacet.ts';
import type { ResourceDef } from '../eval/evaluator.ts';
import { ThereEnv } from '../runtime/types.ts';

/**
 * Compile a template-bodied inline resource/global (` rand : `${ … }` (n) `)
 * into a callable ResourceDef. The body is host JavaScript with access to
 * `parameters`, `source`, `there`, and `env`.
 */
export function compileInlineResource(r: InlineResource): ResourceDef {
  // Templates are conventionally `${ ... JS function body ... }` — strip the
  // outer `${}` so the body is a real function body.
  let body = r.body.trim();
  if (body.startsWith('${') && body.endsWith('}')) body = body.slice(2, -1);
  const compiled = new Function('parameters', 'source', 'there', 'env', '"use strict";' + body);
  return {
    __resource: true,
    arity: r.paramNames.length,
    fn: (source, params, there, env) => {
      try {
        return compiled.call({}, params, source, there, env);
      } catch (err) {
        there.out(`error in resource ${r.name}: ${(err as Error).message}`, 1);
        return undefined;
      }
    },
  };
}

/** Install an inline facet's host pieces onto a `there` env. */
export function applyInlineFacet(there: ThereEnv, inline: InlineFacet): void {
  for (const r of inline.resources) {
    there.resources[r.name] = compileInlineResource(r);
  }
  for (const r of inline.globals) {
    const def = compileInlineResource(r);
    there.resources[r.name] = def;
    there.globals[r.name] = def;
  }
}
