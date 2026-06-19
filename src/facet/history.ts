import {
  EnvElement, ThereEnv, ThereElement, VectorElement, TableElement, asStateName,
} from '../runtime/types.ts';
import type { Evaluator, GlobalDef } from '../eval/evaluator.ts';
import { unwrapSeq } from '../eval/evaluator.ts';

/**
 * History: a per-element journal of `+` / `-` effects (SPEC § 4.15).
 *
 * Recording is gated on `mode history on`. Every recorded effect belongs to
 * a *group* (one root operation; `learn` makes a whole block one group) and
 * carries *tags*: the names of the vectors whose bodies were executing, plus
 * any sessions opened with `start name` … `stop name`.
 *
 * Commands (operate on the source element, no recording while they run):
 *   el repeat       re-apply the most recent group
 *   el undo         revert the most recent applied group
 *   el redo         re-apply the most recently undone group
 *   el learn { … }  run the block on el, journaled as ONE group
 *   el start name   tag subsequent effects on el with `name`
 *   el stop name    stop tagging
 *   el forget name  revert and erase every effect tagged `name`
 */

export interface HistoryEntry {
  op: '+' | '-';
  state: string;
  tags: string[];
  seq: number;
}

export interface HistoryState {
  entries: HistoryEntry[];
  /** entries[0..cursor-1] are applied; the rest is the redo tail. */
  cursor: number;
  activeTags: string[];
}

interface WithHistory { _history?: HistoryState }

export function historyOf(el: ThereElement): HistoryState {
  const host = el as unknown as WithHistory;
  if (!host._history) host._history = { entries: [], cursor: 0, activeTags: [] };
  return host._history;
}

function isHistoryOn(ev: Evaluator, env: EnvElement): boolean {
  return !!(env.modes['history'] || ev.there.modes['history']);
}

/** Called by `+` / `-` after a successful state mutation. */
export function recordHistory(
  ev: Evaluator,
  env: EnvElement,
  op: '+' | '-',
  src: unknown,
  p: unknown,
): void {
  if (ev.historyMuted) return;
  if (!(src instanceof ThereElement)) return;
  if (p instanceof VectorElement || p instanceof TableElement || p instanceof EnvElement) return;
  if (!isHistoryOn(ev, env)) return;
  const h = historyOf(src);
  h.entries.length = h.cursor; // a fresh effect truncates the redo tail
  let seq = ev.historyForcedSeq;
  if (seq === undefined) {
    ev.historySeq += 1;
    seq = ev.historySeq;
  }
  h.entries.push({
    op,
    state: asStateName(p),
    tags: [...h.activeTags, ...ev.frameNames],
    seq,
  });
  h.cursor = h.entries.length;
}

function applyEntry(ev: Evaluator, el: ThereElement, e: HistoryEntry): void {
  ev.historyMuted = true;
  try {
    if (e.op === '+') el.is(e.state);
    else el.not(e.state);
  } finally {
    ev.historyMuted = false;
  }
}

function revertEntry(ev: Evaluator, el: ThereElement, e: HistoryEntry): void {
  ev.historyMuted = true;
  try {
    if (e.op === '+') el.not(e.state);
    else el.is(e.state);
  } finally {
    ev.historyMuted = false;
  }
}

function sourceElement(source: unknown): ThereElement | null {
  const src = unwrapSeq(source);
  return src instanceof ThereElement ? src : null;
}

const opRepeat: GlobalDef = {
  name: 'repeat',
  arity: 0,
  fn: (source, _params, _there, _env, ev) => {
    const el = sourceElement(source);
    if (!el) return source;
    const h = historyOf(el);
    if (h.cursor === 0) return source;
    const seq = h.entries[h.cursor - 1]!.seq;
    let from = h.cursor;
    while (from > 0 && h.entries[from - 1]!.seq === seq) from -= 1;
    const group = h.entries.slice(from, h.cursor);
    h.entries.length = h.cursor;
    ev.historySeq += 1;
    for (const e of group) {
      applyEntry(ev, el, e);
      h.entries.push({ ...e, seq: ev.historySeq });
    }
    h.cursor = h.entries.length;
    return source;
  },
};

const opUndo: GlobalDef = {
  name: 'undo',
  arity: 0,
  fn: (source, _params, _there, _env, ev) => {
    const el = sourceElement(source);
    if (!el) return source;
    const h = historyOf(el);
    if (h.cursor === 0) return source;
    const seq = h.entries[h.cursor - 1]!.seq;
    while (h.cursor > 0 && h.entries[h.cursor - 1]!.seq === seq) {
      revertEntry(ev, el, h.entries[h.cursor - 1]!);
      h.cursor -= 1;
    }
    return source;
  },
};

const opRedo: GlobalDef = {
  name: 'redo',
  arity: 0,
  fn: (source, _params, _there, _env, ev) => {
    const el = sourceElement(source);
    if (!el) return source;
    const h = historyOf(el);
    if (h.cursor >= h.entries.length) return source;
    const seq = h.entries[h.cursor]!.seq;
    while (h.cursor < h.entries.length && h.entries[h.cursor]!.seq === seq) {
      applyEntry(ev, el, h.entries[h.cursor]!);
      h.cursor += 1;
    }
    return source;
  },
};

const opStart: GlobalDef = {
  name: 'start',
  arity: 1,
  fn: (source, params, _there, _env, _ev) => {
    const el = sourceElement(source);
    if (!el) return source;
    historyOf(el).activeTags.push(asStateName(unwrapSeq(params[0])));
    return source;
  },
};

const opStop: GlobalDef = {
  name: 'stop',
  arity: 1,
  fn: (source, params, _there, _env, _ev) => {
    const el = sourceElement(source);
    if (!el) return source;
    const h = historyOf(el);
    const name = asStateName(unwrapSeq(params[0]));
    const idx = h.activeTags.lastIndexOf(name);
    if (idx >= 0) h.activeTags.splice(idx, 1);
    return source;
  },
};

const opForget: GlobalDef = {
  name: 'forget',
  arity: 1,
  fn: (source, params, _there, _env, ev) => {
    const el = sourceElement(source);
    if (!el) return source;
    const h = historyOf(el);
    const tag = asStateName(unwrapSeq(params[0]));
    const kept: HistoryEntry[] = [];
    let removedApplied = 0;
    // Revert applied entries newest-first so inverse ops compose correctly.
    for (let i = h.cursor - 1; i >= 0; i -= 1) {
      const e = h.entries[i]!;
      if (e.tags.includes(tag)) {
        revertEntry(ev, el, e);
        removedApplied += 1;
      }
    }
    for (let i = 0; i < h.entries.length; i += 1) {
      const e = h.entries[i]!;
      if (!e.tags.includes(tag)) kept.push(e);
    }
    h.entries = kept;
    h.cursor -= removedApplied;
    if (h.cursor < 0) h.cursor = 0;
    if (h.cursor > h.entries.length) h.cursor = h.entries.length;
    return source;
  },
};

const opLearn: GlobalDef = {
  name: 'learn',
  arity: 1,
  fn: async (source, params, _there, _env, ev) => {
    const el = sourceElement(source);
    const block = unwrapSeq(params[0]);
    if (!el || !(block instanceof VectorElement)) return source;
    const h = historyOf(el);
    const tag = block.type && block.type !== 'vector' ? block.type : 'lesson';
    ev.historySeq += 1;
    const prevForced = ev.historyForcedSeq;
    ev.historyForcedSeq = ev.historySeq;
    h.activeTags.push(tag);
    try {
      await ev.invokeFully(block, el, { el });
    } finally {
      ev.historyForcedSeq = prevForced;
      const idx = h.activeTags.lastIndexOf(tag);
      if (idx >= 0) h.activeTags.splice(idx, 1);
    }
    return source;
  },
};

export const historyGlobals: GlobalDef[] = [
  opRepeat, opUndo, opRedo, opStart, opStop, opForget, opLearn,
];
