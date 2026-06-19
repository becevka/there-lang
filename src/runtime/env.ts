import type { Token } from '../parse/token.ts';
import { type AnyParam, type BaseElement, asStateName } from './base.ts';

export interface EnvProperties { [name: string]: unknown }

export interface Continuation {
  vectorName: string;
  target: string;
  effect: string;
  block: Token;
  defEnv: EnvElement;
}

export interface ConstructorEntry {
  /** The declaration's block vector — carries the body, the optional parser
   *  spec (`(name) : { … } ($x{$el})`), and the defining env. */
  vector: unknown;
  defEnv: EnvElement;
  cache: boolean;
  cached?: unknown;
  type: string;
}

export class EnvElement implements BaseElement {
  type: string;
  states: string[] = [];
  properties: EnvProperties;
  parentProperties: EnvProperties | null;
  resources: Record<string, unknown>;
  modes: Record<string, boolean>;
  continuations: Continuation[];
  constructors: Record<string, ConstructorEntry>;
  returns: unknown[] = [];
  parent?: EnvElement | undefined;
  _ft?: boolean;
  reflected?: boolean;
  /**
   * Next positional index handed out by `auto-read` mode. Reset to 1 in
   * each new bodyEnv; increments after each unknown-resource lookup.
   */
  _autoReadIdx = 1;

  constructor(type: string, parent?: EnvElement) {
    this.type = type;
    this.parent = parent;
    this.parentProperties = parent ? parent.properties : null;
    this.properties = Object.create(this.parentProperties);
    this.resources = parent ? Object.create(parent.resources) : Object.create(null);
    this.modes = parent ? Object.create(parent.modes) : Object.create(null);
    this.continuations = parent ? [...parent.continuations] : [];
    this.constructors = parent ? Object.create(parent.constructors) : Object.create(null);
  }

  is(v: AnyParam): BaseElement { this.set(v); return this; }
  not(v: AnyParam): BaseElement { this.remove(v); return this; }
  size(v: AnyParam): number { return this.has(v); }
  is_not(v: AnyParam): number { return this.has(v) ? 0 : 1; }
  rest(): number { return 0; }

  get(v: AnyParam): unknown {
    const name = asStateName(v);
    return this.properties[name];
  }

  extend(): BaseElement { return this; }
  reduce(): BaseElement { return this; }
  eq(v: AnyParam): number { return this === v ? 1 : 0; }
  value(): unknown { return this.type; }

  set(el: AnyParam, name?: string): void {
    if (el && typeof el === 'object') {
      const e = el as { type?: string };
      const key = name ?? e.type ?? asStateName(el);
      this.properties[key] = el;
    } else {
      this.properties[String(name ?? el)] = el;
    }
  }

  remove(v: AnyParam): void { delete this.properties[asStateName(v)]; }
  has(v: AnyParam): number { return asStateName(v) in this.properties ? 1 : 0; }
  has_not(v: AnyParam): number { return asStateName(v) in this.properties ? 0 : 1; }
}

export class ThereEnv extends EnvElement {
  out: (text: string, flag?: number) => void = (text) => { console.log(text); };
  ask: (text: string, cb: (answer: string) => void) => void = (_text, cb) => { cb(''); };
  globals: Record<string, unknown> = Object.create(null);

  constructor() { super('there'); }

  globalize(name: string, v: unknown): void { this.globals[name] = v; }

  /** Host-value factory exposed to template-bodied resources
   *  (`there.create('number', …)` in inline facet blocks). */
  create(type: string, v?: unknown): unknown {
    if (type === 'number') return new HostNumber(Number(v));
    if (type === 'string') return new HostString(String(v));
    if (type === 'list') return new HostList(Array.isArray(v) ? v : v === undefined ? [] : [v]);
    return new HostElement(String(v ?? type));
  }
}

// Late-bound constructors to avoid an import cycle (the element modules
// import from base.ts, not from here). Wired in runtime/types.ts.
let HostNumber: new (v: number) => unknown;
let HostString: new (v: string) => unknown;
let HostList: new (v: unknown[]) => unknown;
let HostElement: new (t: string) => unknown;

export function wireCreate(deps: {
  number: new (v: number) => unknown;
  string: new (v: string) => unknown;
  list: new (v: unknown[]) => unknown;
  element: new (t: string) => unknown;
}): void {
  HostNumber = deps.number;
  HostString = deps.string;
  HostList = deps.list;
  HostElement = deps.element;
}
