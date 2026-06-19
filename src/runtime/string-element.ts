import { type AnyParam, type BaseElement, stringify } from './base.ts';
import { NumberElement } from './number-element.ts';

export class StringElement implements BaseElement {
  type = 'string';
  states: string[] = [];
  val: string;

  constructor(val: string) { this.val = val; }

  is(v: AnyParam): BaseElement { this.val += stringify(v); return this; }

  not(v: AnyParam): BaseElement {
    this.val = this.val.split(stringify(v)).join('');
    return this;
  }

  size(v: AnyParam): number {
    const needle = stringify(v);
    if (!needle) return 0;
    return this.val.split(needle).length - 1;
  }

  is_not(v: AnyParam): number { return this.val !== stringify(v) ? 1 : 0; }

  rest(v: AnyParam): number { return this.val.split(stringify(v)).join('').length; }

  get(v: AnyParam): unknown {
    // SPEC § 4.2: with number → char at index (returned raw, matching original).
    // With string → indexOf. Otherwise concat.
    if (typeof v === 'number') return this.val.charAt(v);
    if (v instanceof NumberElement) return this.val.charAt(v.val);
    if (typeof v === 'string') return this.val.indexOf(v);
    if (v instanceof StringElement) return this.val.indexOf(v.val);
    return new StringElement(this.val + stringify(v));
  }

  extend(v: AnyParam): BaseElement {
    return new StringElement(v === undefined ? this.val : this.val + stringify(v));
  }

  reduce(v: AnyParam): BaseElement {
    const clone = new StringElement(this.val);
    if (v !== undefined) clone.not(v);
    return clone;
  }

  eq(v: AnyParam): number { return this.val === stringify(v) ? 1 : 0; }

  value(): unknown { return this.val; }
}
