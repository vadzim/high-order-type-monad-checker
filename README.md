# high-order-type-monad-checker

This checker is a **very specific** tool: it automatically checks that a marked type is treated as **consumed only once** along the type-level flows it models—so you do not accidentally build APIs where the same logical resource can be “used up” twice.

The motivating scenario is a **compile-time parser** expressed in TypeScript’s type system. When **LLM-generated** type-level code participates in the pipeline, you still want a hard guarantee that a **stream of tokens** is not advanced or re-entered in a way that implies **parsing the source string into tokens more than once**. Tokenisation is **expensive** when done correctly, so the checker encodes a single-pass discipline instead of hoping every generated branch respects it.

## Checker (`src/monadChecker.ts`)

`getMonadViolations` in `src/monadChecker.ts` runs on the content graph from `buildContentGraph`, merged across files with `concatContentGraphs` (same pipeline as the CLI).
It treats the configured monad type as a marker and applies a small set of structural rules.

### Settings

Configuration matches `MonadTypeOption` in code: a module `path` plus four type names that must exist in that module’s scope.

- `path`: the settings module (the `<file>` argument to `--monad` on the CLI)
- `name`: the public monad class/type marker
- `constructorName`: a primitive constructor related to monad values
- `readerName`: the only configured reader that may inspect monad internals freely
- `consumerName`: the only configured primitive consumer that may inspect monad internals freely

In the bullets below, **`Monad`** means whatever you passed as `name` / the first `--monad` segment, and **`Consumer`** means the type named by `consumerName` (the fourth segment). The test suite often aliases them as `Monad`, `MRead`, and so on.

### What counts as a monad-like value

The checker treats these as monad-carrying types:

- type parameters and inferred types declared with `extends Monad`
- declarations marked by using the configured monad class on the right side of `extends`
- generic type parameters and `infer` bindings whose constraint is the configured monad class
- type aliases whose terminal returns are always monad-carrying or `never`

The configured monad class itself is not treated as a consumable monad value.
It is only a marker used to declare that some other type is a monad.

This lets aliases such as “next monad” wrappers participate in the rules without hard-coding every alias name.

### What counts as a consumer

The configured `consumerName` type is the only special consumer that is allowed to:

- accept monad input
- return a bare monad value

### Consumer return rules

For every user type alias (not the configured primitive consumer and not the configured reader) that accepts monad input, every terminal return branch must be one of:

- `[monad, result, ...rest]` (tuple length >= 2)
- `never`

If such a type returns a bare monad in any branch, that is a violation.

### Consumer invocation rules

Configured primitive `Consumer` calls are restricted to the patterns the checker recognizes, including:

- as the terminal return of another consumer branch
- directly on the left side of a conditional `extends`
- the configured primitive consumer may also appear as the first element of a terminal tuple return with monad in slot 1 and length >= 2
- the configured primitive consumer may be passed as the first argument to a type whose first generic parameter is `extends Monad` (including the configured primitive consumer itself)

When used on the left side of `extends`, the right side is usually a tuple of the form:

- `[infer T extends Monad, ...]`

Additionally, only for the configured primitive consumer, the direct root conditional form is allowed:

- `Consumer<M> extends infer NextMonad extends Monad ? ... : ...`

The configured primitive consumer may also be used as the first element of a tuple on the left side of `extends` in a conditional, when that `extends` right side uses the same monad tuple pattern.

This keeps the same guardrails as tuple wrapping while making that wrapper unnecessary for this specific consumer-root conditional case. Nested/wrapped infer forms remain forbidden.

### User producer invocation rules

For user producers (type aliases with monad input whose terminal returns are `[monad, result, ...rest]` / `readonly [monad, result, ...rest]` or `never`, with tuple length >= 2), a producer call may only appear in these positions:

- immediate terminal return of another user producer:
- `type R<M extends Monad> = P<M, "x">`
- immediate left side of conditional `extends` with tuple destructuring whose first item is `infer ... extends Monad`:
- `type R<M extends Monad> = P<M, "x"> extends [infer M2 extends Monad, infer R2] ? ... : ...`

Using a user producer call as a nested generic argument, tuple element, object field, or other wrapped position is a violation.

This is transitive: if one user producer returns another user producer, the caller is treated as a user producer too and gets the same invocation restrictions.

### Branch-sensitive monad usage

The checker enforces “consume once per branch” for monad values.

For each monad-carrying value, it walks usages in source order and looks only at:

- the current scope
- parent scopes

It does not look into child scopes.

That means sibling conditional branches are independent:

- using the same monad once in the true branch and once in the false branch is allowed
- using it twice in the same branch path is a violation
- consuming in the conditional condition and then again in either branch is also a violation

### Generic argument position rule

Monad values may only be passed as the first argument of another type.

That applies to:

- ordinary generic type calls
- pseudo type shapes in the content graph such as tuples and indexed access

The callee must declare its first generic parameter as monad-bound (`extends Monad`).

The one exception is the consumer return shape:

- `[monad, result, ...rest]` (tuple length >= 2)

There the monad is allowed in the first tuple slot by design.

### Reader and primitive consumer exceptions

The configured reader and configured primitive consumer are special:

- their own bodies may inspect monad internals freely
- passing a monad to the reader does not count toward the “consume once per branch” limit

Everything else, including built-in graph shapes such as tuples or indexed access, counts as a normal use.

### Mental model

The checker is trying to model an expensive state-like value:

- the configured monad class only marks values; it is not itself consumable
- readers may inspect it
- the configured primitive consumer may advance it and return a bare monad
- user types that accept monad input must return `[monad, result, ...rest]` (or `never`), not a bare monad
- outside of the reader exception, the same monad should not be consumed more than once along a single branch path

## CLI

The **`check-monad`** binary (see `package.json` → `bin`) runs the same pipeline as the library: `buildContentGraph` per file, `concatContentGraphs`, then `getMonadViolations` from `src/monadChecker.ts`. From a clone you can run `node cli/check-monad.ts` against the TypeScript sources; from npm, run `npx check-monad` after installing **`high-order-type-monad-checker`**.

Use:

- `check-monad [options] <glob> [<glob> ...] --monad <file> <marker>:<constructor>:<reader>:<consumer>`
- Options and globs may be in any order. Repeat `--monad` to check several monad configurations on one merged graph.
- Optional: `--snippet-lines <before>[:<after>]` controls how many source lines are shown around diagnostics (see `--help`).

Diagnostics are rendered from graph offsets, and when a violation has related context the CLI prints a second marked snippet underneath the main error.
