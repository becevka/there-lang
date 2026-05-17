# Reimplementing `there` in Bun + TypeScript

This is a plan, not a port. The existing CommonJS implementation
(`lib/`, `modules_there/`, `bin/`) is the reference for *what the
language does*, not *how to write it*. Re-derive everything from
`SPEC.md` and `PROMO.md`. When you must reach back to the original to
disambiguate semantics (continuation dispatch order, history-mode
flush points, table column semantics), read it as a behaviour
specification, not as a structure to copy.

The seed in this repo is the descriptive material:

- `PROMO.md`, `SPEC.md`, `There Language.md` — the language.
- `examples/promo/` — the duel: the most fully worked example of
  there's natural voice (storytelling phrases, continuations,
  multisets). Both `natural.th` and `canonical.th` are the same
  program; the diff between them is the value of the phrasebook.
- `examples/fizzbuzz.th`, `lang-features.th`, `lang-steps.th` —
  feature surface tour and tutorial steps.
- `examples/anagram/`, `examples/clock/` — referenced from PROMO §§
  "anagram finder" and "unit test, written in the `where` facet".

No runtime, no modules, no JS facets are carried over. Everything
inside `lib/lang/`, every entry in `modules_there/`, every `config.js`
that lived next to an example — all of that is re-decided here.

## Goals

1. **Same surface, same semantics.** A `.th` file that ran on the old
   runtime should run on this one, modulo the explicitly deprecated
   forms in SPEC.md.
2. **Inline `facet` blocks as a first-class feature.** Not a follow-on
   spec, not a "later." See `examples/promo/natural.th` — the
   phrasebook lives inside the program. The reimplementation makes
   that the canonical surface; external `config.js` files become a
   transitional convenience, not the recommended path.
3. **TypeScript-strict.** No `any` in user-facing APIs. Token nodes,
   runtime values, env operations, and facet tables all carry types
   that make the parse → eval flow legible.
4. **Bun-native.** Use Bun's bundled test runner, file I/O, readline,
   and TS compile — no separate transpile step, no `ts-node`, no
   `mocha`. `bun test`, `bun run`, `bun repl`.

## Non-goals

- Backwards compatibility with the CommonJS facet contract. Hosts that
  used to write `module.exports = function (config) { ... }` will get
  a TypeScript-typed `defineFacet({ ... })` instead. Old facets do not
  need to keep working.
- Async I/O performance. The runtime stays callback-shaped because the
  language semantics of `ask` and `_` over strings depend on it; this
  is not the project to rewrite around `Promise`s.
- A new package on npm. Bun-run-from-source is the distribution.

## Stack choices

| Decision         | Choice                                       | Why                                                                                                          |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Runtime          | Bun                                          | Native TS, fast cold start, built-in test/repl/readline. No `node_modules` cost for the bootstrap stack.     |
| Language         | TypeScript 5.x, `strict` on                  | The runtime types (element, value, env, vector) have enough structure to repay strict typing.                |
| Tests            | `bun test`                                   | Replaces `mocha`. Specs become `.test.ts` next to the module under test.                                     |
| Lint / format    | `biome` or `prettier`                        | One config, no eslint plugin sprawl. Pick at bootstrap.                                                      |
| File entry       | `bun run src/cli/there.ts <file> [facetDir]` | Same shape as `bin/there <file> [facetDir]`. A thin shim wraps it as `there` on PATH.                        |

## Module layout (proposed)

    src/
      parse/         tokenizer, alias application, phrase rewriter
      runtime/       element, value, env, there, the runtime types
      eval/          synchronous + async walkers; resource / global dispatch
      facet/         default facet (aliases, phrases, resources, globals);
                     facet loader; inline `facet` block extractor
      modules/       reimplementations of utils, where, etc — written in .th
                     where possible
      cli/           there.ts (script entry), repl.ts, therepile.ts
    test/            integration specs against examples/

`runtime/` is the part that is most worth doing carefully. The old
code's `prototype`-chain element hierarchy works but reads as 2014
JavaScript; the TS rewrite is a chance to make the multiset semantics
of `states` explicit in the type system. See § Runtime types below.

## Phase plan

The phases below are roughly stackable — finish each one before
starting the next, unless explicitly noted as parallelisable.

### Phase 0 — Bootstrap

- `bun init`, `tsconfig.json` with `strict`, `noUncheckedIndexedAccess`.
- One smoke test that imports nothing and asserts `1 + 1 === 2`.
- Decide lint/format. Wire into `bun test --coverage` if useful.

### Phase 1 — Parser

Re-derive from `SPEC.md` § 3. The artefacts are:

- A tokenizer that walks raw text, skips `#` line comments, slices on
  whitespace / `;` / delimiters, and produces a stream of tokens
  carrying `value`, `type`, `line`, `position`.
- Delimiter handling for `{...}` (block), `(...)` (sequence), `[...]`
  (list), `|...|` (table), `` `...` `` (template). Each compound type
  must be re-enterable: parse lazily on first access, not eagerly.
- Alias substitution at token construction time (single-token
  rewrites: `is` → `+`, `has` → `set`, etc.).
- Phrase rewriter that runs over the parsed sequence and applies the
  facet's multi-token rewrite table. Phrases match a mixed token
  sequence and replace it with another token sequence, with `$1`,
  `$2`, ... captures.
- **Inline `facet` block extraction.** Before phrase rewriting, scan
  for `` ```facet `` ... `` ``` `` fences at the file's top, parse
  their contents (one or more of `phrases = {...}`, `aliases = {...}`,
  `resources = {...}`, `globals = {...}`), merge into a fresh copy of
  the facet, and strip them from the token stream. See `examples/promo/natural.th`
  for the surface; SPEC.md § 13 for the design notes (which still talk
  about `...phrases` fences — the current shape uses fenced `facet`
  blocks instead).

The output of this phase is "a parsed file + its effective facet,"
both immutable.

### Phase 2 — Runtime types

The element hierarchy from the spec:

    element → value → word → env → there
                  ↘ string
                  ↘ number
                  ↘ list
                  ↘ vector
                  ↘ table

Every element has `type`, `states: string[]` (the multiset), and the
core verbs: `is`, `not`, `size`, `is_not`, `get`, `rest`, `extend`,
`reduce`, `eq`. These are the eight verbs PROMO.md leans on; they are
defined once on `element` and refined on the subtypes.

The TS rewrite should make the multiset nature of `states` legible at
the type level. Concretely: `state` is a nominal string subtype; `size`
returns `number`; `is_not` returns `0 | 1` (the language's truthy
encoding). Don't paper over the count-as-boolean convention with a
helper.

### Phase 3 — Evaluator

Two walkers over the parsed sequence:

- **Synchronous** for the common case (everything that does not touch
  `ask`, `$file`, or `_` over a string).
- **Asynchronous** (callback-passing) for the IO branches. The old
  runtime distinguishes them via the presence of a `done` callback in
  the eval signature; the rewrite should make the two walkers
  visibly different functions sharing a token-dispatch core.

Each token's `type` maps to a runtime constructor: `string`, `number`,
`vector`, `list`, `table`, `word` → `element`. Resources resolve
against `there.resources` first, then via `auto_read` (which prompts
the user for missing `$`-resources at program start).

Continuations (`(target effect) ... { body }`) register against an
internal table on `there` keyed by `(vector, target, effect)`; the
evaluator fires them whenever the matching effect happens.

### Phase 4 — Default facet

A single TS module exporting the four tables (`aliases`, `phrases`,
`resources`, `globals`) and the `history` controller. The contents
come from SPEC.md § 3.4–3.5 and `PROMO.md` § "Concepts" — derive them
from the spec text, not from `lib/integ/config.js`.

History mode (PROMO.md § 8) is in scope but ships behind `mode history
on`. The MVP is the deferred-then-flush behaviour for `+` and `-` on
typed elements; the richer operations (`repeat`, `undo`, `redo`,
`learn`, `forget`) are sketched in `lang-features.th` and stay
out-of-scope for the first cut.

### Phase 5 — CLI and REPL

- `there <file> [facetDir]` — load file, parse with the facet, run.
- `there` (no args) — REPL. History on disk, `.history` next to the
  cwd as before. Commands: `help`, `clear`, `silence`, `exit` and the
  `\?`, `\c`, `\s`, `\q` shortcuts.
- `therepile <file>` — pretty-print the parsed AST. Useful for
  debugging phrase rewrites.

Reuse Bun's `readline` for input. Resolve facet paths the same way the
old runtime did: arg-directory's `config.js`, else `lib/integ`. Once
inline facet blocks are the norm, the facet-arg is mostly vestigial.

### Phase 6 — Modules

The two built-in modules (`utils`, `where`) need to be re-derived. The
old implementations are `.th` plus a tiny `config.js`; the rewrite
should aim to push them as far into `.th` as the language allows, with
the JS shim only carrying the resources that genuinely need host code.

`where` is the more interesting one — PROMO.md § "anger" promises that
the test framework is ~80 lines of `there`. The rewrite should hold
that line.

### Phase 7 — Integration tests against examples

Each `.th` file in `examples/` becomes a fixture. The runner parses
and evaluates it; either:

- The example is deterministic — assert on its captured stdout.
- The example is interactive — drive it through scripted input.

`examples/promo/natural.th` is the headline test: it exercises the
inline `facet` block, multi-arg phrases, continuation chains across
six layers, and the multiset query/effect distinction. If it runs and
prints sensible status lines, the rewrite has hit its core target.

## Open questions

These need decisions during implementation, not before:

- **Inline `facet` block grammar inside the fence.** The example uses
  `'pattern' : 'replacement'` pairs, JS-flavored. There's a choice
  between (a) treating the fence contents as embedded JS-object
  syntax, (b) parsing them with there's own block grammar but with
  `:` as a key-value separator, (c) requiring the user to spell it
  with there's existing `=`. (a) is simplest; (b) is most consistent
  with the rest of the language. Pick on first encounter; the example
  files can be updated to match.
- **JS escape hatches in `resources` / `globals` declarations.** The
  inline example uses template literals (`` `${ ... }` ``) for the
  body of `$rand`. SPEC.md § 13.4 flags this as a security concern
  and proposes a safe declarative subset. The MVP can accept raw JS
  inside the fence — it is no worse than today's `config.js` — with a
  TODO to design the safe subset later.
- **Multi-arg phrase precedence.** The old runtime matches phrases in
  insertion order, with the user responsible for putting longer
  patterns first. SPEC.md hints at longest-match; the rewrite should
  pick one and document it.
- **State name interning.** `states: string[]` is correct but lossy:
  there is no place to attach metadata to a state name (e.g. "this
  is a marker, this is a count token"). If markers and counters
  diverge mechanically later, intern state names through a
  `StateRef` and make the distinction visible.
- **Effect dispatch order in continuations.** When `$opp is attacked`
  fires, both `(* attacked)` and any more specific `(opp attacked)`
  may apply. SPEC.md doesn't clearly specify ordering. Codify it.

## What to read first

In order:

1. `PROMO.md` end-to-end. It is the language as a user sees it.
2. `examples/promo/README.md` and then `natural.th` next to
   `canonical.th`. The promo example is the densest worked code in
   the repo.
3. `examples/lang-features.th` — fast tour of every operator.
4. `SPEC.md` §§ 1–6 for the formal grammar, then § 13 for the inline
   facet design notes.

You do **not** need the old `lib/` to start. If you find yourself
wanting it, you are probably trying to copy structure that should be
re-derived. The one moment you'll likely need it: when the spec is
ambiguous on continuation dispatch or history-mode flush, the old
runtime is the tiebreaker.
