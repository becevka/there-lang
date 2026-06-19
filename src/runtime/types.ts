export {
  type AnyParam,
  type BaseElement,
  asStateName,
  stringify,
  numberOf,
  toStr,
  toNum,
} from './base.ts';

export { ThereElement } from './there-element.ts';
export { NumberElement } from './number-element.ts';
export { StringElement } from './string-element.ts';
export { ListElement } from './list-element.ts';
export { TableElement } from './table-element.ts';
export { VectorElement, type VectorBody } from './vector-element.ts';
export {
  EnvElement,
  ThereEnv,
  type EnvProperties,
  type Continuation,
  type ConstructorEntry,
} from './env.ts';

import { wireCreate } from './env.ts';
import { NumberElement as NumberEl } from './number-element.ts';
import { StringElement as StringEl } from './string-element.ts';
import { ListElement as ListEl } from './list-element.ts';
import { ThereElement as ThereEl } from './there-element.ts';

wireCreate({ number: NumberEl, string: StringEl, list: ListEl, element: ThereEl });

import type { ThereElement } from './there-element.ts';
import type { NumberElement } from './number-element.ts';
import type { StringElement } from './string-element.ts';
import type { ListElement } from './list-element.ts';
import type { TableElement } from './table-element.ts';
import type { VectorElement } from './vector-element.ts';
import type { EnvElement } from './env.ts';

export type ValueElement = StringElement | NumberElement | ListElement;

export type Element =
  | ThereElement
  | StringElement
  | NumberElement
  | ListElement
  | VectorElement
  | TableElement
  | EnvElement;
