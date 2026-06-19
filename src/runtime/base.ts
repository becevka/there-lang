export type AnyParam = unknown;

export interface BaseElement {
  type: string;
  states: unknown[];
  is(value: AnyParam): BaseElement;
  not(value: AnyParam): BaseElement;
  size(value: AnyParam): number;
  is_not(value: AnyParam): number;
  get(value: AnyParam): unknown;
  rest(value: AnyParam): unknown;
  extend(value: AnyParam): BaseElement;
  reduce(value: AnyParam): BaseElement;
  eq(value: AnyParam): number;
  value(): unknown;
}

/**
 * Sync probe for the current value of `_val` on an object. If `_val` is an
 * async thunk (lazy value vector), returns the eagerly-computed `_valCache`
 * so sync stringify/numberOf paths still see a value. Async callers should
 * use `resolveLazy` (in the evaluator) to force a fresh re-evaluation.
 */
export function getVal(o: { _val?: unknown; _valCache?: unknown }): unknown {
  if (!('_val' in o)) return undefined;
  if (typeof o._val === 'function') return o._valCache;
  return o._val;
}

export function asStateName(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  const e = v as Partial<BaseElement> & { type?: string; _val?: unknown; _valCache?: unknown };
  const val = getVal(e);
  if (val !== undefined) return asStateName(val);
  if (typeof e.value === 'function') {
    const inner = e.value();
    if (typeof inner === 'string' || typeof inner === 'number') return String(inner);
  }
  if (typeof e.type === 'string') return e.type;
  return String(v);
}

export function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(stringify).join(',');
  const o = v as { value?: () => unknown; val?: unknown; type?: string; _val?: unknown; _valCache?: unknown };
  const cached = getVal(o);
  if (cached !== undefined) return stringify(cached);
  if (typeof o.value === 'function') {
    const inner = o.value();
    if (inner === v) return o.type ?? String(v);
    if (typeof inner === 'string' || typeof inner === 'number') return String(inner);
    if (Array.isArray(inner)) return inner.map(stringify).join(',');
    if (inner != null) return String(inner);
  }
  if (typeof o.val !== 'undefined') return String(o.val);
  if (o.type) return o.type;
  return String(v);
}

export function numberOf(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  const o = v as { value?: () => unknown; val?: unknown; _val?: unknown; _valCache?: unknown };
  const cached = getVal(o);
  if (cached !== undefined) return numberOf(cached);
  if (typeof o.value === 'function') {
    const inner = o.value();
    return Number(inner);
  }
  if (typeof o.val !== 'undefined') return Number(o.val);
  return Number(v);
}

export { stringify as toStr, numberOf as toNum };
