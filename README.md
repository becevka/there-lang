# there

A small language where the program reads like sentences, effects are
first-class, and the grammar itself is something you write. Implemented in
TypeScript on Bun.

```th
there is apple;
apple is red;
apple is? red $print;     # 1

(rotten) ... { $el is brown };
apple is rotten;
apple is? brown $print;   # 1
```

That second block isn't a callback or a subscription. It's a
*continuation*: a rule the runtime evaluates whenever the named effect
happens, on whichever element matches. No event bus, no observer pattern,
no decorators — the language has one. See `PROMO.md` for the full pitch.

## Running

```sh
bun src/cli/there.ts <file.th>        # run a program (a dir loads its index.th)
bun src/cli/there.ts                   # REPL (help / clear / silence / exit)
bun src/cli/there.ts --where <test>    # run a test suite in the `where` facet
bun src/cli/there.ts --ast <file.th>   # pretty-print the parsed AST
bun test                               # unit + example integration tests
```

`bin/there`, `bin/where`, and `bin/therepile` wrap the run / test / AST
forms above for use on `PATH`.

## Examples

Worked, runnable programs live in `examples/`:

- `examples/promo/` — a turn-based duel, written twice: `natural.th` reads
  like storytelling phrases (with an inline `facet` block defining its own
  vocabulary), `canonical.th` is the same program spelled with plain
  operators. Start here — `examples/promo/README.md` walks through both.
- `examples/anagram/` — finds anagram candidates in a word list.
- `examples/clock/` — a wraparound HH:MM clock built on a lazy `~` renderer.
- `examples/fizzbuzz.th` — the classic, in `there`.
- `examples/lang-features.th`, `examples/lang-steps.th` — small syntax
  demonstrations.

Each directory-based example also has a `test.th`, runnable via
`bin/where examples/<name>`.

## Documentation

- `PROMO.md` — the pitch: what makes `there` different, with runnable
  snippets.
- `SPEC.md` — the authoritative language reference (lexical structure,
  runtime model, evaluation algorithm, standard surface).
- `REIMPLEMENTATION.md` — notes from porting the original implementation to
  this TypeScript/Bun codebase.

## Main syntax formula

Every statement follows one shape:

```
generator processor (collector) (parameters) (=> reducer)
```

- **generator** sets up an environment or selects an element.
- **processor** does something to it.
- **collector** describes how parameters are gathered.
- **parameters** are the typed inputs the processor expects.
- **reducer** optionally names or globalizes the result.

#### Example 1: the bare form

```th
there is apple;
```

**there** is a by-type generator: it initializes an environment for
`apple` to be processed in. **is** is the processor that acts on what was
collected. **apple** is a simple parameter, collected automatically, so
the collector and reducer are both omitted.

#### Example 2: the full form

```th
(apple) {age add $years} ($years:number) => makeOlder;
```

**(apple)** is a by-word generator: it checks the environment for
elements matching `apple` before the processor runs. **{age add $years}**
is the processor body. **($years:number)** is the parameter collector; it
types `$years` as a number and is *not* itself run. **=> makeOlder**
stores the whole processor under the name `makeOlder`.

```th
there is apple;
apple has age;
apple age is 0;
apple makeOlder 12;
apple age => $print;
apple makeOlder "12";      # not called: "12" is a string, not a number
```

#### Example 3: extra words and optional pieces

```th
(apple) {age add $years} (for $years:number years) => grew;
```

`for` and `years` are literal words the collector expects around the
typed parameter — parsed, but not captured.

```th
apple grew for 12 years;
apple grew 12 years;       # not called: "for" and "years" are required
```

Wrapping a word in `[...|]` makes it optional:

```th
(apple) {age add $years} ([for|] $years:number years) => grew;
```

```th
apple grew 12 years;       # now works: "for" is optional
```

Adding `?` to the type makes the *parameter itself* optional:

```th
(apple) {age add $years} ([for|] $years:?number [years|]) => grew;
```

```th
apple grew;                # works, but age is unchanged: `add ?` is a no-op
```

## Types

- **element** — the most basic type. It's abstract and never appears by
  itself; spaces and semicolons are elements too, though it's more useful
  to call those punctuation.
- **word** — a token that isn't yet resolved to a metatype. When you write
  `apple;`, the word `apple` is what generates access to the `apple`
  metatype.
- **metatype** — a word bound to a type of itself. Writing `apple;` turns
  the word `apple` into the metatype `apple`. Compare `apple is green`
  (accesses the metatype `apple`) with `(apple) is green` (creates a
  generator instead).
- **value** — a metatype with a `value` property. `12` is a `number`
  metatype whose value is `12`. Given `12 => a`, `12` is a value but `a`
  is a metatype (an object) bound to it.
- **number** — a value with a numeric `value`, written as an integer or
  decimal: `12`, `13.4`.
- **string** — a value with a string `value`, written in single or double
  quotes: `"this is a string"`, `'this is also a string'`.
- **block** — `{ ... }`, a lazily-parsed body that evaluates to a
  *vector*: a callable. Calling it runs its body in a fresh environment
  and returns the result (or its accumulated `returns`, if any). A block
  followed by `(...)` attaches a parameter collector to it, as in the
  examples above.

## License

MIT — see `LICENSE`.
