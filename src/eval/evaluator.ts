import type { Token } from '../parse/token.ts';
import { parse } from '../parse/parse.ts';
import {
  EnvElement, ThereEnv, ThereElement, StringElement, NumberElement, ListElement,
  TableElement, VectorElement, asStateName,
  type Element, type Continuation, type ConstructorEntry,
} from '../runtime/types.ts';

export interface GlobalDef {
  name: string;
  arity?: number;
  /** Only consume params that are value-shaped tokens (see isValueToken).
   *  Used by type conversions so they double as type-name probes. */
  valueOnly?: boolean;
  fn: (source: unknown, params: unknown[], there: ThereEnv, env: EnvElement, ev: Evaluator, cursor: Cursor) => unknown | Promise<unknown>;
}

export interface ResourceDef {
  __resource: true;
  fn?: (source: unknown, params: unknown[], there: ThereEnv, env: EnvElement, ev: Evaluator) => unknown | Promise<unknown>;
  arity?: number;
  value?: unknown;
}

export interface FacetSetup {
  globals: GlobalDef[];
  resources: Record<string, ResourceDef>;
  defaultInput?: string;
}

export interface Cursor { token: Token | undefined; }

function isResourceDef(x: unknown): x is ResourceDef {
  if (!x || typeof x !== 'object') return false;
  const o = x as { __resource?: unknown; fn?: unknown; arity?: unknown };
  return o.__resource === true;
}

export class SequenceWrapper {
  head: Token | undefined;
  constructor(head: Token | undefined) { this.head = head; }
}

export class SeqValue {
  inner: unknown;
  head: Token | undefined;
  env: EnvElement;
  constructor(inner: unknown, head: Token | undefined, env: EnvElement) {
    this.inner = inner;
    this.head = head;
    this.env = env;
  }
}

/**
 * Numeric or alpha range produced by `(a .. b)` / `(a .. b step)`.
 * Capped at 1000 iterations as a safety per SPEC § 4.7.
 */
export class RangeValue {
  start: number;
  end: number;
  step: number;
  alpha: boolean;

  constructor(start: number, end: number, step: number, alpha: boolean) {
    this.start = start;
    this.end = end;
    this.step = step;
    this.alpha = alpha;
  }

  values(): unknown[] {
    const out: unknown[] = [];
    const cap = 1000;
    if (this.alpha) {
      for (let v = this.start, n = 0; v <= this.end && n < cap; v += this.step, n += 1) {
        out.push(String.fromCharCode(v));
      }
    } else {
      for (let v = this.start, n = 0; v <= this.end && n < cap; v += this.step, n += 1) {
        out.push(v);
      }
    }
    return out;
  }
}

async function tryParseRange(
  head: Token | undefined,
  env: EnvElement,
  ev: Evaluator,
): Promise<RangeValue | null> {
  if (!head || !head.next) return null;
  const second = head.next;
  if (second.type !== 'word' || second.value !== '..') return null;
  const endTok = second.next;
  if (!endTok) return null;

  const startRaw = await resolveRangeBound(head, env, ev);
  const endRaw = await resolveRangeBound(endTok, env, ev);
  if (startRaw == null || endRaw == null) return null;

  const stepTok = endTok.next;
  let step = 1;
  if (stepTok) {
    const s = await resolveRangeBound(stepTok, env, ev);
    if (typeof s === 'number') step = s;
  }

  if (typeof startRaw === 'number' && typeof endRaw === 'number') {
    return new RangeValue(startRaw, endRaw, step, false);
  }
  if (typeof startRaw === 'string' && typeof endRaw === 'string') {
    return new RangeValue(startRaw.charCodeAt(0), endRaw.charCodeAt(0), step, true);
  }
  return null;
}

async function resolveRangeBound(
  tok: Token,
  env: EnvElement,
  ev: Evaluator,
): Promise<number | string | null> {
  if (tok.type === 'number') return Number(tok.value);
  if (tok.type === 'word' && /^[A-Za-z]$/.test(String(tok.value))) return String(tok.value);
  if (tok.type === 'resource') {
    const cursor: Cursor = { token: tok };
    const v = await ev.step(cursor, env, undefined, false);
    const inner = unwrapSeq(v);
    if (inner instanceof NumberElement) return inner.val;
    if (inner instanceof StringElement) return inner.val;
    if (typeof inner === 'number' || typeof inner === 'string') return inner;
  }
  return null;
}

export { tryParseRange };

export function unwrapSeq(v: unknown): unknown {
  while (v instanceof SeqValue) v = v.inner;
  return v;
}

/**
 * Force-evaluate a lazy `_val` thunk and return its fresh result, updating
 * the eager `_valCache` so sync stringify/numberOf paths see the new value
 * too. Recurses if the result itself has `_val`.
 *
 * Operators that want true `~` laziness (per SPEC § 4.10) call this at
 * entry on their source and params.
 */
export async function resolveLazy(v: unknown): Promise<unknown> {
  if (!v || typeof v !== 'object') return v;
  const o = v as { _val?: unknown; _valCache?: unknown };
  if (typeof o._val === 'function') {
    const fresh = await (o._val as () => unknown | Promise<unknown>)();
    o._valCache = fresh;
    return await resolveLazy(fresh);
  }
  if ('_val' in o && o._val !== undefined) {
    return await resolveLazy(o._val);
  }
  return v;
}

export interface IterationMarker { _ft: boolean; value?: unknown; }

export function isIterMarker(x: unknown): x is IterationMarker {
  return !!x && typeof x === 'object' && '_ft' in (x as Record<string, unknown>);
}

export class Evaluator {
  there: ThereEnv;
  facet: FacetSetup;
  /** Set by `resolveWord`; consumed by `=` so warnings name the LHS by its
   *  source-text identifier, not the looked-up value's `.type`. */
  lastWordName = '';
  /** The LHS identifier captured by callGlobal before params were evaluated;
   *  read by `=` / `=>` as the assignment target. */
  assignName = '';
  /** Names whose constructors are currently running. Blocks recursive
   *  re-entry so `(book) : { a red green }` where `a` references `book`
   *  doesn't loop — the inner `book` lookup falls through to fresh-element. */
  instantiating = new Set<string>();
  /** Stack of named-vector bodies currently executing. History entries are
   *  tagged with these so `el forget verb` can revert a verb's effects. */
  frameNames: string[] = [];
  /** Base directory for module resolution (`@`); set by the CLI. */
  baseDir: string = '.';
  /** Pluggable module loader installed by src/facet/modules.ts — keeps the
   *  evaluator free of fs/parser imports. */
  moduleLoader?: (name: string, ev: Evaluator) => Promise<ThereEnv>;
  /** Sequence counter grouping history entries by root operation. */
  historySeq = 0;
  /** When set, recorded entries share this seq (one `learn` group). */
  historyForcedSeq?: number;
  /** True while history itself replays/reverts effects — suppresses recording. */
  historyMuted = false;

  async loadModule(name: string): Promise<ThereEnv> {
    if (!this.moduleLoader) throw new Error(`Module loading is not available here (requiring ${name})`);
    return await this.moduleLoader(name, this);
  }

  /** Parse a source fragment into a token chain (used by the `sequence` /
   *  `block` conversions to turn runtime values back into executable code). */
  parseFragment(src: string): Token | undefined {
    return parse(src, { aliases: {}, phrases: [] }).head;
  }

  constructor(there: ThereEnv, facet: FacetSetup) {
    this.there = there;
    this.facet = facet;
    for (const g of facet.globals) there.globals[g.name] = g;
    for (const [name, def] of Object.entries(facet.resources)) {
      there.resources[name] = def;
    }
  }

  async run(head: Token | undefined, resourceNames: string[] = []): Promise<unknown> {
    await this.resourceCheck(resourceNames);
    return await this.walk(head, this.there, this.there);
  }

  async resourceCheck(names: string[]): Promise<void> {
    for (const name of names) {
      if (!name) continue;
      if (/^\d+$/.test(name)) continue;            // positional slots
      if (name in this.there.resources) continue;  // already known
      // Scripted runs can preseed an answer for every prompt (SPEC § 5.2);
      // otherwise ask interactively.
      if (this.facet.defaultInput !== undefined) {
        this.there.resources[name] = new StringElement(this.facet.defaultInput);
        continue;
      }
      const answer = await new Promise<string>((resolve) => {
        this.there.ask(`Enter the value for [${name}]: `, resolve);
      });
      this.there.resources[name] = new StringElement(answer);
    }
  }

  async walk(head: Token | undefined, env: EnvElement, source: unknown): Promise<unknown> {
    const cursor: Cursor = { token: head };
    let result: unknown = source;
    while (cursor.token) {
      result = await this.step(cursor, env, result);
    }
    return result;
  }

  async step(cursor: Cursor, env: EnvElement, prior: unknown, silent = false): Promise<unknown> {
    const tok = cursor.token!;
    cursor.token = tok.next;

    switch (tok.type) {
      case 'switch':
        // Soft separator — evaluation passes through unchanged, so a vector
        // body ending in `;` still returns its last real value.
        return prior ?? this.there;
      case 'string':
        return new StringElement(String(tok.value));
      case 'template':
        return new StringElement(await this.interpolateTemplate(tok, env));
      case 'number':
        return new NumberElement(Number(tok.value));
      case 'resource':
        return await this.resolveResource(String(tok.value), cursor, env, prior, silent);
      case 'word':
        return await this.resolveWord(String(tok.value), cursor, env, prior, silent);
      case 'list': {
        const head = tok.getSequence?.();
        const list = new ListElement();
        let inner = head;
        while (inner) {
          const c: Cursor = { token: inner };
          const v = await this.step(c, env, undefined, true);
          if (c.token === inner) c.token = inner.next; // safety: always advance
          list.is(unwrapSeq(v));
          inner = c.token;
        }
        return list;
      }
      case 'sequence': {
        const head = tok.getSequence?.();
        // Operators that consume the sequence's raw tokens (not its value):
        // `...` (continuations, reads vector/target/effect names) and
        // `:` (constructor, reads the name). Pass through unevaluated.
        if (cursor.token && cursor.token.type === 'word' &&
            (cursor.token.value === '...' || cursor.token.value === ':')) {
          return new SequenceWrapper(head);
        }
        const range = await tryParseRange(head, env, this);
        if (range) return range;
        const value = await this.walk(head, env, env);
        return new SeqValue(value, head, env);
      }
      case 'block': {
        const vec = new VectorElement('vector', { block: tok });
        vec.defEnv = env;
        const next = cursor.token;
        // A `(…)` after a block is its parser spec — UNLESS that sequence is
        // itself a constructor name or continuation target (`(b) : {…}`,
        // `(x) ... {…}`), i.e. the start of the next statement. Without a `;`
        // separator the two are adjacent, so peek past the sequence: a
        // following `:` / `...` means it belongs to that statement, not here.
        const after = next?.next;
        const isNextStmtTarget = !!after && after.type === 'word'
          && (after.value === ':' || after.value === '...');
        if (next && next.type === 'sequence' && !isNextStmtTarget) {
          // Per SPEC § 4.5: if the spec's first token is a number, that's
          // an arity hint (consume N positional params unevaluated-as-slots).
          // Otherwise build a parser spec from $name slots.
          const specHead = next.getSequence?.();
          if (specHead && specHead.type === 'number') {
            vec.arity = Number(specHead.value);
          } else {
            vec.body.parserSpec = next;
          }
          cursor.token = next.next;
        }
        return vec;
      }
      case 'table': {
        const head = tok.getSequence?.();
        const cols: string[] = [];
        let cur = head;
        while (cur) {
          cols.push(String(cur.value));
          cur = cur.next;
        }
        return new TableElement(cols);
      }
    }
    return prior;
  }

  isAutoReadOn(env: EnvElement): boolean {
    if (env.modes['auto-read']) return true;
    let e: EnvElement | undefined = env.parent;
    while (e) { if (e.modes['auto-read']) return true; e = e.parent; }
    return !!this.there.modes['auto-read'];
  }

  // The env that owns the auto-read counter — closest one that has the
  // positional slots in its own resources (the bodyEnv of the current call).
  autoReadOwner(env: EnvElement): EnvElement {
    let e: EnvElement | undefined = env;
    while (e) {
      if (Object.prototype.hasOwnProperty.call(e.resources, '1')) return e;
      e = e.parent;
    }
    return env;
  }

  async resolveResource(name: string, cursor: Cursor, env: EnvElement, prior: unknown, _silent: boolean): Promise<unknown> {
    const lookup = (n: string): unknown => {
      if (n in env.resources && env.resources[n] !== undefined) return env.resources[n];
      let e: EnvElement | undefined = env.parent;
      while (e) {
        if (n in e.resources && e.resources[n] !== undefined) return e.resources[n];
        e = e.parent;
      }
      if (n in this.there.resources) return this.there.resources[n];
      // Per original valueOrEval: a resource $name with no resource binding
      // falls back to a property of the same name (so `a = 1; $a $print`
      // works after the assignment).
      if (n in env.properties && (env.properties as Record<string, unknown>)[n] !== undefined) {
        return (env.properties as Record<string, unknown>)[n];
      }
      return undefined;
    };
    let item = lookup(name);
    if (item === undefined && this.isAutoReadOn(env) && !/^\d+$/.test(name)) {
      // Allocate the next positional slot in the current env to this name.
      const owner = this.autoReadOwner(env);
      const idx = String(owner._autoReadIdx);
      const positional = lookup(idx);
      if (positional !== undefined) {
        owner.resources[name] = positional;
        owner._autoReadIdx += 1;
        item = positional;
      }
    }
    if (item === undefined) throw new Error(`Undefined resource:${name}`);
    // SPEC § 4.16: a resource holding a vector is called like any operator
    // (`$block` in the where runner, `$next` passed as a block param, …).
    if (item instanceof VectorElement && item.body.block && !_silent) {
      return await this.callVector(item, prior, cursor, env);
    }
    if (isResourceDef(item)) {
      const def = item;
      if (typeof def.fn === 'function') {
        const arity = def.arity ?? 0;
        const params: unknown[] = [];
        for (let p = 0; p < arity; p += 1) {
          if (!cursor.token || cursor.token.type === 'switch') break;
          params.push(await this.step(cursor, env, prior, false));
        }
        return await def.fn(prior, params, this.there, env, this);
      }
      if ('value' in def) return def.value;
    }
    return item;
  }

  async resolveWord(name: string, cursor: Cursor, env: EnvElement, prior: unknown, silent: boolean): Promise<unknown> {
    if (name === 'there') return this.there;

    // Lookup chain. In silent contexts (list iteration, peeks), operator
    // names should be treated as literal words, not the global operator.
    let item: unknown;
    let fromGlobal = false;
    if (name in env.properties) item = env.properties[name];
    else if (!silent) {
      // Globals resolve against the env chain's root `there` first, so a
      // module's vector body sees the module's own globals (`=>` definitions
      // and inline-facet host globals). The ambient evaluator `there` is the
      // fallback, so a body running inside another module via `$env{m}` can
      // still reach the globals from where it was defined.
      const g = (this.rootGlobals(env)[name] ?? this.there.globals[name]) as GlobalDef | undefined;
      if (g) { item = g; fromGlobal = true; }
    }
    if (item === undefined && !this.instantiating.has(name)) {
      const ctor = env.constructors[name];
      if (ctor) {
        if (ctor.cache && ctor.cached !== undefined) {
          item = ctor.cached;
        } else {
          const inst = await this.instantiateConstructor(ctor);
          if (ctor.cache) ctor.cached = inst;
          item = inst;
        }
        // SPEC § 4.13: `(?name)` constructors are never cached — each use
        // re-runs the block, so don't pin the product into properties.
        if (ctor.cache) env.properties[name] = item;
      }
    }
    if (item === undefined) {
      const fresh = new ThereElement(name);
      env.properties[name] = fresh;
      item = fresh;
    }

    if (!silent) {
      // A `=>` global is stored as a VectorElement in both properties and
      // globals — always call it as a vector. Operator/host globals are
      // GlobalDefs with an `fn`.
      if (item instanceof VectorElement) return await this.callVector(item, prior, cursor, env);
      if (fromGlobal) return await this.callGlobal(item as GlobalDef, prior, cursor, env);
      // Non-callable lookup: this is the source-text identifier the user
      // wrote. Stash it so an immediately-following `=` can warn with the
      // right name on a reassignment attempt.
      this.lastWordName = name;
    }
    return item;
  }

  async callGlobal(g: GlobalDef, source: unknown, cursor: Cursor, env: EnvElement): Promise<unknown> {
    // The identifier the LHS word resolved from, captured *before* params are
    // evaluated (evaluating the RHS clobbers lastWordName). Re-stamped right
    // before fn runs so `=` / `=>` see the real target name.
    const lhsName = this.lastWordName;
    const arity = g.arity ?? 1;
    const params: unknown[] = [];
    for (let p = 0; p < arity; p += 1) {
      if (!cursor.token || cursor.token.type === 'switch') break;
      if (g.valueOnly && !this.isValueToken(cursor.token, env)) break;
      const next = await this.step(cursor, env, source, false);
      params.push(next);
    }
    this.assignName = lhsName;
    let result = await g.fn(source, params, this.there, env, this, cursor);
    await this.fireOperatorContinuations(g.name, source, params);
    result = await this.maybeChain(result, cursor, env);
    return result;
  }

  /** Can the upcoming token serve as a *value* argument? Used by value-only
   *  globals (the type conversions) so a bare type-probe word after `?` —
   *  `$words ? list` — is not swallowed as a conversion argument. */
  isValueToken(tok: Token, env: EnvElement): boolean {
    if (tok.type === 'switch') return false;
    if (tok.type !== 'word') return true;
    const name = String(tok.value);
    if (name === 'there') return false;
    if (this.rootGlobals(env)[name]) return false;
    if (name in env.properties) return true;
    if (env.constructors[name]) return true;
    return false;
  }

  rootGlobals(env: EnvElement): Record<string, unknown> {
    let e: EnvElement = env;
    while (e.parent) e = e.parent;
    if (e instanceof ThereEnv) return e.globals;
    return this.there.globals;
  }

  async callVector(vec: VectorElement, source: unknown, cursor: Cursor, callerEnv: EnvElement): Promise<unknown> {
    const consumed = await this.consumeVectorParams(vec, source, cursor, callerEnv);
    if (consumed === null) return source;
    let result = await this.invokeVectorBody(vec, source, consumed.names, consumed.params, {});
    await this.fireVectorContinuations(vec, source);
    result = await this.maybeChain(result, cursor, callerEnv);
    return result;
  }

  /** SPEC § 4.3 step 6: a callable result with value tokens still pending
   *  continues the call chain (`Anagram 'x' . matches ['a' 'b']` — `matches`
   *  comes back from `.` as a vector and is immediately applied to the list). */
  async maybeChain(result: unknown, cursor: Cursor, env: EnvElement): Promise<unknown> {
    while (
      result instanceof VectorElement && result.body.block &&
      cursor.token && cursor.token.type !== 'switch' && cursor.token.type !== 'word'
    ) {
      result = await this.callVector(result, undefined, cursor, env);
    }
    return result;
  }

  async invokeFully(vec: VectorElement, source: unknown, extras: Record<string, unknown>): Promise<unknown> {
    const emptyCursor: Cursor = { token: undefined };
    const consumed = await this.consumeVectorParams(vec, source, emptyCursor, vec.defEnv ?? this.there);
    if (consumed === null) return source;
    return await this.invokeVectorBody(vec, source, consumed.names, consumed.params, extras);
  }

  async consumeVectorParams(
    vec: VectorElement,
    _source: unknown,
    cursor: Cursor,
    callerEnv: EnvElement,
  ): Promise<{ names: string[]; params: unknown[] } | null> {
    let spec = vec.body.parserSpec;
    let arity = vec.arity;
    // SPEC § 4.3 step 1: a vector without its own spec accepts one at the
    // call site — `color ($apple) apple`. A leading number means arity.
    // Ranges (`(1 .. 5)`) are positional args, not specs.
    if (!spec && arity === undefined && cursor.token && cursor.token.type === 'sequence') {
      const head = cursor.token.getSequence?.();
      const isRange = head?.next?.type === 'word' && head.next.value === '..';
      if (head && !isRange) {
        if (head.type === 'number') arity = Number(head.value);
        else spec = cursor.token;
        cursor.token = cursor.token.next;
      }
    }
    if (spec) {
      const initial = cursor.token;
      const head = spec.getSequence?.();
      const result = await this.processParserSpec(head, cursor, callerEnv, vec.defEnv ?? this.there);
      // SPEC § 4.5: failed match → vector call is a no-op, cursor restored.
      if (result === null) cursor.token = initial;
      return result;
    }
    if (arity !== undefined) {
      const params: unknown[] = [];
      for (let i = 0; i < arity; i += 1) {
        if (!cursor.token || cursor.token.type === 'switch') break;
        params.push(await this.step(cursor, callerEnv, undefined, false));
      }
      return { names: [], params };
    }
    // defaultParams: consume tokens until ; or end
    const params: unknown[] = [];
    while (cursor.token && cursor.token.type !== 'switch') {
      params.push(await this.step(cursor, callerEnv, undefined, false));
    }
    return { names: [], params };
  }

  async invokeVectorBody(
    vec: VectorElement,
    source: unknown,
    names: string[],
    params: unknown[],
    extraResources: Record<string, unknown>,
  ): Promise<unknown> {
    let defEnv = vec.defEnv ?? this.there;
    // SPEC § 7: `$env{...}` slot in the parser spec replaces the body's env
    // with the captured one (the body runs *inside* that env). Used by
    // module-aware vectors (`f = { ... } ($env{module})`).
    const envIdx = names.indexOf('env');
    if (envIdx >= 0) {
      const v = params[envIdx];
      if (v instanceof EnvElement) defEnv = v;
    }
    const bodyEnv = new EnvElement(vec.type ?? 'vector', defEnv);
    if (source !== undefined) bodyEnv.resources['el'] = source;
    bodyEnv.resources['args'] = params;
    bodyEnv.resources['argNames'] = names;
    for (let i = 0; i < params.length; i += 1) {
      const n = names[i];
      if (n && params[i] !== undefined) bodyEnv.resources[n] = params[i];
      if (params[i] !== undefined) bodyEnv.resources[String(i + 1)] = params[i];
    }
    for (const [k, v] of Object.entries(extraResources)) {
      if (v !== undefined) bodyEnv.resources[k] = v;
    }
    if (vec.body.fn) {
      return await vec.body.fn(source as Element | null, params, this.there, names);
    }
    const blockTok = vec.body.block;
    const head = blockTok?.getSequence?.();
    const frame = vec.type && vec.type !== 'vector' ? vec.type : undefined;
    if (frame) this.frameNames.push(frame);
    let result: unknown;
    try {
      result = await this.walk(head, bodyEnv, source);
    } finally {
      if (frame) this.frameNames.pop();
    }
    if (bodyEnv.returns.length > 0) {
      // Multi-return: several `>>` exports come back as a list the caller can
      // index (`gen * 0`) or iterate; a single export is returned bare.
      return bodyEnv.returns.length === 1
        ? bodyEnv.returns[0]
        : new ListElement([...bodyEnv.returns]);
    }
    // A body whose last statement evaluates to the shared `there` hands back
    // the call's own env instead, so callers can reach the body's bindings
    // (`Anagram 'x' . matches …`) and its `~` value.
    if (result === this.there) return bodyEnv;
    // A body ending in an if/else chain returns the taken branch's value.
    if (isIterMarker(result) && result.value !== undefined) return result.value;
    return result;
  }

  async processParserSpec(
    specHead: Token | undefined,
    cursor: Cursor,
    callerEnv: EnvElement,
    defEnv: EnvElement,
  ): Promise<{ names: string[]; params: unknown[] } | null> {
    interface Slot {
      name: string;
      defaultBlock?: Token;
      closure?: boolean;
      wildcard?: boolean;
      /** Regex-match the upcoming token's value, consume it (no capture). */
      regex?: string;
    }
    const slots: Slot[] = [];
    let cur = specHead;
    while (cur) {
      if (cur.type === 'resource') {
        const raw = String(cur.value);
        const closure = raw.startsWith('$');
        const name = closure ? raw.slice(1) : raw;
        const slot: Slot = { name, closure };
        if (cur.next && cur.next.type === 'block') {
          slot.defaultBlock = cur.next;
          cur = cur.next;
        }
        slots.push(slot);
      } else if (cur.type === 'word' && cur.value === '*') {
        slots.push({ name: '__wild', wildcard: true });
      } else if (cur.type === 'word' || cur.type === 'list') {
        // SPEC § 4.5: a non-`*` word (or a list like `[a|b|]`) regex-matches
        // the upcoming token's value. Mismatch fails the parse (vector call
        // is a no-op).
        slots.push({ name: '__regex', regex: String(cur.value) });
      }
      cur = cur.next;
    }
    const names: string[] = [];
    const params: unknown[] = [];
    for (const slot of slots) {
      if (slot.regex !== undefined) {
        if (!cursor.token || cursor.token.type === 'switch') return null;
        let re: RegExp;
        try { re = new RegExp(slot.regex); } catch { return null; }
        if (!re.test(String(cursor.token.value))) return null;
        cursor.token = cursor.token.next;  // consume the matched token
        continue;
      }
      let value: unknown;
      if (slot.closure) {
        // $$name — capture by VALUE at definition time (clone via .extend()
        // so subsequent mutations to the source don't bleed into the
        // captured binding). Matches the original's `paramValue(_, _, true)`.
        if (slot.name in defEnv.resources) value = defEnv.resources[slot.name];
        else value = (defEnv.properties as Record<string, unknown>)[slot.name];
        if (value && typeof (value as { extend?: unknown }).extend === 'function') {
          value = (value as { extend: () => unknown }).extend();
        }
      } else if (slot.defaultBlock) {
        // `$name{block}` slots never consume call-site tokens — the block is
        // the binding, evaluated in the defining env at invocation time
        // (`($me{$el})` carries the current iteration's el into the body).
        const head = slot.defaultBlock.getSequence?.();
        value = await this.walk(head, defEnv, defEnv);
      } else if (cursor.token && cursor.token.type !== 'switch') {
        value = await this.step(cursor, callerEnv, undefined, false);
      }
      if (!slot.wildcard) {
        names.push(slot.name);
        params.push(value);
      }
    }
    return { names, params };
  }

  async instantiateConstructor(ctor: ConstructorEntry): Promise<unknown> {
    this.instantiating.add(ctor.type);
    try {
      const vec = ctor.vector as VectorElement;
      const defEnv = vec.defEnv ?? ctor.defEnv;
      // Honor the declaration's parser spec with no call-site tokens: only
      // closure slots and `$name{block}` defaults bind —
      // `(same) : { … } ($candidate{$el})` captures the current $el.
      const emptyCursor: Cursor = { token: undefined };
      const consumed = await this.consumeVectorParams(vec, undefined, emptyCursor, defEnv);
      const fork = new EnvElement(ctor.type, defEnv);
      if (consumed) {
        for (let i = 0; i < consumed.params.length; i += 1) {
          const n = consumed.names[i];
          if (n && consumed.params[i] !== undefined) fork.resources[n] = consumed.params[i];
          if (consumed.params[i] !== undefined) fork.resources[String(i + 1)] = consumed.params[i];
        }
      }
      const head = vec.body.block?.getSequence?.();
      const result = await this.walk(head, fork, fork);
      if (result === undefined || result === fork || result === this.there) return fork;
      if (isIterMarker(result) && result.value !== undefined) return result.value;
      return result;
    } finally {
      this.instantiating.delete(ctor.type);
    }
  }

  /** Continuations after an operator call: `(- * healthy) ... { … }` fires
   *  when `-` runs with a param matching `healthy` on a matching target. */
  async fireOperatorContinuations(vectorName: string, source: unknown, params: unknown[]): Promise<void> {
    const matched = this.there.continuations.filter((c) => {
      if (c.vectorName !== vectorName && c.vectorName !== '*') return false;
      if (!this.continuationTargetMatches(c, source)) return false;
      // SPEC § 4.6: effect matches by name equality OR by isOf — the param
      // is an element that has the effect as a state (or as its own type).
      return params.some((p) => {
        if (asStateName(p) === c.effect) return true;
        if (p && typeof p === 'object') {
          const o = p as Partial<Element>;
          if (typeof o.size === 'function') {
            try { return o.size(c.effect) > 0; } catch { return false; }
          }
        }
        return false;
      });
    });
    for (const c of matched) await this.runContinuation(c, source, params);
  }

  /** Continuations after a *named vector* call: `(plum color) ... { … }`
   *  fires when the vector named `color` is invoked on a matching target. */
  async fireVectorContinuations(vec: VectorElement, source: unknown): Promise<void> {
    if (!vec.type || vec.type === 'vector') return;
    const matched = this.there.continuations.filter(
      (c) => c.effect === vec.type && this.continuationTargetMatches(c, source),
    );
    for (const c of matched) await this.runContinuation(c, source, []);
  }

  continuationTargetMatches(c: Continuation, source: unknown): boolean {
    if (c.target === '*') return true;
    const targetType = source && typeof source === 'object' ? (source as { type?: string }).type ?? '' : '';
    return c.target === targetType;
  }

  async runContinuation(c: Continuation, source: unknown, params: unknown[]): Promise<void> {
    const env = new EnvElement('continuation', c.defEnv);
    env.resources['el'] = source;
    env.resources['args'] = params;
    env.resources['1'] = params[0];
    const head = c.block.getSequence?.();
    await this.walk(head, env, source);
  }

  /** SPEC § 4.7: a sequence of plain words/literals — `(red blue green)` —
   *  is an enumeration: `_` iterates its items. Anything containing an
   *  operator, resource, or compound is a computation; `_` consumes its
   *  evaluated value instead (`($el is? healthy) _ { … }` loops N times). */
  async enumerateSeq(seq: SeqValue): Promise<unknown[] | null> {
    let cur = seq.head;
    let count = 0;
    const globals = this.rootGlobals(seq.env);
    while (cur) {
      if (cur.type === 'switch') { cur = cur.next; continue; }
      if (cur.type !== 'word' && cur.type !== 'string' && cur.type !== 'number') return null;
      if (cur.type === 'word') {
        const v = String(cur.value);
        if (v === 'there' || v === '..' || globals[v]) return null;
      }
      count += 1;
      cur = cur.next;
    }
    if (count < 2) return null;
    const items: unknown[] = [];
    cur = seq.head;
    while (cur) {
      if (cur.type === 'switch') { cur = cur.next; continue; }
      const c: Cursor = { token: cur };
      items.push(await this.step(c, seq.env, undefined, true));
      cur = c.token;
    }
    return items;
  }

  async interpolateTemplate(tok: Token, env: EnvElement): Promise<string> {
    const raw = String(tok.raw ?? tok.value);
    let out = '';
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i]!;
      if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1]!;
        if (next === 'n') { out += '\n'; i += 2; continue; }
        if (next === 't') { out += '\t'; i += 2; continue; }
        if (next === 'r') { out += '\r'; i += 2; continue; }
        if (next === '\\') { out += '\\'; i += 2; continue; }
        if (next === '`') { out += '`'; i += 2; continue; }
        out += next; i += 2; continue;
      }
      if (ch === '$' && raw[i + 1] === '{') {
        let depth = 1;
        let j = i + 2;
        let body = '';
        while (j < raw.length) {
          const c2 = raw[j]!;
          if (c2 === '{') depth += 1;
          else if (c2 === '}') { depth -= 1; if (depth === 0) break; }
          body += c2;
          j += 1;
        }
        const v = this.evalJsBody(body, env);
        out += v === undefined || v === null ? '' : String(v);
        i = j + 1;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  evalJsBody(body: string, env: EnvElement): unknown {
    const names: string[] = [];
    const values: unknown[] = [];
    // Walk the whole property chain (own first) and hand the JS body raw
    // values — `${h + m}` should see numbers, not wrapper objects.
    const seen = new Set<string>();
    let props: object | null = env.properties;
    while (props) {
      for (const k of Object.getOwnPropertyNames(props)) {
        if (seen.has(k) || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) continue;
        seen.add(k);
        names.push(k);
        const v = (env.properties as Record<string, unknown>)[k];
        if (v instanceof NumberElement || v instanceof StringElement) values.push(v.val);
        else if (v instanceof ListElement) values.push(v.states);
        else values.push(v);
      }
      props = Object.getPrototypeOf(props);
    }
    // A body with its own `return` (or multiple statements) is used as a
    // function body verbatim; a bare expression (`${a + 3}`) is wrapped so it
    // returns its value.
    const isStatements = /\breturn\b/.test(body) || /;/.test(body.trim().replace(/;\s*$/, ''));
    const source = isStatements
      ? '"use strict";' + body
      : '"use strict"; return (' + body + ');';
    try {
      const f = new Function(...names, 'there', source);
      return f(...values, this.there);
    } catch {
      return '';
    }
  }
}
