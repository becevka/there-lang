import type { Token } from '../parse/token.ts';
import type { AnyParam, BaseElement } from './base.ts';
import type { EnvElement, ThereEnv } from './env.ts';

export interface VectorBody {
  block?: Token | undefined;
  parserSpec?: Token | undefined;
  fn?: (source: BaseElement | null, params: unknown[], there: ThereEnv, names: string[]) => unknown;
}

export class VectorElement implements BaseElement {
  type: string;
  states: string[] = [];
  body: VectorBody;
  arity?: number;
  defEnv?: EnvElement;
  noCache = false;

  constructor(type: string, body: VectorBody) {
    this.type = type;
    this.body = body;
  }

  is(): BaseElement { return this; }
  not(): BaseElement { return this; }
  size(): number { return 0; }
  is_not(): number { return 0; }
  rest(): number { return 0; }
  get(): unknown { return this; }
  extend(): BaseElement { return this; }
  reduce(): BaseElement { return this; }
  eq(v: AnyParam): number { return this === v ? 1 : 0; }
  value(): unknown { return this.body.fn; }
}
