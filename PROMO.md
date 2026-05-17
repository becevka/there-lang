# there

> A small language where the program reads like sentences, effects are first-class, and the grammar itself is something you write.

## The pitch

Most languages give you functions and ask you to model the world out of them. `there` gives you an environment, things that exist *there*, and effects that happen *to* them. The result is a language that reads almost like English, stays open to local dialects, and treats reactive behavior, configuration, and testing as native ideas rather than libraries layered on top.

```th
there is apple;
apple is red;
apple is? red $print;     # 1

(rotten) ... { $el is brown };
apple is rotten;
apple is? brown $print;   # 1
```

That second block is not a callback or a subscription. It is a *continuation*: a rule the runtime evaluates whenever the named effect happens, on whichever element matches. No event bus, no observer pattern, no decorators. The language has one.

---

## The shape of every statement

Every line follows one formula:

```
generator   processor   (collector)   (parameters)   (=> reducer)
```

- The **generator** sets up an environment or selects an element.
- The **processor** does something to it.
- The **collector** describes how parameters are gathered.
- The **reducer** optionally names or globalizes the result.

```
apple        is          red                                        # bare form
(apple)      { age + $y } ($y:number years)         => grew         # full form
```

Once you see that shape, the rest of the language is mostly extending it.

---

## Concepts you don't get elsewhere

### 1. Effects are the primitive, not functions

In `there`, you describe what is true of a thing, then ask about it:

```th
book is red;
book is red;             # not idempotent, on purpose
book is? red $print;     # 2
book is! red;
book is? red $print;     # 1
```

Elements remember their states as a multiset, so "how often" is a real question, not a workaround. The same vocabulary works on strings, numbers, lists, and tables:

```th
'hello' + ' world';      # 'hello world'
'hello' - 'l';           # 'heo'
'hello' / 'l';           # 2  (count)
'hello' * 4;             # 'o' (index)
5 + 3;                   # 8
8 / 3;                   # 2.66 (size)
8 % 3;                   # 2   (rest)
```

`is`, `not`, `size`, `get`, `rest`, `extend`, `reduce`. Eight verbs, every type.

### 2. Words and resources: two namespaces on purpose

Every name that starts with `$` lives in a separate scope from plain words. The split is deliberate:

- **Words** are things in the world: `apple`, `book`, `color`.
- **Resources** are context: parameters, services, inputs, environment.

That separation is why you can have an element named `color` and a parameter named `$color` in the same block without collision. Continuations, constructors, and dynamic dispatch share one scope because nouns and pronouns never overlap.

```th
greet = { 'Hi, ' + $name $print } ($name);
greet 'Wolfgang';

speed = 12;                # speed is a word
f = { $el is $speed };     # $el is the call source; $speed is the captured param
23 f ($$speed);            # $$speed snapshots the outer 'speed' at definition time
```

A resource resolves in three steps:

1. If bound to a value, return it.
2. If bound to a function, vector-wrap and call it. This is how `$print`, `$time`, `$file`, `$rand` look like data but behave like operators.
3. If unbound: with `mode auto-read on`, allocate the next positional slot (`$1`, `$2`, ...). In the async runner, the parser has already collected every `$x` referenced anywhere in the program, and the runtime prompts the user for each missing one *before* evaluation starts.

```th
# missing resource becomes a user prompt — no input() call, no IO library
book is $color;       # asks: Enter the value for [color]:

# auto-read maps positional args to named resources
mode auto-read on;
a = { book is $color; book is $color2 };
a red green;          # $color = red, $color2 = green
```

The standard set is small (`$print`, `$print?`, `$error`, `$time`). Modules add more: `@ io` adds `$file`, `@ rand` adds `$rand`. Block invocation always provides `$el` (the source), `$i` (loop index), `$args`, `$argNames`, `$env`, plus positional `$1`, `$2`, ...

Words are nouns. Resources are pronouns and services. `$` marks "this name comes from context, not from the world I am describing."

### 3. Continuations replace event systems

Reactive logic in `there` lives next to the data it reacts to:

```th
(apple color) ... { apple is red };
(* color)     ... { $el is yellow };
(rotten)      ... { $el is brown };
```

When `color` is invoked on `apple`, the first rule fires. When `color` is invoked on anything else, the second fires. When *any* call passes `rotten`, the third fires. You write the rule once; the runtime finds it. No registration ceremony, no central dispatcher.

This collapses a lot of the boilerplate you would otherwise write with observers, hooks, signals, middleware, or AOP.

### 4. The language adapts to your domain via facets

A *facet* is a four-table bundle: `aliases`, `phrases`, `resources`, `globals`. Aliases rewrite single tokens (`is → +`). Phrases rewrite multi-token patterns:

```js
config.phrases = {
    'let $ be $'                          : '$1 = $2',
    '$ is a $'                            : '$1 + $2',
    'when $ is $ they become $'           : '($1, $2) .. { $el is $3 }'
};
```

With that facet active:

```th
let basket be [apples plums];
when apples is rotten they become brown;
```

The runtime sees only the rewritten form. Phrases are not macros: they happen during parsing, do not require recompilation, and are scoped per facet. A facet for a clock-arithmetic test suite looks different from a facet for shopping-list rules, and both run on the same core.

Compare this to embedded DSLs in host languages, where you fight your host's grammar and eventually settle for builder-pattern soup. In `there`, the DSL *is* the program.

### 5. Constructors are recipes, not classes

```th
plum    = { $el is purple };
peach   = { $el is orange };
basket  = { fruits = [] };

(myBasket)   : basket;
(myPlum)     : plum;
(myPeach)    : peach;
```

The `(name) : block` form runs the block once, caches the result under `name`, and uses that whenever `name` is mentioned. Prefix `?` to make it dynamic and re-run on every access:

```th
(?isRed) : { apple is? red };
isRed;          # 1
apple is! red;
isRed;          # 0
```

No `class`, `constructor`, `factory`, `provider`, `injection`, or DI container. One operator.

### 6. Iteration is one verb

`_` (read "each") works on numbers, lists, sequences, ranges, tables, and strings. The same syntax interactively asks the user when the source is a string:

```th
10 _ { $i $print };              # 0..9
[red green blue] _ { $el $print };
(1 .. 100 5) _ { sum + $el };    # 1, 6, 11, ... 96

'Your name?' _ { greeting + $el };  # asks the user; binds the answer to $el
```

Where other languages distinguish loops, comprehensions, async iteration, and prompts, `there` has the same shape for all of them.

### 7. Control flow without an `if`

There is no `if` keyword. A predicate returns a count, `_` runs its block that many times, and `||` (alias `else`) runs only when the previous `_` did not. Three operators you already know, no special grammar.

```th
# if / then
apple is? red _ { 'red apple' $print };

# if / else
val == n _ { 'Correct' $print } || { 'Wrong' $print };

# else-if chain (else is just an alias for ||)
score == 'A' _ { 'top'        $print }
  || { score == 'B' _ { 'good'       $print }
  || {                   'try again' $print } };

# negation: ?! is is_not
1 ?! 1 _ { a + 2 } else { a + 3 } else { a + 4 };

# switch-like dispatch is just listing the cases
color = {
    $el is? apple { $el is red    };
    $el is? pear  { $el is yellow };
};
apple color;
pear  color;
```

Any number is a condition (zero is false, anything else is true), so there is no truthy / boolean conversion to remember. Counting and branching share the same primitive.

### 8. History mode: deferred effects (experimental)

Turning on `history` mode tells the runtime to *collect* `is` / `is not` calls instead of applying them immediately. They flush only when something inspects the element (`is?`, `$print`, `$error`).

```th
mode history on;
apple is red;
apple is green;
apple is! red;
apple is? red $print;    # flushes all three at the moment of inspection
```

The intent is a programming model where you write what should be true and the runtime decides when to commit it. The current implementation handles the deferred-then-flush case for `+` and `-` on typed elements. Richer history operations sketched in `examples/lang-features.th` — `apple repeat`, `apple undo`, `apple redo`, `apple learn { … }`, `apple forget X`, `apple start test` / `stop test` — belong to the same design but are not yet wired up in this codebase. Treat the section as a preview of where the language is heading rather than a feature to build on today.

### 9. Tables are first-class

```th
t = |key value|;
t + ['a' 1] and ['b' 2] and ['a' 3];
t * ['a'];           # [['a',1],['a',3]]
t * '^a \d$';        # regex search across the joined row
t _ { sum + $value };
```

No `import sqlite` and no `pandas`. A small in-memory column store ships with the language and uses the same operator vocabulary.

### 10. Closures with one extra character

`$$name` captures `name` from the surrounding scope at definition time. That is all closures are:

```th
f = { { $a + $b } ($$a $b) } ($a);
f 5 4;        # 9   (a is captured)
```

### 11. Multi-return is the default

A block can yield multiple values without tuples or destructuring:

```th
gen = { a = 12; b = 10; a >>; b >>; };
gen;          # [12, 10]
```

`>>` is `export`; `<<` is `import`. Together they make scope mixing explicit instead of magical.

### 12. Inline phrasebooks (proposed)

Today a facet lives in a small `config.js` next to the `.th` file. Useful, but the grammar travels separately from the program. A proposed `…phrases` block lets a file ship its own dialect inline:

```
…phrases
'$ has $ $'                   : '$2 _ { $1 has $3 }'
'$ has $'                     : '$1 + $2'
'$ does $'                    : '$1 => $2'
'the hero attacks the dragon' : 'hero attacking dragon'
…

there is hero;
hero has 60 health;
the hero attacks the dragon;
```

The triple-dot fences delimit a phrasebook that's read at parse time and used by the rest of the file. ASCII `...phrases` works the same. After parsing, the phrases evaporate — no leakage into modules.

It is not implemented yet. The point of the idea is to make a program's *grammar* a self-contained artifact: copy one `.th` file anywhere, get its language with it. See `SPEC.md` § 13 for the implementation sketch.

### 13. Templates with a real expression sublanguage

```th
a = 12;
b = `${a + 3}`;      # '15'
clock = `${
    var d = new Date(0);
    d.setHours(h);
    d.setMinutes(m);
    return d.toString().split('T')[1].substring(0, 5);
}`;
```

Templates evaluate JavaScript with access to the env's properties as locals. You get the convenience of host-language escape hatches without writing FFI bindings.

---

## What it looks like in anger

### A unit test, written in the `where` facet

```th
suite = 'Clock';

'prints the hour' > {
    at 8 0 should '08:00';
};

'can add minutes' > {
    at 10 0 plus 3 should be '10:03';
};

'wraps around midnight' > {
    at 23 59 add 2 should '00:01';
};

all;
```

`>` registers a test, `should` asserts equality, `all` runs them. No test framework dependency: it is 80 lines of `there` in `modules_there/where/index.th`.

### An anagram finder

```th
u @ utils;

Anagram => {
    matches = {
        found = [];
        (w) : { $words ? list _ { $words } || { [$$words] } };
        w _ {
            (same)    : { sameWord    $word $candidate == 0 } ($candidate{$el});
            (anagram) : { isAnagram   $word $candidate     } ($candidate{$el});
            same + anagram == 2 _ { found + $match } ($match{$el});
        };
        found
    } ($words $$word);
} ($word);
```

Note: `u @ utils` loads a module. `=>` declares a global. Iteration, conditionals, and parameter binding are all the same primitive.

### Configuration as code

Because phrases let you redesign the surface, `there` makes a very natural configuration language:

```th
when apples or pears are rotten they become brown;
when plums are rotten they become black;
```

A facet rewrite turns those into iterator + continuation declarations behind the scenes. Your stakeholders can read the file. Your runtime can execute it. Same artifact.

---

## What it is good for

- **Rule-driven systems.** Effect history and continuations make business-rule engines compact. Each rule is one line, lives near its data, and is independently extensible.
- **Test description.** The `where` facet is 80 lines and demonstrates that BDD-style assertion DSLs are practically free.
- **Configuration that humans read.** Stakeholders write `when X happens, Y becomes Z` and it executes. No JSON schemas, no YAML anchors.
- **Prototyping language design.** Because the grammar lives in `phrases` and `aliases`, you can mock up an entire new syntax in an afternoon and execute it the same day.
- **Teaching effects and reactive thinking.** Continuations, history mode, and the unified iteration form make implicit ideas explicit and inspectable.

## What it is not (yet) good for

- High-performance numeric code. The runtime is interpreted, allocates freely, and is not concurrency-aware.
- Large engineering bases. The lack of static types and module boundaries beyond facets means refactoring across many `.th` files relies on the test suite.
- Safety-critical work. Effects are global by default; the language trusts you.

---

## How it compares

| Feature                       | `there`                                | Typical alternative                                              |
|-------------------------------|----------------------------------------|------------------------------------------------------------------|
| Effects on data               | Built-in (`is`, `not`, `has`, `size`)  | Mutating methods or immutable updates plus library helpers       |
| Reactive rules                | `(target effect) ... { … }`            | Observer pattern, RxJS, signals, decorators, AOP                 |
| DSL embedding                 | Facets (`aliases` + `phrases`)         | Macro systems, fluent builders, parsers + AST rewriters          |
| Pattern-based grammar         | First-class                            | External parser generators                                       |
| Test framework                | A module (`where`)                     | Mocha / JUnit / pytest                                           |
| Templating                    | Host-language expressions in `` `${}` `` | Templating libs (Jinja, Handlebars, EJS)                     |
| In-memory tables              | Native (`|cols|`)                      | SQLite / DataFrame libraries                                     |
| Closures                      | `$$name` capture                       | Lexical scope rules vary by language                             |
| Constructor caching           | `(name) : block` (with `?` opt-out)    | Memoization decorators / singleton patterns                      |
| Multi-return                  | Multiple `>>`                          | Tuples + destructuring                                           |
| User input as data            | `'prompt' _ { … }`                     | `readline` / `input()` + control flow                            |

`there` does not try to beat any of these on raw power. It tries to beat them on *unification*: one mechanism doing the job of five separate library categories.

---

## Why now

The industry has spent years rediscovering that explicit effects, declarative reactivity, and human-readable specification matter. Algebraic effects in Koka and OCaml 5. Signals in modern UI frameworks. Capability-based languages. Specification languages (Cue, Dhall) for configuration.

`there` was a tiny experiment in collapsing all of those into a single idea: write what should be true, react to changes by writing more of what should be true, and let the runtime do the bookkeeping. It is small enough to read in an afternoon and weird enough to teach you something.

---

## Try it

```sh
npm install
bin/there examples/lang-features.th
bin/there examples/fizzbuzz.th
bin/there examples/lang-steps.th
```

Or open the REPL with bare `bin/there`. The prompt is `there>`. Start by typing:

```
there is apple
apple is red
apple is? red $print
```

Then change the language under your feet.
