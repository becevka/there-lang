# `there` Language — Reimplementation Specification

This document is a complete, implementation-oriented description of the `there` language as it exists in this repository. It is meant to be used as the input requirement for a from-scratch reimplementation. Everything in here is derived from the source under `lib/`, `modules_there/`, `examples/`, and `test/`.

The language is a small, dynamically-typed, prototype-extensible DSL where every statement has the shape:

```
generator processor (collector) (parameters) (=> reducer)
```

It is interpreted, side-effect oriented, and customizable per "facet" (a pluggable bundle of aliases, phrases, resources, and global operators). The reference implementation runs on Node.js, but the language definition itself is host-agnostic.

---

## 1. Goals and Non-Goals

### Goals
- Reimplement the full surface language so existing `.th` programs under `examples/` and `modules_there/` run unchanged.
- Reproduce the runtime behavior verified by the Mocha tests under `test/` (parser, evaluator, types, iterables, vectors, tables, values).
- Preserve the facet-based extensibility model: any host may register new aliases, phrases, resources, and operators without modifying the core.
- Preserve module loading semantics: a module is just another facet whose `index.th` runs once and whose facet entries become available.

### Non-Goals
- The reference parser is permissive (e.g., it does not validate phrase capture arity beyond `$N`). Reimplementations are free to be stricter.
- The reference uses CommonJS, Node 6+, and `readline` for IO. A reimplementation can target any host; only the *behavior* needs to match.
- The `therepile` AST pretty-printer is auxiliary tooling and is optional.

---

## 2. Source Files

- Extension: `.th`. When a path argument is a directory, `index.th` is loaded; when it has no extension, `.th` is appended.
- Encoding: UTF-8.
- A facet directory must contain a `config.js` (CommonJS) plus optionally an `index.th`. Built-in facet name defaults: `integ` (the default language), `utils`, `where`. Custom facet path resolution: first relative to the current dir, then under a `modules_there/` directory shipped with the runtime.

---

## 3. Lexical Structure

### 3.1 Whitespace and comments
- Whitespace is any run of ASCII whitespace including newlines; it separates tokens but is otherwise insignificant inside a top-level sequence.
- Line comments start with `#` and run to the next `\n`.
- A `\n` increments line count for error reporting; column ("position") increments per token.

### 3.2 Tokens
A token is sliced from the source according to the first non-space character:

| Leading char | Token type     | Slice rule                                                   |
|--------------|----------------|--------------------------------------------------------------|
| `;`          | `switch`       | The single character `;`                                     |
| `"` or `'`   | `string`       | Matching quote, with backslash-escape of the same quote      |
| `` ` ``      | `template`     | Backtick-delimited; escape with `\` `                        |
| `{`          | `block`        | Matched braces, nested                                       |
| `(`          | `sequence`     | Matched parens, nested                                       |
| `[`          | `list`         | Matched brackets, nested                                     |
| `|`          | `table`        | Matched pipes (not nested; treat as paired delimiter)        |
| digit        | `number`       | Run up to whitespace / `;` / opening bracket                 |
| `$`          | `resource`     | Run up to whitespace / `;` / opening bracket; strip the `$`  |
| otherwise    | `word`         | Run up to whitespace / `;` / opening bracket                 |

Notes:
- Nested delimiters of the same kind increment a depth counter; the closer at depth 0 ends the token.
- For string-like tokens (`"` `'` `` ` ``) only the matching delimiter is escapable with `\`. Other backslashes are preserved verbatim.
- A bare `||` is kept as a `word` (the "else" operator). Generally `(X)` with `X` empty after trimming is still a `sequence`.
- After slicing, the textual form is rewritten through the facet's alias table (see 3.4) before being classified.

### 3.3 Classification rules (after slice + alias rewrite)
- Pure leading-digit text → `number`, value coerced via `Number(text)`.
- Starts with `$` → `resource`; value is the rest of the token; the resource name is appended to the parsed program's `resources` list.
- Token `;` → `switch` (a no-op separator at evaluation time).
- Begins and ends with the same string-quote → `string` (or `template` if the quote is `` ` ``). Value is the unquoted interior.
- Balanced `{...}` `(...)` `[...]` `|...|` → `block` / `sequence` / `list` / `table`. Value is the trimmed interior; the body is *not* recursively parsed yet — see lazy parsing below.
- Everything else → `word`. Value is the text.

### 3.4 Aliases
A facet provides a single-token rewrite table `aliases: { from: to }`. Aliases are applied to the raw token text before classification. Default facet aliases:

```
is → +     are → +     add → +     and → +
for → =    global → => isnot → -   arenot → -    isnt → -   aint → -
remove → - is! → -     are! → -    ! → -
/ → ?      else → ||   val → ~
is? → ?    are? → ?    size → ?    is?! → ?!     are?! → ?!
equals → == with → +=  without → -=  . → *
from → :   each → _    import → << export → >>  require → @
$log → $print           $debug → $print?
```

Aliases are skipped inside `sequence` and `table` bodies (those are re-parsed with an empty alias/phrase table — see 4.3).

### 3.5 Phrases
A facet also provides a multi-token rewrite table `phrases: { pattern: replacement }`. Phrases run after the linear token stream is built (not on raw text), so a phrase can match a mixed sequence of word/string/number tokens. Within a phrase:
- A bare `$` (treated as a resource with empty value) matches any single token. Each `$` consumes one token and is captured positionally.
- `$1`, `$2`, … in the replacement reference the captured tokens (1-based) and copy them in.
- Other tokens in the pattern require a literal type+value match.

Default facet phrases:

```
"$ to be $"                           → "$1 = $2"
"let $ be $"                          → "$1 = $2"
"is not"                              → "-"
"are not"                             → "-"
"$ is a $"                            → "$1 + $2"
"$ is an $"                           → "$1 + $2"
"$ is the $"                          → "$1 + $2"
"$ or $"                              → "$1 || $2"
"when $ is $ they become $"           → "($1 $2) ... { $el is $3 }"
```

The `when … is … they become …` phrase is configuration-as-code: it expands
to a continuation declaration, so `when apple is rotten they become brown`
registers the rule "whenever `apple` gains the `rotten` effect, give it the
`brown` state." (The replacement shape was revised from an earlier sketch to
a real `...` continuation; the original `$1, $2 .. { … }` form never had a
working meaning.)

Note a deliberate sharp edge: because phrase patterns are matched **after**
alias rewriting, `is` and `+` are indistinguishable to the matcher (both are
`+`). The article phrases (`$ is a $`, `$ is an $`, `$ is the $`) therefore
also match `X + a Y` / `X + an Y` / `X + the Y`. Avoid using `a`, `an`, or
`the` as variable names immediately after `+` if these phrases are active.

Phrases are applied left-to-right across the full top-level token list. Each successful match advances past the replacement; on a partial mismatch, the cursor backs up to the token after the start of the failed attempt and restarts. Phrases do **not** apply inside unparsed block bodies — they only run on sequences that are actually parsed.

### 3.6 Lazy compound parsing
`block`, `sequence`, `list`, `table` carry their interior text as `value`. The interior is parsed lazily, on first call to a `getSequence()` method, into another linked token list. While parsing the interior:
- `block` and `list` inherit the enclosing facet's aliases and phrases.
- `sequence` and `table` are parsed with an *empty* alias/phrase table.
- `template` carries a `parse()` that re-parses its interior with empty alias/phrase tables; this is used to back string interpolation.

### 3.7 Parser output
The parser yields `{ sequence, resources }` where `sequence` is the head of a singly-linked list of token objects:

```js
{ value, type, line, position, next, toString(),
  getSequence?, parse?, sequence? }
```

`resources` is the deduplicated list of `$name` references that appeared at parse time; it is used at run time to ask the user for any unresolved resource (interactive mode).

---

## 4. Runtime Model

### 4.1 Core types

| Type     | Carries                                  | `value()` returns           | `type` field    |
|----------|------------------------------------------|-----------------------------|-----------------|
| element  | `states: string[]`                       | `this.type` (its name)      | the element name|
| value    | `val: any`, `valueType: string`          | `this.val`                  | type-specific   |
| string   | extends value(`'string'`)                | the underlying JS string    | `'string'`      |
| number   | extends value(`'number'`)                | the underlying JS number    | `'number'`      |
| list     | `states: any[]`                          | `this.states` array         | `'list'`        |
| table    | `states: string[]` columns, `struct: {col→array}`, `count` | `this` | `'table'`       |
| vector   | `val: function`, `type: name`            | wrapper for callable        | name or `'vector'` |
| word     | `word: string`                           | itself (used internally)    | n/a             |
| env      | extends element with properties, resources, modes, constructors, continuations, returns | `this.type` | env name |
| there    | top-level env with IO bindings           | as env                       | `'there'`       |

All types implement a common set of effect methods (see 4.2). Concrete behavior depends on the type.

### 4.2 Effect methods (operator vocabulary)

The default facet's operator globals are thin wrappers that dispatch by name to these methods on the source object:

| Operator (after aliasing) | Method called on source | Notes |
|---------------------------|-------------------------|-------|
| `+` (`is`, `are`, `add`, `and`) | `is(value)`           | append/concatenate/extend |
| `-` (`isnot`, `remove`, `!` etc.) | `not(value)`        | remove/subtract |
| `?` (`is?`, `are?`, `size`, `/` for strings) | `size(value)` | "how many of" / find / divide |
| `?!` (`is?!`, `are?!`)    | `is_not(value)`         | inequality |
| `has`                     | `set(value)`            | env: set property by type |
| `has!`                    | `remove(value)`         | env: remove property |
| `*` (`.`)                 | `get(value)`            | index/access/multiply |
| `%`                       | `rest(value)`           | remainder/leftover |
| `has?`                    | `has(value)`            | env: property exists |
| `has?!`                   | `has_not(value)`        | env: property missing |
| `+=` (`with`)             | `extend(value)`         | non-mutating extension copy |
| `-=` (`without`)          | `reduce(value)`         | non-mutating reduction copy |
| `==` (`equals`)           | `eq(value)`             | equality probe (0/1) |

Operator dispatch shape (each is registered as a global with `arity = 1`):

```
fn(source, params, there) → source[method].apply(source, params)
```

Per-type meaning:

- **element**: `is` pushes a state; `not` removes one occurrence; `size(t)` returns 1 + count of `t` in states (i.e., counts the type itself plus state occurrences); `is_not(t)` returns 1 iff `size(t) == 0`; `rest(t)` returns `states.length - size(t)`; `extend(t)` clones and `is`es; `reduce(t)` clones and `not`s; `eq(t)` compares `value().toString()` against `t.value && t.value() || t`; `get(n)` with number returns `states[n]` else returns `this`; `each(items, fn)` iterates if `items.forEach` exists otherwise calls `fn(items)`.
- **string**: `is(v)` appends string-coerced `v`; `not(v)` removes all occurrences; `size(v)` counts occurrences; `rest(v)` returns length of leftover after removing all `v`; `get(v)` with number returns the char at that index, with string returns `indexOf(v)`, otherwise concatenates; `is_not(v)` returns 1 iff `!=`; `extend`/`reduce` clone first.
- **number**: `is(v)` adds; `not(v)` subtracts; `get(v)` multiplies (mutating); `size(v)` divides (`/`); `rest(v)` modulo; `is_not(v)` returns 1 iff `!=`; `extend`/`reduce` clone.
- **list**: `is(t)` pushes (handles array or `next` iterable via `each`); `extend`/`reduce` clone via `create()`; `value()` returns `this.states`. `checkType(t)` calls `t.value()` if a function.
- **table**: see 4.4.
- **env** (and `there`): `set(el, name)` stores under `name` or `el.type` in `properties`; `get(t)` reads; `remove(t)` deletes; `has(t)`/`has_not(t)`; `is(el)` = `set(el)`; `not(t)` = `remove(t)`; `size(t)` = `has(t)`.

Notes:
- The shared `valueType(val)` predicate is true when `val.type` is one of `string`, `number`, `list` — used by the *history* and *constructor* logic to decide whether a particular state involves a value-bearing object.
- When the source of an operator is `null`/undefined, the operator implementation substitutes the active `there` (see `ensure(source, there)` in `lib/integ/config.js`).
- `beforeEval` is an optional hook attached by the history mechanism; when present it is called at the start of `size`, `extend`, `reduce` to flush pending introductions/reductions.

### 4.3 Vectors (blocks as callables)

A `block` token evaluates to a *vector* — a callable. Its body is the lazily-parsed inner sequence. Calling a vector:

1. Look ahead for a `sequence` token in the next position. If found, evaluate it; if it is an *iterator* (see 4.7), it is consumed as a *parser specifier*:
   - If the iterator's first element is a `number`, that becomes `arity` (consume exactly N positional params, evaluated, no naming).
   - Otherwise build a *parser function* (see 4.5).
2. If the vector has a parser, run it on the upcoming tokens to extract `{ params, names, obj }`. If it fails to match, the call short-circuits and the source flows through unchanged.
3. If the vector has `arity` only, evaluate that many positional tokens.
4. Otherwise call `defaultParams(obj, …)`: consume tokens until a `switch` (`;`) or end of stream, evaluating each.
5. Invoke the implementation function with `(source, params, there, paramNames)`.
6. If the result is another callable (function or value-with-function-`val`), and there are still tokens to consume, wrap it as an anonymous vector and continue calling — i.e., chaining.
7. Wrap primitives in their corresponding wrappers (`number` → number type, `string` → string type, array → list, function → vector, word → `word.word`).

Body invocation creates a child `env`:
- Forked unless the body opts into "reflected" execution (constructor/iteration paths set `e.reflected = true`).
- `resources` for special params are populated: `el` (the source), `args` (full param list), `argNames` (the names list), and each named param is stored under both its name and its 1-based positional index `'1'`, `'2'`, … . `$i` is the iteration index when iterating.
- The block sequence is evaluated in this env. The final result is returned. If the env has accumulated `returns`, those replace the result.

Continuations registered against a vector (see 4.6) run after the main invocation and may replace the result.

### 4.4 Tables

A `table` is a column-oriented store. It is constructed from a sequence whose tokens (after evaluation) become the column names. The runtime maintains `struct: { col → array }` and a `count` of rows.

| Op | Behavior |
|----|----------|
| `+` / `is` / `add` | Iterates the argument (array or iterable) and inserts the i-th value into the i-th column. Multi-add via `add … and …` works because `+` consumes multiple params. |
| `-` / `not` | Removes by row index (number) or by search vector (list/iterable, where each entry must match the corresponding column; `*` is wildcard). |
| `*` / `get` | Number → returns row as array (or `count` if out of bounds). List/iterable → search across columns (`*` wildcard). String → row regex search against `col1,col2,…` after replacing `,` with space. |
| `_` (iteration) | Yields `{__tr: true, col1: …, col2: …}` for each row. |
| `data()` | Returns `struct` directly. |

### 4.5 Parser specifier (the `(…)` after a block)

When a vector is followed by a `(...)` sequence, the iterator's elements become the parser:

- `$name` — capture the next token's evaluated value, bind it to the local name `name`.
- `$name { … }` — same, but the default value is the result of evaluating the inline block at definition time (used for closures / capture-by-value).
- `$$name` — closure capture: read `name` from the enclosing `there.resources` (or `properties`) **now**, at definition time, and pre-bind it. `$$X` is the closure shorthand.
- A `word` whose value is `*` — match any single token (consumed, not captured).
- A `word` whose value is a JS regex literal-fragment (typically created via `[a|b|]`) — match by `new RegExp(value).test(token.value)`. Mismatch ⇒ parser fails.
- A `block` inside the parser specifier is dropped (it serves as a default-value binding for a preceding `$name`).
- If matching fails part-way, the vector call is a no-op (the source flows through unchanged).

Examples (from tests and examples):
- `a = { book is $a; book is $b }; a ($a $b) red green` → `a` named `a, b`.
- `a (…$a [and|or] $b)` regex-matches the literal `and` or `or`.
- `a (… $a * $b)` skips a token.
- `({ … } ($a{$a} $b))` — captures `$a` at definition with current value, then expects positional `$b` at call.
- `(?colorCheck) : { … }` — leading `?` on a constructor's type means "do not cache the constructor's product."

There is also a *block-time* parser annotation: a block followed by `(…)` after the entire definition (e.g., `f = { … } ($a $b)`) attaches the parser permanently to the vector before the call site even sees it.

### 4.6 Continuations (`...`)

Syntax: `(target effect) ... { body }` — registers a continuation against a vector named `effect`. When that vector is invoked and the inspections match, the body runs after the primary invocation. The target/effect tuple matches when the *element type* matches the target (or target is `*`) and one of the call's params matches the effect (by `===` or `isOf`).

Stored on the env in `continuations: { effect → [ {vector, target, effect, fn} ] }`. The implementation lives in `lib/lang/vector.js#findContinuations` and `lib/lang/env.js#continuation`.

The `…` operator (alias of nothing; tokenized as the word `...`) is implemented in the default facet as: read up to three tokens from the source iterator (`vector target effect`) — if only one is given it becomes `effect` with defaults `vector='+', target='*'`; if two, `target effect`. Then register `cb` (a block from `parameters[0]`).

### 4.7 Iterators, sequences, ranges

A `sequence` token, when evaluated, yields a value with a `next(cb, raw)` method. There are two implementations:

- **iterator**: walks the parsed sequence; each step calls `cb(value)`. If the user-supplied `cb` returns a falsy value (not `undefined`), iteration stops early. Stores the head sequence on `__internal` so callers can introspect (e.g., for arity).
- **range**: detected when the second token is the literal word `..`. Start, end, optional step. If the start is a `word` token, treats it as a character range; otherwise numeric. Capped at 100 iterations as a safety. Walks via `findNext(i) → start + i` (or alpha equivalent), stopping when `> end`.

A `list` token also has `next(cb)` semantics (it iterates `states` and is treated as iterable). A `table` is iterable too, yielding row objects.

### 4.8 The `_` (each) operator

The `_` global handles iteration / control. Signature: `source _ body` (with `body` a vector/block):

- If `source.value()` is a function, evaluate it first.
- If `source.next` is a function → iterate the elements, running `body` with `$el = item`, `$i = index`.
- If `source` is a JS Array → iterate likewise.
- If `source` is a `number` (or wraps one) → loop that many times, with `$i = 0..N-1`. The body runs in a forked env with `properties` set to `Object.create(there.properties)` (so writes are visible upward only if explicitly exported).
- If `source` is a `string` (or wraps one) → IO mode: `ask(source + '\n')` and supply the answer as `$el` to one invocation of `body`. Returns a value with `await(fn)` semantics; the evaluator's async path waits on this.

Inside the body, `$el` is the current item, `$i` is the index, plus all params from the parser specifier and any inherited resources.

When the body runs over a table row, the row's columns are copied into the iteration env's `resources` so they appear as `$col`.

### 4.9 `||` (else / chaining)

`||` is the alias of `else`. Implementation: if the previous expression yielded a value that did *not* run an iteration (no `_ft` flag), run the body. Used as:

```
condition _ { then-branch } || { else-branch } || { else-else-branch }
```

The chain works because `_` tags its produced env with `_ft = true` to signal "I did run."

### 4.10 `~` (value vector)

`val` / `~` defines a deferred-value vector. Given `obj ~ { body }` the body is stored as `_val` on `obj`; `obj.value()` will run the block in a fork and return its result. Given `obj ~ literal`, `_val` returns `literal` unwrapped. Used for `(name) : { … }` to make `name.value()` lazy.

### 4.11 `=` and `=>` assignment

`=` (also `let X be Y`, `X to be Y`) binds a name. The LHS identifier is the
source-text word, captured *before* the RHS is evaluated (evaluating the RHS
would otherwise clobber the "last word" tracker). Behavior:

- The RHS is unwrapped (sequences) and, if it is a raw primitive, wrapped in
  the matching element (so `name = (a % b)` holds a `number`, not a bare JS
  value, and can later carry `~` / states).
- If the RHS is a vector with the default type `vector`, it is renamed to the
  bound name (so the vector's `type` is its identifier — used by continuations
  and the history frame stack).
- **Scoping.** If the name is already an *own* property of the current env and
  holds a real value, the assignment is a no-op and a warning is emitted via
  `there.out('Assignment for X is ignored', 1)`. Otherwise the value is bound
  in the current env — which means a name inherited from an ancestor env is
  *shadowed* locally, giving vector bodies real local variables.

The `+` operator also introduces names: `name is <value>` on a fresh,
stateless element binds the value to the name when the value is "bindable"
(a vector, string, number, list, table, or non-root env). This is why the
examples define everything with `is` (`color is { … }`, `h is 'hello'`).
Element-valued params still push states (`apple is red`).

`=>` (alias of `global`) does the same as `=` and additionally calls
`there.globalize(name, value)` so the name appears in the env-root `there`'s
`globals` map. Globals resolve against the env chain's root first (so a
module's vectors see the module's own globals), then the ambient evaluator
`there` as a fallback (so a body running inside another module via `$env{m}`
can still reach the globals from where it was defined).

### 4.12 Modules: `@` `<<` `>>`

- `source @ moduleName` (alias `require`) — loads `moduleName`. Resolution
  order: relative to the requiring program's directory (a `moduleName/`
  directory with an `index.th`, or a `moduleName.th` file), then the runtime's
  built-in `src/modules/` directory. Returns the loaded module's `there`,
  cached per absolute path (loaded once per process). Stored under
  `moduleName` (or the name on the left of `@`) in the calling env's
  `properties`. The module runs in its own `there` sharing the parent's IO.
- `name <<` — alias `import`. Three modes:
  1. With no name (or `name == this.type`): pull all `argNames`/`args` from `resources` into `properties`. Used to "open" a vector's arguments into the local scope.
  2. `name <<` — walks `parent` chain looking for a property named `name`, falling back to `resources[name]` (by `_name` then by checkType); copies into `properties[name]`.
  3. `name << other` — same as case 2 but renames.
- `name >>` — alias `export`. With no second arg, push `el.extend()` onto the env's `returns` array. With a second arg, push under that name into the *parent* env's `properties`.

Multi-return: when a block produces multiple `>>` calls without names, all
exports are returned as a `list` the caller can index (`gen * 0`) or iterate;
a single export is returned bare.

### 4.13 Constructors (`:`)

`(name) : block` (alias `from`) — registers `name` as a constructor. When the language later sees a bare `name` token and no env property is named that yet, the constructor's block is run in a fresh fork of the env (with `Object.create(parent.properties)`), the result is stored under `_name = name`, and the resulting object is returned. If `name` started with `?` (e.g. `(?dynamic) : …`), `stored = false` and the constructor is *not* cached on first use, so subsequent uses re-run the block (dynamic / live binding).

### 4.14 Modes

`mode name on|off` — toggles a named mode on the env. Modes inherit through the prototype chain because `e.modes = Object.create(parent.modes)`.

Known modes:
- `auto-read` — when reading an unknown `$name` resource, allocate a positional resource `$1`, `$2`, … from `resources` automatically. Used so that `mode auto-read on; a = { book is $color }; a red green` works.
- `history` — when on, `+` and `-` effects on typed elements are journaled so they can be replayed and reverted (see 4.15). By default this mode is *off*.

### 4.15 History

When `mode history on` is set, every `+` / `-` effect on a *typed* element
(not a value type; param not a vector/table/env) is appended to a per-element
journal. Each entry records the op (`+`/`-`), the state name, a *group* id (a
monotonic sequence number — one root operation is one group), and *tags*: the
names of the vector bodies executing at the time (the history frame stack)
plus any sessions opened with `start`. The journal has a cursor: entries
before it are *applied*, entries after it are the *redo tail*.

History commands operate on the source element and never record themselves:

| Command | Effect |
|---------|--------|
| `el repeat` | re-apply the most recent group (as a new group) |
| `el undo` | revert the most recent applied group, moving the cursor back |
| `el redo` | re-apply the most recently undone group |
| `el learn { … }` | run the block on `el`, journaling all its effects as ONE group tagged with the block's name (or `lesson`) |
| `el start name` | begin tagging subsequent effects on `el` with `name` |
| `el stop name` | stop tagging with `name` |
| `el forget name` | revert and erase every journal entry tagged `name` |

Reverting applies the inverse op (`+`→`-`, `-`→`+`); a fresh effect truncates
the redo tail. With history off, the commands are no-ops on an empty journal.

### 4.16 Resources

Per-env `resources` map. Names without `$` prefix at storage time, prefixed when referenced (the parser strips the `$` to get the resource name). When evaluating a `resource` token:
1. Look up by exact name in the current env's `resources`.
2. If absent and `auto-read` mode is on, allocate the next positional `'1'`, `'2'`, …
3. If still absent, throw `'Undefined resource:NAME'`.
4. If the resource is a function, wrap it in a vector and call it like any other operator.

At parse time, every `$name` is recorded in `parser.resources`. Before evaluation, the evaluator's `_resourceCheck` asks the user for each one whose value is missing from the facet's resources (interactive mode). If `evaluator.defaultInput` is set, the answer auto-fills after a 1s timeout.

#### Built-in resources (default facet)

- `$print` (alias `$log`): if source has `.value()`, output its value; else `JSON.stringify(source)`. Returns source.
- `$print?` (alias `$debug`): always `JSON.stringify(source)`.
- `$error`: like `$print` but printed with red ANSI escape (out flag 1).
- `$time`: 0-arity. Returns `Date.now()` as a JS number.

#### Module-provided resources (built-in modules)

- `utils` (`modules_there/utils`): globals `toLower`, `toUpper`, `toChars`, `sort` (each 0-arity, operate on `source.value()`). Plus `index.th` defines `lower`, `upper`, `tokens`, `sortList` as wrappers.
- `where`: a tiny test framework. Phrases: `$ should be $ → $1 should $2`, `$ should eq $ → $1 should $2`. `index.th` defines `>`, `should`, `fail`, `pass`, `result`, `skip`, `only`, `all`, `one`. Tests are stored in a table `|describe test|`.
- `io` (in `examples/io`): `$file` resource for read/write of a file. With a string source: write source to file. With anything else: read file into env property named after source's type.
- `rand` (in `examples/rand`): `$rand` resource picks a random element of a `list` param.
- `glang` (in `examples/glang`): phrases-only facet.

### 4.17 The IO bindings on `there`

The top-level env is a `there` object that adds:
- `out(text, flag?)` — write to console, with optional ANSI color (1 = red).
- `ask(text, cb)` — `readline.question(text, cb)`.
- `close()` — close `readline`.
- `interaction()` — return the underlying readline interface (modules reuse it).
- `globalize(name, obj)` — write to the facet's `globals` map.

When the runner is invoked as a REPL (`bin/there` with no arg), it also wires `auto-read = true` and tracks history through a `.history` file.

---

## 5. Evaluation Algorithm

```
eval(program, result=null, there=newOrPassedThere, done?, skipHistoryReload=false)
  if !skipHistoryReload: history.reload()
  if program.sequence: program = program.sequence
  if !done:                              # synchronous
    while obj: { result, obj } = evaluate(obj, result, there)
    return result
  else:                                  # async — resource resolution + IO awaits
    resourceCheck(program.resources)
    walk obj; if a step produces a value with .await(fn), wait
    on completion: done(finalResult)
```

```
evaluate(obj, result, there, silent=false):
  switch obj.type:
    case 'switch':    return (there, obj.next)
    case 'string':    return (new String(obj.value), obj.next)
    case 'template':  interpolate obj.parse() into string; return (new String(val), obj.next)
    case 'number':    return (new Number(obj.value), obj.next)
    case 'resource':  lookup → if function: wrap as vector and .call(); else return (value, obj.next)
    case 'word':
      if value in {'there', ';'}: return (there, obj.next)
      look up in there.properties; else in globals; else if constructor: instantiate;
        else create a fresh element; store back into there.properties
      if it is a vector and !silent: .call(result, obj, there, this)
      else return (item, obj.next)
    case 'list':      return (new List(obj.getSequence(), there, evaluator), obj.next)
    case 'table':     return (new Table(obj.getSequence(), there, evaluator), obj.next)
    case 'sequence':  return (iterator.seq(obj.getSequence(), there, evaluator), obj.next)
    case 'block':     wrap body as a vector with optional parser specifier from next token
```

Notes:
- `there` is constructed once per evaluation root from the facet's resources / readline / globals. If the caller passes an `env`, it is used as-is. Defaults set `dir = process.cwd()`, `file = dir/index.th`.
- `silent=true` is used when peeking forward (e.g., parser specifier resolution): a `word` returns the item without invoking it as a vector.
- The async path treats any returned value with an `await(fn)` method as a continuation point and waits.

### 5.1 Template interpolation

`` `…${ JS-expr-or-body }…` `` — each `${ … }` is evaluated as host
JavaScript with the enclosing env's properties available as locals (values
unwrapped: numbers/strings to their primitive, lists to their array). A
fragment containing a `return` or multiple statements is used as a function
body verbatim; a bare expression (`${a + 3}`) is wrapped so it returns its
value. Errors are swallowed to `''`. Literal text outside `${ }` is emitted
verbatim with the usual `\n` / `\t` / `` \` `` escapes.

### 5.2 Default-input fallback

`evaluator.defaultInput`, if non-null, is fed into the readline interface 1 second after a resource prompt — useful for tests and scripted runs.

---

## 6. Standard Surface (Default Facet `integ`)

Aliases and phrases: see 3.4 and 3.5.

Globals (each registered with `arity = 1` unless noted otherwise):

```
+   is, are, add, and        → source.is(params...)
-   not, isnot, remove, !    → source.not(params...)
?   is?, are?, size, /       → source.size(params...)
?!  is?!, are?!              → source.is_not(params...)
*   get / multiply / index   → source.get(params...)
%                            → source.rest(params...)
has                          → source.set(params...)
has!                         → source.remove(params...)
has?                         → source.has(params...)
has?!                        → source.has_not(params...)
+=  with                     → source.extend(params...)
-=  without                  → source.reduce(params...)
==  equals                   → source.eq(params...)
<<  import                   → there.import(source, params[0])
>>  export                   → there.export(source, params[0])
@   require                  → there.require(source, params[0])
:   from                     → constructor declare
=                            → assignment (see 4.11)
=>  global                   → assignment + globalize
mode                         → enable/disable a mode
... (no alias; word)         → continuation declaration
_   each                     → iteration (see 4.8)
||  else                     → else-chain (see 4.9)
~   val                      → value vector (see 4.10)
repeat undo redo learn       → history commands (see 4.15; arity 0 except
forget start stop               learn/forget/start/stop)
number string element list   → type conversions (see 6.1)
sequence block scope
```

Resources: `$print`, `$print?`, `$error`, `$time` (see 4.16).

### 6.1 Type conversions

Each conversion global takes one value-shaped argument and returns a new value
of the target type. They are **value-only**: a bare type word that follows an
operator stays a probe rather than being consumed as an argument, so
`$words ? list` reads "how many in `$words`", not "convert `list`". Called with
no value argument, a conversion returns an element named after the type (so
the type name itself is a usable token).

| Global | From → To |
|--------|-----------|
| `number v` | coerce to a `number` (`number '12'` → 12) |
| `string v` | coerce to a `string` (`string 12` → `'12'`; renders a lazy `~` value) |
| `element v` | an element named after the value (`element 'apple'`) |
| `list v` | a `list`: copy a list, rows of a table, items of a sequence/block, or wrap a single value (`list 'x'` → `['x']`) |
| `sequence v` | a sequence of tokens from a list / block / value |
| `block v` | a runnable block (vector) from a list / sequence / value — string items become bare code tokens, so `block ['plum' '+' 'red']` runs `plum + red` |
| `scope v` | an env holding the value under its type name |

A `history` object is installed on the facet; used only if the `history` mode is on.

---

## 7. Special Built-in Names

- `there` (word) — returns the current `there` env (the top of the chain at the current call site).
- `;` (word at the parse level, `switch` type) — a soft separator. Evaluation passes through it unchanged. Used by `defaultParams` to stop consuming arguments.
- `$el` — in a block invocation, holds the source that the block was called on.
- `$args` — list of params passed.
- `$argNames` — list of param names (same length as `$args`).
- `$env` — when a block's parser specifier includes `$env`, the named env replaces the body's `there`. Pattern: `f = { … } ($env{module})` makes the body run inside `module`.
- `$i` — the current iteration index inside `_`.
- `$1`, `$2`, … — positional aliases for params (same value as the named param if any).
- `$$name` — closure shorthand: bind `name` at definition time.

---

## 8. Module Loading Algorithm (`require.js`)

```
require(facetPath, baseDir, parent, programExtend):
  filePath = baseDir/facetPath
  if !exists(filePath): filePath = <runtime>/modules_there/facetPath
  context = facet(filePath)             # loads config.js
  parser  = parse(context)
  evaluator = evaluate(context, parent && parent.interaction())
  thFile  = filePath/<context.index>.th # default index = "index"
  there   = evaluator.there({ dir: facetPath, file: thFile })
  program = exists(thFile) ? readFile(thFile) : null
  if programExtend: program = (program || '') + '\n' + programExtend
  if program: evaluator.eval(parser.parse(program), null, there, () => parent && log "loaded")
  return there
```

Notes:
- The loaded module reuses the parent's readline so prompts/inputs share an interactive session.
- The module's `there` is stored under its name in the calling env's `properties`. Subsequent `module name` references go through the env's standard lookup.
- The `where` and `bin/where` wrapper use the `programExtend` argument to append a runner suffix (`{body}\nall;\n"done" $print`).

---

## 9. Entry Points (Reference Behaviors)

- `bin/there [path] [facetPath]` — runs a file. If `path` is a directory, run its `index.th`. With no `path`, start the REPL. Facet path is optional (defaults to `integ`).
- `bin/therepile path` — pretty-prints the parsed AST of a `.th` file.
- `bin/where path` — runs the `where` test facet over the file or directory.

REPL commands (line-only): `help` / `\?`, `clear` / `\c`, `silence` / `\s`, `exit` / `\q`. History is persisted to `./.history`.

Profiler: `lib/profiler.js` is a stopwatch keyed by operator name; enabled = false by default in non-REPL mode. Optional to implement.

---

## 10. Error Semantics

- Unknown resource → throw the string `'Undefined resource:<name>'`.
- Unmatched parser specifier → silent: the vector call is a no-op and the source flows through.
- Assignment to an already-valued name → warning via `there.out('Assignment for X is ignored', 1)` and return the existing value.
- Constructor double-declaration → no-op (only the first sticks).
- Stack overflow in unrestricted iteration is possible (no recursion limit beyond the alpha-range 100 cap).

---

## 11. Test Coverage Reference

A reimplementation should pass every assertion under `test/`:

- `test/parse.js` — token shape, comments, strings/templates/numbers/resources, blocks/sequences/lists/tables, multi-line, aliases, phrases.
- `test/evaluate.js` — primitive build/extend, type field, vectors, globals on `there`, `$print`/`$print?`, resource asking.
- `test/types.js` — continuations (`(target effect) ... { … }`), utility-module roundtrip, value-vector via `~`, template interpolation.
- `test/iterable.js` — `_` over args/lists/sequences/numbers/strings (with `ask`)/ranges (numeric, alpha, stepped, dynamic).
- `test/vector.js` — block parameters, named/regex/wildcard parser specifiers, arity, closures (`$$x`), `<<`/`>>`/`=>`, multi-return, generators, control statements (`?! _ { } else { } else { }`), env passing (`$env`).
- `test/table.js` — column construction, add (`+`/`add`), remove by index / search, iteration, indexed get, list/regex search.
- `test/value.js` — string concat, find, index; number add/sub/div; list `add`; resource-produced typed values.

These specs are the source of truth for behavior when this document is ambiguous.

---

## 12. Worked Examples (Quick Reference)

```th
# 1. Effects on an env element (default history off — so order matters)
there is apple;        # adds 'apple' to there.states
apple is red;          # creates element 'apple' (auto), pushes 'red' state
apple is? red $print;  # prints 1
apple is! red;         # removes 'red'

# 2. Block as named callable
color = { $el is red };
plum color;            # plum becomes an element with state 'red'

# 3. Parser specifier
fmt = { '' + $what + ' is ' + $color $print } ($what $color);
fmt apple red;         # prints "apple is red"

# 4. Iteration with $i and side effects
total = 0;
11 _ { total + $i };
total $print;          # 55

# 5. Range
(1 .. 6 2) _ { sum + $el };

# 6. Constructor (cached)
a = { book is $1; book is $2 };
(book) : { a red green };
book;                   # element 'book' with states 'red','green'

# 7. Continuations
(rotten) ... { $el is brown };
apple is rotten;        # because of continuation: 'apple' becomes 'brown'

# 8. Modules
@ utils;                 # loads utils
(s) : { utils . lower 'BLAH' };   # 'blah'

# 9. Closures
f = { { $a + $b } ($$a $b) } ($a);
f 5 4;                   # 9

# 10. Multi-return
gen = { a = 12; b = 10; a >>; b >>; };
gen;                     # returns a list [12, 10] (index with gen * 0)

# 11. Template
a = 12; b = `${a + 3}`;  # b is "15"

# 12. Table
t = |key value|;
t + ["a" 1]; t + ["b" 2];
t * ["a"];              # [["a",1]]

# 13. Control with else
1 ?! 1 _ { a + 2 } else { a + 3 } else { a + 4 };  # a is 3
```

---

## 13. Inline facet blocks

A program can carry its own dialect and its own host pieces inline, so a
single `.th` file is self-contained — no sidecar `config.js`, no facet path on
the command line. This is the canonical surface (see `examples/promo/`).

### 13.1 Syntax

A facet block is a fenced region opened by ` ```facet ` on its own and closed
by ` ``` `. Inside, one or more of the four facet tables are declared with
ordinary there-flavored assignment — `key = { … }` — using string literals
for phrases/aliases and template literals for host-coded resources/globals:

```
```facet
phrases = {
    '$ does $'  : '$1 = $2'
    'the hero attacks the dragon' : 'hero attacking dragon'
}
aliases = {
    'add'    : 'plus'
}
resources = {
    rand : `${
        var max = Number(parameters[0] && parameters[0].value());
        return there.create('number', Math.floor(Math.random() * max) + 1);
    }` (n)
}
globals = {
    toLower : `${ return there.create('string', String(source.value()).toLowerCase()); }`
}
```
```

- `phrases` / `aliases` are `'pattern' : 'replacement'` string pairs.
- `resources` / `globals` are `name : \`${ …JS body… }\` (params)` entries.
  The JS body sees `parameters`, `source`, `there`, `env`; its arity is the
  number of `(params)` names. A `globals` entry is callable as an operator
  word; a `resources` entry is referenced as `$name`.

### 13.2 Semantics

- Facet blocks are extracted textually at parse time, before tokenizing the
  body, and stripped from the source so they leave no runtime trace.
- `phrases` / `aliases` are merged onto a copy of the active facet (inline
  entries appended after, so they refine or override) and used to parse the
  rest of that file only.
- `resources` / `globals` are compiled to host functions and installed on the
  file's `there` (globals also into its `globals` map).
- Nothing leaks into modules loaded via `@`: a module declares its own facet
  block. Multiple facet blocks merge in order.

### 13.3 Host-code trust

`resources` / `globals` bodies are raw host JavaScript run via `new
Function`. That is an intentional escape hatch (the only host code most
programs need is a one-line `$rand`), but it means running an untrusted `.th`
file with facet blocks is equivalent to running untrusted JS. A safe
declarative subset (phrase/alias-only, or resources that merely reference
facets already on disk) is the natural future hardening; today the full power
is available without a trust gate.

---

## 14. Implementation Checklist

A reimplementation is done when it can:

1. Tokenize all token types in 3.2 and apply lazy compound parsing.
2. Apply facet aliases at tokenization time and facet phrases over the linear token stream (including `$N` substitution and the rewinding semantics).
3. Construct the `there` env with `out` / `ask` / `globalize` / `create` and a module `baseDir`.
4. Implement all runtime types (element, string, number, list, table, vector, env, there) with the effect methods listed in 4.2 and the per-type semantics in 4.4 / list / string / number.
5. Implement vector calling with parser specifier (`$name`, `$$name`, `*`, regex, `$env`, arity-via-number), call-site specs, and callable-result chaining (4.3).
6. Implement `_`, `||`, `~`, `:` (constructor with optional `?` no-cache, honoring its parser spec), `=`, `=>`, `mode`, `...` (continuations on operators *and* named vectors), `<<`, `>>`, `@`.
7. Implement iteration over numbers, lists, sequences/enumerations, ranges (numeric and alpha, with optional step), strings (IO ask), tables (rows as resources).
8. Implement template interpolation via a JS host (`new Function`), expression and statement-body forms.
9. Implement resource prompting (`resourceCheck` + `defaultInput`).
10. Implement module loading per 8 (relative dir, then built-in `src/modules/`).
11. Implement history mode commands `repeat` / `undo` / `redo` / `learn` / `forget` / `start` / `stop` (mode flag opt-in; see 4.15).
12. Implement type conversions `number` / `string` / `element` / `list` / `sequence` / `block` / `scope` (see 6.1).
13. Implement inline facet blocks (see 13).
14. Pass every assertion in `test/`.
15. Run the `examples/*.th` files without errors and produce the documented results.

End of specification.
