import {
  EnvElement, ThereEnv, ThereElement, StringElement, NumberElement, ListElement,
  TableElement, VectorElement, asStateName, toStr, toNum, type Element,
} from '../runtime/types.ts';
import type { FacetSetup, GlobalDef, ResourceDef, Cursor } from '../eval/evaluator.ts';
import type { Evaluator } from '../eval/evaluator.ts';
import { SequenceWrapper, SeqValue, RangeValue, unwrapSeq, resolveLazy } from '../eval/evaluator.ts';
import type { RawPhrase } from '../parse/inlineFacet.ts';
import type { Token } from '../parse/token.ts';
import { historyGlobals, recordHistory } from './history.ts';

export const defaultAliases: Record<string, string> = {
  is: '+', are: '+', add: '+', and: '+',
  for: '=', global: '=>',
  isnot: '-', arenot: '-', isnt: '-', aint: '-',
  remove: '-', 'is!': '-', 'are!': '-', '!': '-',
  '/': '?', else: '||', val: '~',
  'is?': '?', 'are?': '?', size: '?',
  'is?!': '?!', 'are?!': '?!',
  equals: '==', with: '+=', without: '-=',
  '.': '*', from: ':', each: '_',
  import: '<<', export: '>>', require: '@',
  $log: '$print', $debug: '$print?',
};

export const defaultPhrases: RawPhrase[] = [
  { pattern: '$ to be $', replacement: '$1 = $2' },
  { pattern: 'let $ be $', replacement: '$1 = $2' },
  { pattern: 'is not', replacement: '-' },
  { pattern: 'are not', replacement: '-' },
  { pattern: '$ is a $', replacement: '$1 + $2' },
  { pattern: '$ is an $', replacement: '$1 + $2' },
  { pattern: '$ is the $', replacement: '$1 + $2' },
  { pattern: '$ or $', replacement: '$1 || $2' },
  // Configuration-as-code: register a continuation rule. `when apple is
  // rotten they become brown` → whenever `apple` gets the `rotten` effect it
  // gains the `brown` state. (SPEC § 3.5; the replacement shape was revised
  // from the original sketch to a real continuation declaration.)
  { pattern: 'when $ is $ they become $', replacement: '($1 $2) ... { $el is $3 }' },
];

function elementOf(v: unknown): Element | undefined {
  if (v && typeof v === 'object') return v as Element;
  return undefined;
}

function ensureSource(source: unknown, there: ThereEnv): unknown {
  if (source == null) return there;
  return source;
}

function unwrap(v: unknown): unknown {
  if (v instanceof SequenceWrapper) return v.head;
  return v;
}

function val(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === 'object') {
    const o = v as { value?: () => unknown; val?: unknown };
    if (typeof o.value === 'function') return o.value();
    if ('val' in o) return o.val;
  }
  return v;
}

function asNumber(v: unknown): number {
  const x = val(v);
  if (typeof x === 'number') return x;
  return Number(x);
}

function wrapPrimitive(v: unknown): unknown {
  if (typeof v === 'number') return new NumberElement(v);
  if (typeof v === 'string') return new StringElement(v);
  return v;
}

function callMethod(method: 'is' | 'not' | 'size' | 'is_not' | 'get' | 'rest' | 'extend' | 'reduce' | 'eq'): GlobalDef['fn'] {
  return async (source, params, there) => {
    let src = unwrapSeq(ensureSource(source, there));
    // Comparisons read the *rendered* value of a lazy `~` source (so a clock
    // compares as its HH:MM string); mutating/indexing ops operate on the
    // underlying element (so `clock + 61` adds minutes, not string-concats).
    if (method === 'eq' || method === 'is_not') src = await resolveLazy(src);
    src = wrapPrimitive(src);
    // Params are always resolved, so a lazy value passed as an argument
    // (`'' + clock`, `total + $el`) contributes its current value.
    const p = await resolveLazy(unwrapSeq(params[0]));
    const target = src as unknown as Record<string, (...a: unknown[]) => unknown>;
    if (target && typeof target[method] === 'function') {
      return target[method]!(p);
    }
    return src;
  };
}

// Env-specific verbs (SPEC § 4.2). On non-env sources these fall through
// to whatever the type defines — usually a no-op or `eq`.
const opHas:    GlobalDef = { name: 'has',   arity: 1, fn: callEnvMethod('set',     'is')     };
const opHasNot: GlobalDef = { name: 'has!',  arity: 1, fn: callEnvMethod('remove',  'not')    };
const opHasQ:   GlobalDef = { name: 'has?',  arity: 1, fn: callEnvMethod('has',     'size')   };
const opHasQN:  GlobalDef = { name: 'has?!', arity: 1, fn: callEnvMethod('has_not', 'is_not') };

function callEnvMethod(envMethod: 'set' | 'remove' | 'has' | 'has_not', fallback: 'is' | 'not' | 'size' | 'is_not'): GlobalDef['fn'] {
  return (source, params, there) => {
    const src = unwrapSeq(ensureSource(source, there));
    const p = unwrapSeq(params[0]);
    if (src instanceof EnvElement) {
      const t = src as unknown as Record<string, (a: unknown) => unknown>;
      return t[envMethod]!(p);
    }
    return callMethod(fallback)(src, [p], there, src as unknown as EnvElement, undefined as never, undefined as never);
  };
}

/** Is the value something a fresh name should be *bound to* rather than
 *  hold as a state? Vectors, strings, numbers, lists, tables, envs — the
 *  examples define everything with `is` (`color is { … }`, `h is 'hello'`). */
function isBindableValue(p: unknown): boolean {
  return p instanceof VectorElement || p instanceof StringElement
    || p instanceof NumberElement || p instanceof ListElement
    || p instanceof TableElement
    || (p instanceof EnvElement && !(p instanceof ThereEnv));
}

const opIs: GlobalDef = {
  name: '+',
  arity: 1,
  fn: async (source, params, there, env, ev, cursor) => {
    const src = unwrapSeq(source);
    const p = unwrapSeq(params[0]);
    // Introduction: `name is <value>` on a fresh, stateless element binds
    // the value to the name (SPEC § 4.11 extension). Element params still
    // push states (`apple is red`).
    if (src instanceof ThereElement && src.states.length === 0 && isBindableValue(p)) {
      if (p instanceof VectorElement && p.type === 'vector') p.type = src.type;
      env.properties[src.type] = p;
      return p;
    }
    const result = await callMethod('is')(source, params, there, env, ev, cursor);
    recordHistory(ev, env, '+', src, p);
    return result;
  },
};

const opNot: GlobalDef = {
  name: '-',
  arity: 1,
  fn: async (source, params, there, env, ev, cursor) => {
    const result = await callMethod('not')(source, params, there, env, ev, cursor);
    recordHistory(ev, env, '-', unwrapSeq(source), unwrapSeq(params[0]));
    return result;
  },
};
const opSize: GlobalDef = { name: '?', arity: 1, fn: callMethod('size') };
const opIsNot: GlobalDef = { name: '?!', arity: 1, fn: callMethod('is_not') };
const opGet: GlobalDef = { name: '*', arity: 1, fn: callMethod('get') };
const opRest: GlobalDef = { name: '%', arity: 1, fn: callMethod('rest') };
const opEq: GlobalDef = { name: '==', arity: 1, fn: callMethod('eq') };
const opExtend: GlobalDef = { name: '+=', arity: 1, fn: callMethod('extend') };
const opReduce: GlobalDef = { name: '-=', arity: 1, fn: callMethod('reduce') };

function isFreshThere(v: unknown): boolean {
  return v instanceof ThereElement && v.states.length === 0;
}

const opAssign: GlobalDef = {
  name: '=',
  arity: 1,
  fn: (source, params, there, env, ev) => {
    // Wrap raw primitives so assigned values are always elements (queries
    // like `%` / `?` return bare numbers; `name = (a % b)` should still hold
    // a NumberElement that can carry a `~` renderer, states, etc.).
    const rhs = wrapPrimitive(unwrapSeq(params[0]));
    const src = unwrapSeq(source);
    const name = ev.assignName
      || (src && typeof src === 'object' ? (src as { type?: string }).type ?? '' : String(src));

    // A name already bound *in this very env* (own property) with a real
    // value is immutable — per SPEC § 4.11 reassignment is a no-op + warning.
    const owns = Object.prototype.hasOwnProperty.call(env.properties, name);
    const ownVal = owns ? (env.properties as Record<string, unknown>)[name] : undefined;
    if (owns && ownVal !== undefined && !isFreshThere(ownVal)) {
      there.out(`Assignment for ${name} is ignored`, 1);
      return src;
    }

    // Otherwise bind locally. A name inherited from an ancestor env is
    // *shadowed* here, giving vector bodies real local variables; a fresh
    // top-level name is introduced.
    if (rhs instanceof VectorElement && rhs.type === 'vector') rhs.type = name;
    env.properties[name] = rhs as unknown;
    return rhs;
  },
};

const opGlobal: GlobalDef = {
  name: '=>',
  arity: 1,
  fn: async (source, params, there, env, ev) => {
    const name = ev.assignName
      || (source instanceof ThereElement ? source.type : '');
    const r = await opAssign.fn(source, params, there, env, ev, { token: undefined });
    if (name) there.globalize(name, r);
    return r;
  },
};

function isTruthy(v: unknown): boolean {
  const x = unwrapSeq(v);
  if (x == null) return false;
  if (typeof x === 'number') return x !== 0;
  if (typeof x === 'string') return x.length > 0;
  if (x instanceof NumberElement) return x.val !== 0;
  if (x instanceof StringElement) return x.val.length > 0;
  return true;
}

const opEach: GlobalDef = {
  name: '_',
  arity: 1,
  fn: async (rawSource, params, there, env, ev) => {
    const body = params[0];
    if (!(body instanceof VectorElement)) return rawSource;

    // Sequences are transparent for iteration: `_` dispatches on the inner
    // value's type. A sequence wrapping a number → loop N times; wrapping a
    // string → prompt; etc. A plain enumeration — `(red blue green)` —
    // iterates its items.
    let source: unknown = rawSource;
    if (source instanceof SeqValue) {
      const items = await ev.enumerateSeq(source);
      if (items) {
        let didRun = false;
        let last: unknown;
        for (let i = 0; i < items.length; i += 1) {
          last = await ev.invokeFully(body, items[i], { el: items[i], i });
          didRun = true;
        }
        return { _ft: didRun, value: last };
      }
      source = source.inner;
    }
    if (source instanceof SequenceWrapper) source = source.head;
    // Iterate based on type. The marker's `value` carries the last body
    // result so `cond _ { A } || { B }` works as an expression.
    const iterate = async (n: number, items?: unknown[], strSource?: string) => {
      let didRun = false;
      let last: unknown;
      if (strSource !== undefined) {
        const answer = await new Promise<string>((resolve) => {
          there.ask(strSource, (a) => resolve(a));
        });
        const ans = new StringElement(answer);
        last = await ev.invokeFully(body as VectorElement, ans, { el: ans, i: 0 });
        return { _ft: true, value: last };
      }
      if (items) {
        for (let i = 0; i < items.length; i += 1) {
          last = await ev.invokeFully(body as VectorElement, items[i], { el: items[i], i });
          didRun = true;
        }
      } else {
        for (let i = 0; i < n; i += 1) {
          last = await ev.invokeFully(body as VectorElement, undefined, { i });
          didRun = true;
        }
      }
      return { _ft: didRun, value: last };
    };

    // Per SPEC § 4.7 iterator early-stop: range iteration breaks if the
    // body returns a defined falsy value.
    const iterateRange = async (range: RangeValue) => {
      const values = range.values();
      let didRun = false;
      let last: unknown;
      for (let i = 0; i < values.length; i += 1) {
        const r = await ev.invokeFully(body as VectorElement, values[i], { el: values[i], i });
        didRun = true;
        last = r;
        if (r !== undefined && !isTruthy(r)) break;
      }
      return { _ft: didRun, value: last };
    };

    if (source instanceof RangeValue) return await iterateRange(source);
    if (typeof source === 'number') return await iterate(source);
    if (source instanceof NumberElement) return await iterate(source.val);
    if (source instanceof StringElement) return await iterate(0, undefined, source.val);
    if (typeof source === 'string') return await iterate(0, undefined, source);
    if (source instanceof ListElement) return await iterate(0, source.states as unknown[]);
    if (source instanceof TableElement) {
      const rows = source.rows();
      let didRun = false;
      let last: unknown;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        last = await ev.invokeFully(body, row, { el: row, i, ...row });
        didRun = true;
      }
      return { _ft: didRun, value: last };
    }
    if (Array.isArray(source)) return await iterate(0, source);
    // truthy fallback
    const n = asNumber(source);
    if (Number.isFinite(n)) return await iterate(n);
    return { _ft: false };
  },
};

const opElse: GlobalDef = {
  name: '||',
  arity: 1,
  fn: async (source, params, there, env, ev) => {
    const body = params[0];
    if (source && typeof source === 'object' && (source as { _ft?: boolean })._ft === true) {
      return source;
    }
    let last: unknown;
    if (body instanceof VectorElement) {
      last = await ev.invokeFully(body, undefined, {});
    }
    return { _ft: true, value: last };
  },
};

const opContinuation: GlobalDef = {
  name: '...',
  arity: 1,
  fn: (source, params, there, env, _ev) => {
    const block = params[0];
    if (!(block instanceof VectorElement)) return source;
    let vectorName = '+';
    let target = '*';
    let effect = '';
    let tokens: Token[] = [];
    if (source instanceof SequenceWrapper) {
      let cur: Token | undefined = source.head;
      while (cur) { tokens.push(cur); cur = cur.next; }
    } else if (Array.isArray(source)) {
      tokens = source as Token[];
    }
    if (tokens.length === 1) effect = String(tokens[0]!.value);
    else if (tokens.length === 2) { target = String(tokens[0]!.value); effect = String(tokens[1]!.value); }
    else if (tokens.length >= 3) {
      vectorName = String(tokens[0]!.value);
      target = String(tokens[1]!.value);
      effect = String(tokens[2]!.value);
    }
    there.continuations.push({
      vectorName, target, effect,
      block: block.body.block!,
      defEnv: block.defEnv ?? there,
    });
    return source;
  },
};

const opConstructor: GlobalDef = {
  name: ':',
  arity: 1,
  fn: (source, params, there, env) => {
    const block = params[0];
    if (!(source instanceof SequenceWrapper)) return source;
    const tokens: Token[] = [];
    let cur = source.head;
    while (cur) { tokens.push(cur); cur = cur.next; }
    if (tokens.length === 0) return source;
    let name = String(tokens[0]!.value);
    let cache = true;
    if (name.startsWith('?')) { cache = false; name = name.slice(1); }
    // Per SPEC § 4.13: double-declaration is a no-op — only the first sticks.
    if (env.constructors[name]) return source;
    if (block instanceof VectorElement && block.body.block) {
      env.constructors[name] = {
        vector: block,
        defEnv: block.defEnv ?? env,
        cache,
        type: name,
      };
    }
    return source;
  },
};

const opVal: GlobalDef = {
  name: '~',
  arity: 1,
  fn: async (rawSource, params, there, env, ev) => {
    // A bare `~ { … }` inside a vector body attaches the lazy value to the
    // *call's own env* (clock's `at`), not the shared `there`.
    const source = rawSource == null ? env : rawSource;
    const rhs = unwrapSeq(params[0]);
    if (rhs instanceof VectorElement) {
      // True laziness per SPEC § 4.10: `_val` is a thunk that re-runs the
      // block on each access. We also seed `_valCache` with an initial
      // evaluation so sync stringify/numberOf paths (which can't await)
      // see a value until the next async resolver bumps the cache.
      const thunk = async (): Promise<unknown> => {
        return await ev.invokeFully(rhs, source, {});
      };
      const initial = await thunk();
      const o = source as { _val?: unknown; _valCache?: unknown; __valVec?: unknown };
      o.__valVec = rhs;
      o._val = thunk;
      o._valCache = initial;
    } else {
      (source as { _val?: unknown })._val = rhs;
    }
    return source;
  },
};

// ── scope mixing: << import, >> export, @ require (SPEC § 4.12) ─────────────

const opImport: GlobalDef = {
  name: '<<',
  arity: 1,
  fn: (source, params, there, env) => {
    const src = unwrapSeq(source);
    const p = unwrapSeq(params[0]);
    // Bare `<<` (or self-import): open the call's args into local properties.
    if (src == null || src === env || src === there) {
      const args = env.resources['args'];
      const names = env.resources['argNames'];
      if (Array.isArray(args) && Array.isArray(names)) {
        for (let i = 0; i < names.length; i += 1) {
          const n = names[i];
          if (typeof n === 'string' && n) env.properties[n] = args[i];
        }
      }
      return src ?? there;
    }
    const name = src instanceof EnvElement || src instanceof ThereElement
      ? (src as { type: string }).type
      : asStateName(src);
    // `what << $el` / `h << $hours`: bind the given value locally.
    if (p !== undefined) {
      env.properties[name] = p;
      return p;
    }
    // `name <<`: pull the nearest property (then resource) of that name in.
    let e: EnvElement | undefined = env.parent;
    while (e) {
      if (Object.prototype.hasOwnProperty.call(e.properties, name)) {
        env.properties[name] = e.properties[name];
        return e.properties[name];
      }
      e = e.parent;
    }
    if (name in env.resources && env.resources[name] !== undefined) {
      env.properties[name] = env.resources[name];
      return env.resources[name];
    }
    return src;
  },
};

const opExport: GlobalDef = {
  name: '>>',
  arity: 1,
  fn: (source, params, there, env) => {
    const src = unwrapSeq(source);
    const p = unwrapSeq(params[0]);
    if (p === undefined) {
      // `a >>;` — push a copy onto the call's returns (multi-return).
      const copy = src && typeof (src as { extend?: unknown }).extend === 'function'
        ? (src as { extend: () => unknown }).extend()
        : src;
      env.returns.push(copy);
      return src;
    }
    // `a >> name;` — publish into the parent env under that name.
    const target = env.parent ?? there;
    target.properties[asStateName(p)] = src;
    return src;
  },
};

const opRequire: GlobalDef = {
  name: '@',
  arity: 1,
  fn: async (source, params, there, env, ev) => {
    const p = unwrapSeq(params[0]);
    const moduleName = asStateName(p);
    const mod = await ev.loadModule(moduleName);
    const src = unwrapSeq(source);
    const bindName = src instanceof ThereElement && src.states.length === 0 && src.type !== moduleName
      ? src.type
      : moduleName;
    env.properties[bindName] = mod;
    // Evaluating the module-name word created a stray fresh element under
    // the module's own name — replace it so `utils . lower` works too.
    const stray = env.properties[moduleName];
    if (stray instanceof ThereElement && stray.states.length === 0) {
      env.properties[moduleName] = mod;
    }
    return mod;
  },
};

// ── type conversions ─────────────────────────────────────────────────────────
// Value-only: a bare type word after an operator stays a probe
// (`$words ? list`); with a value-shaped argument it converts
// (`a = number '12'`). Zero-arg form returns an element named after the type.

function conversionGlobal(name: string, convert: (v: unknown, ev: Evaluator) => unknown): GlobalDef {
  return {
    name,
    arity: 1,
    valueOnly: true,
    fn: (_source, params, _there, _env, ev) => {
      if (params.length === 0) return new ThereElement(name);
      return convert(unwrapSeq(params[0]), ev);
    },
  };
}

function tokensOfCompound(v: unknown): Token | undefined {
  if (v instanceof VectorElement) return v.body.block?.getSequence?.();
  if (v instanceof SequenceWrapper) return v.head;
  if (v instanceof SeqValue) return v.head;
  return undefined;
}

/** Render a runtime value back to surface *code* so a list of tokens can
 *  become an executable sequence/block (`block ['plum' '+' 'red']` →
 *  `{ plum + red }`). A string that is a clean bare token is emitted raw (so
 *  it parses as a word/operator); anything with spaces or quotes is requoted
 *  as a string literal. */
function itemToCode(v: unknown): string {
  const bare = (s: string): string =>
    /^\S+$/.test(s) && !s.includes("'") && !s.includes('"') && !s.includes('`')
      ? s
      : `'${s.replace(/'/g, "\\'")}'`;
  if (v instanceof StringElement) return bare(v.val);
  if (typeof v === 'string') return bare(v);
  if (v instanceof NumberElement) return String(v.val);
  if (typeof v === 'number') return String(v);
  return toStr(v);
}

function compoundToList(v: unknown): ListElement | null {
  const head = tokensOfCompound(v);
  if (!head) return null;
  const out = new ListElement();
  let cur: Token | undefined = head;
  while (cur) {
    if (cur.type !== 'switch') out.is(new StringElement(String(cur.value)));
    cur = cur.next;
  }
  return out;
}

function valuesToTokens(items: unknown[], ev: Evaluator): Token | undefined {
  const src = items.map(itemToCode).join(' ');
  return ev.parseFragment(src);
}

const convNumber = conversionGlobal('number', (v) => new NumberElement(toNum(v)));
const convString = conversionGlobal('string', (v) => new StringElement(toStr(v)));
const convElement = conversionGlobal('element', (v) => new ThereElement(asStateName(v)));

const convList = conversionGlobal('list', (v) => {
  if (v instanceof ListElement) return new ListElement([...v.states]);
  if (v instanceof TableElement) {
    return new ListElement(v.rows().map((r) => new ListElement(Object.values(r))));
  }
  const fromCompound = compoundToList(v);
  if (fromCompound) return fromCompound;
  if (Array.isArray(v)) return new ListElement([...v]);
  return new ListElement([v]);
});

const convSequence = conversionGlobal('sequence', (v, ev) => {
  if (v instanceof SeqValue) return v;
  if (v instanceof SequenceWrapper) return v;
  if (v instanceof VectorElement) {
    return new SequenceWrapper(v.body.block?.getSequence?.());
  }
  const items = v instanceof ListElement ? v.states : Array.isArray(v) ? v : [v];
  return new SequenceWrapper(valuesToTokens(items, ev));
});

const convBlock = conversionGlobal('block', (v, ev) => {
  if (v instanceof VectorElement) return v;
  let head: Token | undefined;
  if (v instanceof SequenceWrapper) head = v.head;
  else if (v instanceof SeqValue) head = v.head;
  else {
    const items = v instanceof ListElement ? v.states : Array.isArray(v) ? v : [v];
    head = valuesToTokens(items, ev);
  }
  const blockTok: Token = { type: 'block', value: '', line: 0, position: 0 };
  blockTok.getSequence = () => head;
  return new VectorElement('vector', { block: blockTok });
});

const convScope = conversionGlobal('scope', (v) => {
  const env = new EnvElement('scope');
  const name = v && typeof v === 'object' ? (v as { type?: string }).type ?? asStateName(v) : asStateName(v);
  env.properties[name] = v;
  return env;
});

const opMode: GlobalDef = {
  name: 'mode',
  arity: 2,
  fn: (source, params, there, env) => {
    const name = String(asStateName(params[0]));
    const flag = String(asStateName(params[1]));
    env.modes[name] = flag === 'on';
    return source;
  },
};

const printResource: ResourceDef = {
  __resource: true,
  arity: 0,
  fn: async (source, _params, there) => {
    const v = await resolveLazy(unwrapSeq(source));
    if (v == null) there.out('null');
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') there.out(String(v));
    else there.out(toStr(v));
    return source;
  },
};

const printDebugResource: ResourceDef = {
  __resource: true,
  arity: 0,
  fn: (source, _params, there) => {
    there.out(JSON.stringify(source));
    return source;
  },
};

const errorResource: ResourceDef = {
  __resource: true,
  arity: 0,
  fn: (source, _params, there) => {
    const o = source as { value?: () => unknown };
    if (o && typeof o.value === 'function') there.out(String(o.value()), 1);
    else there.out(JSON.stringify(source), 1);
    return source;
  },
};

const timeResource: ResourceDef = {
  __resource: true,
  arity: 0,
  fn: () => new NumberElement(Date.now()),
};

export function buildDefaultFacet(): FacetSetup {
  return {
    globals: [
      opIs, opNot, opSize, opIsNot, opGet, opRest, opEq, opExtend, opReduce,
      opHas, opHasNot, opHasQ, opHasQN,
      opAssign, opGlobal, opEach, opElse, opContinuation, opConstructor, opMode, opVal,
      opImport, opExport, opRequire,
      convNumber, convString, convElement, convList, convSequence, convBlock, convScope,
      ...historyGlobals,
    ],
    resources: {
      print: printResource,
      'print?': printDebugResource,
      error: errorResource,
      time: timeResource,
    },
  };
}

export const defaultParserFacet = {
  aliases: defaultAliases,
  phrases: defaultPhrases,
};
