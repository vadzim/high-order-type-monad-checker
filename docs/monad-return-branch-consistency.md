# Monad return branch consistency checker

## Goal
Detect type-level “functions” (type aliases and other type expressions) that sometimes return an **Monad** type, but in other branches return a different type. If any branch returns Monad, then **all** branches must return either:
- the same Monad value (or a value constrained to be Monad), or
- `never`.

This prevents leaking non-monad values into a type that is expected to be monad/linear.

## Definitions

### Monad type
An **Monad** type is a designated type (or set of types) that must be treated specially by the checker.

In examples below, assume we have a configured monad type:

```ts
type Monad = { readonly __monad__: unique symbol }
```

(Real projects usually use a branded type or a dedicated exported alias.)

### Branch
A **branch** is an arm of a conditional type:

```ts
type F<T> = Cond<T> extends true
  ? BranchTrue<T>
  : BranchFalse<T>
```

Nested conditional types create nested branches. For this checker, the rule applies to the **set of terminal return expressions** reachable from the root expression.

### Return position
We say a type expression “returns” a type when it is the final resulting type of the alias/expression (after evaluating conditionals).

Example:

```ts
type F<T> = T extends string ? Monad : never
// terminal returns are: Monad, never
```

## Rule (normative)

Let `R` be the set of terminal return types of a type-level function/expression after expanding conditional branches.

If `R` contains **Monad**, then every terminal return type in `R` must be either:
- **Monad-compatible**, or
- `never`.

Where **Monad-compatible** means:

1) `Monad` itself, OR
2) a type parameter `A` such that `A extends Monad` (so `A` is guaranteed to be monad).

Anything else is forbidden.

### Consequence
If any branch returns Monad, you cannot return non-monad values in other branches.

Allowed: `Monad | never`, `A | never` where `A extends Monad`, `Monad | A` where `A extends Monad`.

Forbidden: `Monad | string`, `Monad | number`, `Monad | SomeWrapper<Monad>`, `Monad | unknown`.

## Examples

### PASS: Monad or never

```ts
type F<T> = T extends "ok" ? Monad : never
```

### PASS: type param constrained by Monad

```ts
type F<A extends Monad, T> = T extends "ok" ? A : never
```

### PASS: all branches monad-compatible

```ts
type F<A extends Monad, T> = T extends "ok" ? A : Monad
```

### FAIL: mixes Monad with non-monad

```ts
type F<T> = T extends "ok" ? Monad : string
// ERROR: since one branch returns Monad, all branches must return Monad-compatible or never
```

### FAIL: `unknown` is not monad-compatible

```ts
type F<T> = T extends "ok" ? Monad : unknown
```

### FAIL: wrapper types are not treated as Monad

```ts
type Box<T> = { value: T }

type F<T> = T extends "ok" ? Monad : Box<Monad>
// ERROR: Box<Monad> is not Monad-compatible
```

### FAIL: unconstrained type param is not monad-compatible

```ts
type F<A, T> = T extends "ok" ? Monad : A
// ERROR unless A is constrained as A extends Monad and the return is A
```

## Edge cases

### Nested conditionals

```ts
type F<T> = T extends 1
  ? Monad
  : T extends 2
    ? never
    : Monad
// PASS: terminal returns are Monad, never, Monad
```

```ts
type F<T> = T extends 1
  ? Monad
  : T extends 2
    ? string
    : never
// FAIL: terminal returns include Monad and string
```

### Distributive conditionals
If a conditional is distributive over a union, terminal returns are collected across all distributed branches. The rule still applies: if any distributed branch can return Monad, then all terminal returns must be Monad-compatible or never.

## Non-goals
- This checker does **not** attempt to prove that `SomeType` is equivalent to Monad.
- It does **not** treat `Wrapper<Monad>` as Monad.
- It does **not** infer monad-compatibility through type-level computation.

## Implementation notes (for later)
A practical implementation can:

1) Compute terminal return nodes for a declaration’s type expression.
2) Mark a return node as “monad-return” if it resolves to `Monad` or an `A extends Monad` type parameter.
3) If any monad-return exists, verify that every other terminal return is either monad-return or never.
4) Emit a diagnostic pointing at the first non-conforming return node, and (optionally) the branch path.
