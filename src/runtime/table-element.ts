import { type AnyParam, type BaseElement, asStateName, stringify } from './base.ts';
import { ListElement } from './list-element.ts';
import { NumberElement } from './number-element.ts';
import { StringElement } from './string-element.ts';

/**
 * Column-oriented store. Rows are added by iterating an incoming list and
 * dropping cells into matching columns; searches accept either a row-shaped
 * list (with `*` as a wildcard) or a regex string against the joined row.
 */
export class TableElement implements BaseElement {
  type = 'table';
  states: unknown[] = [];
  struct: Record<string, unknown[]> = {};
  count = 0;
  columns: string[];

  constructor(columns: string[]) {
    this.columns = columns;
    for (const c of columns) this.struct[c] = [];
  }

  // `+ ['a' 1]` — push the i-th cell into the i-th column.
  is(v: AnyParam): BaseElement {
    const cells = rowCells(v);
    for (let i = 0; i < this.columns.length; i += 1) {
      const col = this.columns[i]!;
      this.struct[col]!.push(cells[i]);
    }
    this.count += 1;
    return this;
  }

  // `- N` removes row N; `- [search]` removes the first matching row.
  not(v: AnyParam): BaseElement {
    const idx = typeof v === 'number' ? v
      : v instanceof NumberElement ? v.val
      : this.findRow(rowCells(v));
    if (idx == null || idx < 0 || idx >= this.count) return this;
    for (const col of this.columns) this.struct[col]!.splice(idx, 1);
    this.count -= 1;
    return this;
  }

  // `? something` — count of rows (param ignored to match other types).
  size(_v: AnyParam): number { return this.count; }
  is_not(_v: AnyParam): number { return this.count === 0 ? 1 : 0; }
  rest(_v: AnyParam): number { return 0; }

  // `* N` row by index → list of cells.
  // `* [search]` — search across columns (with `*` wildcard) → list of rows.
  // `* 'regex'` — regex search against joined row string → list of rows.
  get(v: AnyParam): unknown {
    if (typeof v === 'number' || v instanceof NumberElement) {
      const idx = typeof v === 'number' ? v : v.val;
      if (idx < 0 || idx >= this.count) return new NumberElement(this.count);
      return new ListElement(this.columns.map((c) => this.struct[c]![idx]));
    }
    if (typeof v === 'string' || v instanceof StringElement) {
      const pattern = typeof v === 'string' ? v : v.val;
      return this.regexSearch(pattern);
    }
    if (v instanceof ListElement) {
      return this.listSearch(v.states);
    }
    return this;
  }

  extend(v: AnyParam): BaseElement {
    const clone = this.clone();
    clone.is(v);
    return clone;
  }

  reduce(v: AnyParam): BaseElement {
    const clone = this.clone();
    clone.not(v);
    return clone;
  }

  eq(v: AnyParam): number { return this === v ? 1 : 0; }
  value(): unknown { return this; }

  // Convenience for iteration: produce row records with column→cell mapping.
  rows(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < this.count; i += 1) {
      const row: Record<string, unknown> = {};
      for (const c of this.columns) row[c] = this.struct[c]![i];
      out.push(row);
    }
    return out;
  }

  data(): Record<string, unknown[]> { return this.struct; }

  private clone(): TableElement {
    const c = new TableElement([...this.columns]);
    c.count = this.count;
    for (const col of this.columns) c.struct[col] = [...this.struct[col]!];
    return c;
  }

  private findRow(cells: unknown[]): number {
    for (let i = 0; i < this.count; i += 1) {
      let match = true;
      for (let j = 0; j < this.columns.length; j += 1) {
        const probe = cells[j];
        if (probe == null) continue;
        if (asStateName(probe) === '*') continue;
        const cell = this.struct[this.columns[j]!]![i];
        if (!cellEq(cell, probe)) { match = false; break; }
      }
      if (match) return i;
    }
    return -1;
  }

  private listSearch(cells: unknown[]): ListElement {
    const matches = new ListElement();
    for (let i = 0; i < this.count; i += 1) {
      let ok = true;
      for (let j = 0; j < this.columns.length; j += 1) {
        const probe = cells[j];
        if (probe == null) continue;
        if (asStateName(probe) === '*') continue;
        const cell = this.struct[this.columns[j]!]![i];
        if (!cellEq(cell, probe)) { ok = false; break; }
      }
      if (ok) matches.is(new ListElement(this.columns.map((c) => this.struct[c]![i])));
    }
    return matches;
  }

  private regexSearch(pattern: string): ListElement {
    // SPEC § 4.4 / original: build the row as `col1,col2,...`, replace
    // `,` with space, then match the user pattern against the joined row.
    let re: RegExp;
    try { re = new RegExp(pattern); } catch { return new ListElement(); }
    const matches = new ListElement();
    for (let i = 0; i < this.count; i += 1) {
      const joined = this.columns.map((c) => stringify(this.struct[c]![i])).join(',').replace(/,/g, ' ');
      if (re.test(joined)) matches.is(new ListElement(this.columns.map((c) => this.struct[c]![i])));
    }
    return matches;
  }
}

function rowCells(v: unknown): unknown[] {
  if (v instanceof ListElement) return v.states;
  if (Array.isArray(v)) return v;
  return [v];
}

function cellEq(a: unknown, b: unknown): boolean {
  return stringify(a) === stringify(b);
}
