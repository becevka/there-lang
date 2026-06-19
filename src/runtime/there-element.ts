import { type AnyParam, type BaseElement, asStateName } from './base.ts';

export class ThereElement implements BaseElement {
  type: string;
  states: string[] = [];

  constructor(type: string) { this.type = type; }

  is(v: AnyParam): BaseElement {
    this.states.push(asStateName(v));
    return this;
  }

  not(v: AnyParam): BaseElement {
    const name = asStateName(v);
    const idx = this.states.indexOf(name);
    if (idx >= 0) this.states.splice(idx, 1);
    return this;
  }

  size(v: AnyParam): number {
    // Per SPEC § 4.2: count the element's own type as a state of itself,
    // plus state occurrences. So `apple ? apple` is 1, and
    // `apple is red; apple ? red` is 1 too.
    const name = asStateName(v);
    const self = this.type === name ? 1 : 0;
    return self + this.states.filter((s) => s === name).length;
  }

  is_not(v: AnyParam): number { return this.size(v) === 0 ? 1 : 0; }

  rest(v: AnyParam): number {
    const name = asStateName(v);
    return this.states.length - this.states.filter((s) => s === name).length;
  }

  get(v: AnyParam): unknown {
    if (typeof v === 'number') return this.states[v];
    return this;
  }

  extend(v: AnyParam): BaseElement {
    const clone = new ThereElement(this.type);
    clone.states = [...this.states];
    if (v !== undefined) clone.is(v);
    return clone;
  }

  reduce(v: AnyParam): BaseElement {
    const clone = new ThereElement(this.type);
    clone.states = [...this.states];
    if (v !== undefined) clone.not(v);
    return clone;
  }

  eq(v: AnyParam): number { return this.type === asStateName(v) ? 1 : 0; }

  value(): unknown { return this.type; }
}
