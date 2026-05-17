# Old Forest: a turn-based duel in two voices

Three actors. One player. Dice on every roll. Everything is multiset.

- **Hero** (the player): attacks the dragon.
- **Dragon** (auto): attacks the hero.
- **Wizard** (auto): heals both of them.

Each fighter starts at **60 healthy**, with a one-time-rolled **weak**
and **charming** in `1..3`. Health falls into four bands:

| healthy | marker   |
|---------|----------|
| 41..60  | (none)   |
| 21..40  | wounded  |
| 1..20   | dying    |
| 0       | dead     |

Every turn each actor rolls fresh **powerful** in `1..10`. The turn
plays out as:

1. **Attacks land first.** Each attacker spends every point of power on
   one strike against the opponent. Power that's used is gone — no
   leftover, no carry-over.
2. **The wizard heals each side**, also spending all of his power.
3. **End-of-turn traits then settle, once each.** An actor who is still
   alive bleeds — they take one hit per point of `weak`. A corpse does
   not bleed; weakness is for the living. Then `charming` heals each
   actor (charm can even revive — that is what makes a wizard a wizard).

Press enter to advance. Type `quit` to flee.

## Run

    bin/there examples/promo/canonical.th
    bin/there examples/promo/natural.th

Both files are self-contained — no facet directory, no `config.js`
beside them. Each ships its host-language piece (`$rand`) and, in the
case of `natural.th`, its phrasebook, inside an inline `facet` block at
the top.

`canonical.th` is the same program written without any storytelling
phrases — just `+`, `-`, `_`, `?`, `...`. A Rosetta stone next to
`natural.th`.

## Why this version is "there-styled"

The earlier draft of this example used envs with numeric `.health`
properties and JS helpers (`damage`, `heal`) for arithmetic. It worked
but it bypassed the language's central affordance: continuations on
effects. This rewrite leans into it.

### Stats are multisets

There is no `healthy = 60` anywhere. There are 60 *state tokens* named
`healthy` on the hero element. Mutation is just `is` / `is not` from
the default facet (which alias to `+` / `-`). Multi-arg adds are plain
iteration — no extra surface needed:

    60      _ { hero   is healthy };
    $rand 3 _ { dragon is weak    };

To query, ask the multiset how many of a state it has. `is?` is the
language's built-in `size` operator — there is no separate counter
resource:

    hero healthy?             # phrase: (hero is? healthy) -> the count

An actor's stats are just states on an element. Damage is `$opp is
attacked`, which fires the `(* attacked) ... { $el is not healthy }`
continuation. Nothing more.

### Physics is continuations

The damage spiral isn't a function — it's a rule registered against the
`-` operator on `healthy`:

    (- * healthy) ... {
        $el healthy? == 40 _ { $me is wounded } ($me{$el});
        $el healthy? == 20 _ { $me is dying   } ($me{$el});
        $el healthy? ==  0 _ { $me is dead    } ($me{$el});
    };

Whenever anything loses a `healthy` token, this rule reads the new
count and pins on the matching marker. Healing has the mirror rule.

### Actions spend power as they use it

`attacking` doesn't compute damage — it iterates power into hits and
spends one point off the attacker on the same step:

    attacking does {
        $el rolls;
        $el powerful? _ {
            $opp is attacked;
            $me  is not powerful;
        } ($opp{$opp} $me{$el});
    } ($opp);

The block's collector `($opp{$opp} $me{$el})` carries both the opponent
and the attacker into the loop body (`$el` is rebound to the loop
index inside `_`, so we capture it as `$me`). Each iteration lands one
hit on the opponent and removes one `powerful` from the attacker. The
attacker walks out of the turn with zero `powerful`, ready for the
next `rolls`. Same shape for `healing`.

### Weakness and charm are end-of-turn

Weakness used to multiply with every attack, which is wrong: it's a
constitutional trait, not an attack rider. So `bleeding` and
`recovering` exist as their own once-per-turn verbs:

    bleeding does {
        $el is alive _ {
            $el weak? _ { $el is attacked } ($el{$el});
        };
    };

    recovering does {
        $el charming? _ { $el is mended } ($el{$el});
    };

A corpse cannot bleed — `is alive` is rewritten to `is?! dead`, which
returns 1 only when the element has no `dead` state. Charm has no such
gate; it can pull a fallen actor back.

### Verbs just emit effects

The action vectors don't do math. They emit:

    attacking does {
        $el rolls;
        $el powerful? _ {
            $opp is attacked;
            $me  is not powerful;
        } ($opp{$opp} $me{$el});
    } ($opp);

`$opp is attacked` triggers the `(* attacked)` continuation, which
removes a `healthy`, which fires the `(- * healthy)` continuation,
which pins markers. The attacker doesn't know how damage works. None
of the links in the chain know about each other.

### Multiplication is iteration

`powerful * 1` never appears as an expression. It is encoded as
*iterate `powerful` times*. That is why every stat is a multiset —
`$el powerful?` returns a number, which `_` happily iterates over.

## The dialect travels with the file

The earlier draft of this example shipped a chunky `combat/config.js`
with twenty-odd phrases inside it: `has`, `has!`, `does`, every
postfix-`?` query, every English action verb. The grammar of the
program lived in a different file from the program. Copy `natural.th`
somewhere new and it stopped reading like English.

This version moves the phrasebook *into* `natural.th` itself, using a
fenced **facet block**. The fence opens with `` ```facet `` on its own
line and closes with `` ``` ``. Inside, the four facet tables
(`phrases`, `aliases`, `resources`, `globals`) are declared with
ordinary there assignment — same `=`, same block braces, same string
literals — so the grammar of the program ships in the program's own
syntax:

    ```facet
    phrases = {
        '$ does $'                    : '$1 = $2'
        'otherwise $'                 : '|| $1'
        '$ healthy?'                  : '($1 is? healthy)'
        '$ is alive'                  : '$1 is?! dead'
        'the hero attacks the dragon' : 'hero attacking dragon'
    }
    ```

The block is read at parse time, merged into a copy of the active
facet, and used for the rest of the file. After parsing, the inline
declarations evaporate — they do not leak into modules. Only `phrases`
is declared here; the same form scales naturally to `aliases =
{...}` for token rewrites and (once safe-subset rules are sorted out)
declarative `resources` / `globals` tables too.

The fenced facet block is a forward-looking sketch in this repo; the
parser implementation is described in `SPEC.md` § 13 and is not yet
wired up. The example is written this way to show what the surface
should look like once it lands. Until then, the same phrases can be
moved back into `combat/config.js` and the program runs unchanged.

## What the host gives us

Nothing external. There is no `combat/config.js` anymore — the only
host-language piece either file needs is `$rand`, and it is declared
inside the inline `facet` block as a template-bodied resource:

    resources = {
        rand : `${
            var max = Number(parameters[0] && parameters[0].value());
            return there.create('number', Math.floor(Math.random() * max) + 1);
        }` (n)
    }

Counting states is `is?` (the language's built-in `size`). Multi-arg
adds are plain `N _ { x is state }`. Verb definitions are plain `=`
(spelled `does` in natural.th's phrasebook). Everything else — every
verb, every query, every storytelling phrase — is in the `.th` file.

## Closure-capture noise

The one wart: when a body runs inside `_` iteration, `$el` is rebound
to the loop counter. Every reference to the outer actor inside an
iteration needs `($me{$el})` to carry it through. It is verbose but
local; once you read it as "carry-the-actor-in", it stops being
distracting.

## Try changing one thing

Open `natural.th` and edit the `...phrases` block:

- Add `'$ attacks $' : '$1 attacking $2'` and the action lines become
  `the hero attacks the dragon` → `hero attacks dragon`. No JS edit.
- Rename `healthy` to `vitality` everywhere — one phrase edit and a
  global find/replace in the body. The physics rules adapt because
  they reference the state name once.
- Let weakness scale with injury again — change `bleeding` to iterate
  `$el wounded? + $el dying?` extra cycles, and the spiral comes back
  on top of the once-per-turn base.

The combat facet does not need to change for any of these. The grammar
ships with the program.
