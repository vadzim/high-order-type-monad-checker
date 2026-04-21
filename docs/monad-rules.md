# Monad Rules

## Purpose

This document describes the current monad checker behavior in this repository.
It focuses on practical validation rules enforced by `check-monad`.

## Core Model

- `Monad` is configured through CLI `--monad <path> <TypeName>`.
- A type that accepts a monad-compatible input is treated as a monad producer candidate.
- Checker validates:
    - producer return shape,
    - where producer calls are allowed,
    - infer pattern in conditional `extends`,
    - generic first-parameter monad constraints,
    - linear (single-use) behavior for monad variables,
    - allowed monad usage positions.

## Rules

### 1) Monad-compatible generic parameter must be first

If a declaration has a monad-compatible type parameter (`A extends Monad` or equivalent compatible bound), it is only allowed in the first generic parameter slot (so later parameters can use defaults without blocking the stream type).

- Valid: `type P<A extends Monad, X = {}> = ...`
- Invalid: `type P<X, A extends Monad> = ...`

Violation kind: `monad.invalidGenericArgumentConstraint`

### 2) Producer return contract

A declaration that accepts monad-compatible input must return one of:

1. A 2-item tuple where the first element is monad-compatible:
    - `[MonadLike, Result]`
2. A call to another declaration that is itself a valid monad producer.

Everything else is invalid (bare monad value, object wrapper, 3-tuple, etc.).

Violation kind: `monad.invalidProducerReturn`

### 3) Producer invocation positions

A monad producer call is allowed only:

1. As a direct terminal return value.
2. Immediately before `extends` in a conditional check where RHS destructures a 2-item tuple with monad infer constraint in the first slot (see rule 4).

Any other call site is forbidden.

Violation kind: `monad.invalidProducerInvocation`

### 4) Conditional `extends` infer pattern

For monad infer constraints, allowed pattern is strict:

- RHS must be exactly a 2-item tuple pattern.
- Monad-constrained infer must be in slot 1:
    - `... extends [infer M extends Monad, infer _] ? ... : ...`

Invalid examples:

- infer in second slot,
- no `extends Monad`,
- non-tuple RHS,
- nested/wrapped infer pattern.

Violation kind: `monad.invalidInferConstraint`

### 5) Allowed monad usage positions (strict)

Monad usage is allowed only as:

1. First generic argument of a callee whose first parameter is monad-bound.
2. `tuple[0]` in a returned 2-item tuple.
3. A direct single return from a declaration that does not accept monad input.

Any other usage is invalid.

Violation kind: `monad.invalidMonadUsage`

### 6) Linear usage (single-use) of monad variable

A monad variable is linear once consumed:

- It cannot be used twice in the same scope.
- It cannot be reused in descendant scopes after parent-scope consumption.
- Independent sibling branches are allowed.

Violation kind: `monad.consumeMultipleInPath`

### 7) Implicit monad aliases (no monad input)

If a declaration does not accept monad input, but any terminal return is monad-compatible, the declaration becomes monad-compatible itself.

This includes:

- `type X = M` where `M` is monad-compatible.
- `type X<T> = M` where `M` is monad-compatible.
- `type X<T> = Cond<T> extends true ? M : never`.

Constraint:

- Once such declaration returns monad-compatible in any terminal branch, all terminal branches must return the same monad-compatible type or `never`.

Example:

- Valid: `type X<T> = T extends 1 ? Monad : never`
- Invalid: `type X<T> = T extends 1 ? Monad : 1`

Violation kind: `monad.inconsistentBranchReturn`

## Diagnostics

`check-monad` returns violations with:

- `kind`
- `message`
- `position`
- optional `relatedPosition`
- optional `relatedDeclarationId`

Current canonical diagnostics (semantic meaning):

- `monad.invalidGenericArgumentConstraint`:
    - "Monad-compatible type parameters are only allowed in the first generic parameter slot."
- `monad.invalidProducerReturn`:
    - "Types that accept Monad-compatible parameters must return either a 2-item tuple `[Monad, result]` or a call to another Monad-producing type which returns such a tuple."
- `monad.invalidProducerInvocation`:
    - "Monad-producing types may only be invoked as a direct terminal return value or immediately before `extends` with tuple destructuring on the right side."
- `monad.invalidInferConstraint`:
    - "Monad-compatible infer constraints are only allowed as the 1st element in a 2-item tuple pattern."
- `monad.invalidMonadUsage`:
    - "Monad usage is allowed only as: first generic argument of a callee whose first parameter is Monad-bound, tuple[0] in a returned 2-item tuple, or a direct single return from a declaration that does not accept Monad input."
- `monad.consumeMultipleInPath`:
    - "Monad value is linear: after first use it cannot be used again in the same scope or descendant scopes."
- `monad.inconsistentBranchReturn`:
    - For implicit monad aliases without Monad input: if any terminal branch returns monad-compatible, all terminal branches must return the same monad-compatible type or `never`.

CLI formatting is implemented in `cli/format-violation.ts`.

## Tests

Main test matrix: `test/checkMonad.samples.ts` + `test/checkMonad.test.ts`.

Sample format:

- First line starts with `// ok:` or `// fail:`
- Optional `expectedKinds` can pin exact violation kinds.

This matrix covers positive and negative scenarios for all rules above, including cross-file cases.
