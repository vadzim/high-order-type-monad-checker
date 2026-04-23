# monad-checker

`monad-checker` experiments with type-level rules for expensive, single-consume values represented in TypeScript types.

## `monadChecker2`

`src/monadChecker2.ts` works on the content graph built by `buildContentGraph`.
It treats the configured `Monad` type as a marker class and applies a small set of plain structural rules.

### Settings

The checker needs four declarations from one module:

- `name`: the public monad class/type marker
- `constructorName`: a primitive constructor related to monad values
- `readerName`: the only configured reader that may inspect monad internals freely
- `consumerName`: the only configured primitive consumer that may inspect monad internals freely

### What counts as a monad-like value

The checker treats these as monad-carrying types:

- type parameters and inferred types declared with `extends MonadClassFromSettings`
- declarations marked by using the configured monad class on the right side of `extends`
- generic type parameters and `infer` bindings whose constraint is the configured monad class
- type aliases whose terminal returns are always monad-carrying or `never`

The configured monad class itself is not treated as a consumable monad value.
It is only a marker used to declare that some other type is a monad.

This lets aliases such as “next monad” wrappers participate in the rules without hard-coding every alias name.

### What counts as a consumer

A type alias is treated as a consumer if at least one terminal return branch is either:

- a tuple `[monad, result]`
- a direct call to another consumer

The configured primitive consumer from settings is also seeded into the consumer set so other consumers may return calls to it.

### Consumer return rules

Once a type is classified as a consumer, every terminal return branch must be one of:

- `[monad, result]`
- a direct call to another consumer
- `never`

If one branch is consumer-shaped and another branch returns something else, that is a violation.

### Consumer invocation rules

A consumer call is only allowed in two places:

- as the terminal return of another consumer branch
- directly on the left side of a conditional `extends`
- the configured primitive consumer may also appear as the first element of a terminal `[monad, result]` tuple return

When used on the left side of `extends`, the right side must be a tuple of the form:

- `[MonadClassFromSettings, result]`

This allows destructuring a consumer result in a conditional type while forbidding arbitrary nesting.

### Branch-sensitive monad usage

The checker enforces “consume once per branch” for monad values.

For each monad-carrying value, it walks usages in source order and looks only at:

- the current scope
- parent scopes

It does not look into child scopes.

That means sibling conditional branches are independent:

- using the same monad once in the true branch and once in the false branch is allowed
- using it twice in the same branch path is a violation

### Generic argument position rule

Monad values may only be passed as the first argument of another type.

That applies to:

- ordinary generic type calls
- pseudo type shapes in the content graph such as tuples and indexed access

The one exception is the consumer return shape:

- `[monad, result]`

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
- the primitive consumer may advance it
- higher-level consumers must return either a new `[monad, result]`, another consumer call, or `never`
- outside of the reader exception, the same monad should not be consumed more than once along a single branch path

## CLI

`cli/check-monad.ts` now runs `buildContentGraph` + `concatContentGraphs` + `monadChecker2`.

Use:

- `node cli/check-monad.ts <glob>... --monad <file> <marker>:<constructor>:<reader>:<consumer>`

Diagnostics are rendered from graph offsets, and when a violation has related context the CLI prints a second marked snippet underneath the main error.
