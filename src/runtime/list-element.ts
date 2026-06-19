import { type AnyParam, type BaseElement, stringify } from './base.ts';
import { NumberElement } from './number-element.ts';

export class ListElement implements BaseElement {
  type = 'list';
  states: unknown[] = [];

  constructor(initial?: unknown[]) {
    if (initial) this.states = initial;
  }

  is(v: AnyParam): BaseElement { this.states.push(v); return this; }

  not(v: AnyParam): BaseElement {
    const idx = this.indexOfValue(v);
    if (idx >= 0) this.states.splice(idx, 1);
    return this;
  }

  size(_v: AnyParam): number { return this.states.length; }
  is_not(v: AnyParam): number { return this.indexOfValue(v) >= 0 ? 0 : 1; }
  rest(v: AnyParam): number {
    const t = stringify(v);
    return this.states.filter((s) => stringify(s) !== t).length;
  }

  private indexOfValue(v: AnyParam): number {
    const t = stringify(v);
    return this.states.findIndex((s) => stringify(s) === t);
  }

  get(v: AnyParam): unknown {
    if (typeof v === 'number') return this.states[v];
    if (v instanceof NumberElement) return this.states[v.val];
    return this;
  }

  extend(v: AnyParam): BaseElement {
    const clone = new ListElement([...this.states]);
    clone.is(v);
    return clone;
  }

  reduce(v: AnyParam): BaseElement {
    const clone = new ListElement([...this.states]);
    clone.not(v);
    return clone;
  }

  eq(v: AnyParam): number {
    // Lists compare by value: same length, same stringified items in order.
    const other = v instanceof ListElement ? v.states : Array.isArray(v) ? v : null;
    if (!other) return 0;
    if (other.length !== this.states.length) return 0;
    for (let i = 0; i < other.length; i += 1) {
      if (stringify(other[i]) !== stringify(this.states[i])) return 0;
    }
    return 1;
  }
  // SPEC § 4.2 / original: list.value() returns the underlying array,
  // list.value(true) returns the list itself (for chained operations).
  value(parameter?: unknown): unknown { return parameter ? this : this.states; }
}
