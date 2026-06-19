import { type AnyParam, type BaseElement, numberOf } from './base.ts';

export class NumberElement implements BaseElement {
  type = 'number';
  states: string[] = [];
  val: number;

  constructor(val: number) { this.val = val; }

  is(v: AnyParam): BaseElement { this.val += numberOf(v); return this; }
  not(v: AnyParam): BaseElement { this.val -= numberOf(v); return this; }
  size(v: AnyParam): number { return this.val / numberOf(v); }
  is_not(v: AnyParam): number { return this.val !== numberOf(v) ? 1 : 0; }
  rest(v: AnyParam): number { return this.val % numberOf(v); }
  get(v: AnyParam): BaseElement { this.val *= numberOf(v); return this; }
  extend(v: AnyParam): BaseElement {
    return new NumberElement(v === undefined ? this.val : this.val + numberOf(v));
  }
  reduce(v: AnyParam): BaseElement {
    return new NumberElement(v === undefined ? this.val : this.val - numberOf(v));
  }
  eq(v: AnyParam): number { return this.val === numberOf(v) ? 1 : 0; }
  value(): unknown { return this.val; }
}
