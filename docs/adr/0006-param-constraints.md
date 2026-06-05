# ADR 0006: Inline param constraints (runtime enforcement)

## Status
Accepted (2026-05-29)

Extends ADR 0001 (radix trie router). Does **not** change the static > param >
wildcard precedence baked into the trie.

## Context
The path grammar has always *parsed* an inline constraint syntax —
`:id(\d+)` — at the type level (`ExtractParams` strips the `(regex)` group to
`string`). But the runtime never honored it. Worse, `RouterTrie.insert()` did
`seg.slice(1).replace(/\?$/, '')`, which for `:id(\d+)` produced the literal
param name `id(\d+)` (parens and all) — a latent bug that put the wrong key on
`ctx.params` and silently disabled any conflict detection for constrained
params. This was tracked as a "Known issues — bug" in `docs/roadmap.md`.

We needed `:id(\d+)` to actually reject non-matching segments at request time,
while keeping the router's hard guarantee from ADR 0001: `find()` is the single
hottest function in the framework, and routes that opt OUT of a feature must pay
zero per-request cost for it.

## Decision

### Parse once at insert
`insert()` calls a new `parseParamSegment(seg)` helper (insert-time only, never
on the hot path) that splits a `:name(regex)?` segment into a clean `name` (no
parens, no `?`) and an optional compiled `RegExp`. The optional `?` marker is
stripped first; then a `(...)` group, if present, is compiled as
`new RegExp('^(?:' + pattern + ')$')`. The constraint is **fully anchored** —
`^(?:...)$` — so a partial match (`\d+` against `12a`) does not slip through,
and the `(?:...)` wrapper stops a user alternation (`a|b`) from binding past the
anchors. The compiled regex is stored on the param *child* node as
`paramConstraint: RegExp | null`, so the matcher can test it the instant it
descends.

### Enforce on a gated branch in find()
The existing `paramChild` branch in `find()` now loads `paramChild.paramConstraint`
and descends only when it is `null` (unconstrained — the common case) **or** the
compiled regex tests true against the **raw, pre-decode** segment. On a
constraint miss the param branch is skipped and control falls through to the
existing `wildcardChild` / backtrack-stack logic exactly as a structural
dead-end would — so a sibling `*wild` can still catch the segment, and otherwise
the lookup 404s. The `fallbacks` stack and `paramValues`/`paramCount`
truncation are untouched: a constraint miss rewinds identically to a dead end
because we simply never pushed the param value.

### Hot-path gate
The added cost for an unconstrained route is a single field load and a
`=== null` branch (one predictable, almost-always-true comparison) — no regex,
no allocation. Only constrained routes pay one anchored `.test()`. This honors
the ADR 0001 / CLAUDE.md rule that an opt-in feature adds zero unconditional
per-request work.

### Conflict rule
Two registrations of the same param at the same trie level must agree on their
constraint. We compare the compiled regex `.source` (with the empty string
standing in for "unconstrained") and throw a clear
`Conflicting param constraints at the same trie level` error on any mismatch —
including the asymmetric case where one registration constrains the param and
another leaves it open. Last-writer-wins was rejected: it would let one route's
`:id(\d+)` silently weaken or tighten another's, a footgun. Identical
constraints are idempotent. This mirrors the style of the pre-existing
`Conflicting param names` throw.

### Values stay strings
Runtime enforcement only. `:id(\d+)` constrains the *shape* of the segment, but
`ctx.params.id` is still the string `"42"`. `ExtractParams` continues to type
constrained params as `string` — now honest, because the runtime guarantees the
shape. Number-narrowing (typing `:id(\d+)` as `number`) remains deferred: it
would change `ctx.params` value types and is out of scope here.

## Consequences

Positive:
- The documented constraint syntax now does what it says; the latent
  `id(\d+)`-as-a-key bug is fixed.
- Precedence is unchanged — static still beats a constrained param, which still
  beats a wildcard. A constraint miss degrades gracefully to the wildcard/404
  path.
- Zero cost for the unconstrained majority of routes.

Negative:
- Constrained routes pay one anchored regex `.test()` per matched segment. This
  is the inherent cost of the feature and is gated so only opted-in routes pay.
- The conflict check makes a previously-accepted (but buggy) double
  registration throw. This is intended — it surfaces a genuine ambiguity that
  used to corrupt the param key.

## Alternatives considered
- **Match generously, reject in user code.** Slower and wrong: a sibling
  `*wild` could legitimately catch a segment the constraint rejects, which user
  code can't reproduce after the router already committed to the param branch.
- **Store the constraint on the parent keyed by param.** No benefit over storing
  it on the param child, and it would need a side lookup on the hot path.
- **Last-writer-wins on conflicting constraints.** Silent and surprising;
  rejected in favor of an explicit throw.
