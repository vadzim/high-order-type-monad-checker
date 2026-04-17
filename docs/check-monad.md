# Monad Type Parser And Checker

## Purpose

This project provides:

- `parseTypes(path, content, options?)` to parse TypeScript source in memory and return metadata-only outputs (`types`, `scopes`, `declarations`).
- `checkMonad(parsed)` to validate monad-type consumption rules and return violations with positions.

No filesystem or network operations are performed by parser/checker logic.

## Description

In a type declaration body, ternary operators form a ternary tree.
If a type declaration body contains no ternary operators, its ternary tree consists of exactly one node.
If it contains exactly one ternary operator, the tree consists of exactly three nodes: one root and two leaves.
The more ternary operators a type declaration body contains, the more leaves its ternary tree has.

If a type is marked as monad, then any type variable that extends that monad type (via a type parameter or `infer`) may be referenced (consumed) at most once along any path from a leaf to the root of that ternary tree. Such a type is called a **consumer** of the monad type. If a type variable does not appear in the type declaration body at all, it is called a **reader** of that monad type.

Readers are not counted as consumptions of the monad type. A generic is a reader for an monad argument only when that argument is not referenced in the generic body. For example, `type R<A extends O> = 1` is a reader, while `type R<A extends O> = A` is a consumer. If `V` extends monad type `T` and `R` is a reader, then `R<V>` does not consume `T` and may appear any number of times in a type declaration body. Only usages of `V` that are not wrapped in a reader call are counted.

The engine can be explicitly instructed to treat a given generic argument position in a given file as a reader or consumer. For example, `{ name: "Pair", index: 0 }` marks only the first argument of `Pair<_, _>` as reader semantics.

If a type variable `A` extending an monad type is wrapped in anything before being passed to a reader, that counts as a consumption. For example, if `R` is a reader and `C` is a consumer (non-reader):

- `R<A>` — does **not** consume `A`
- `R<[A]>` — **consumes** `A`
- `R<C<A>>` — **consumes** `A`
- `C<A>` — **consumes** `A`

A type variable extending an monad type may only be passed to a generic type at an argument position whose corresponding type parameter also extends that same monad type.
For example, if `O` is an monad type, then `type G<A extends O> = ...; type X<A extends O> = ... G<A> ...` is valid, but `type G<A> = ...; type X<A extends O> = ... G<A> ...` and `type G<A extends [U]> = ...; type X<A extends O> = ... G<A> ...` are not.

A type variable extending an monad type cannot be destructured in any way. It may not appear in the condition of a ternary operator at all, except when new type variables of the monad type are being inferred.

An monad type may only be used for inference as itself, not as part of a more complex type.
For example, if `O` is an monad type, then `... extends infer A extends O` is valid, but `... extends infer A extends [O]` and `... extends infer A extends X<O>` are not.

`extends` checks create relation-scoped consuming bindings. If the right side of an `extends` relation is monad-triggering (direct monad reference or `infer T extends Monad`), then right-side inferred vars are consuming-bound with local vars referenced on the left side of the same relation. Left-side vars are **not** implicitly consuming-bound to each other unless connected through that right-side trigger relation.

## API

## `parseTypes(path, content, options?)`

Input:

- `path`: source path used for metadata and import path resolution.
- `content`: TypeScript source text.
- `options.idPrefix`: id namespace for generated ids.

Output:

- `types`: flat list of discovered types (local/imported/type params/infers) with:
    - `id`, `name`, `path`, `refPath`, `scopeId`, `kind`, `position`.
- `scopes`: lexical/type scopes for file, declarations, type parameters, conditionals, branches, infers.
- `declarations`: normalized declaration analyses used by `checkMonad`.

## `checkMonad(parsed, options?)`

Input:

- `parsed`: `ParseTypesResult` from `parseTypes`.
- `options.forcedReaders[path]`: list of `{ name, index }` entries that force a specific generic argument position to be treated as a reader.
- `options.forcedConsumers[path]`: list of `{ name, index }` entries that force a specific generic argument position to be treated as a consumer.
- `options.monadTypes[path]`: list of `{ name }` entries for types to treat as monad for this check pass.

Output:

- `MonadViolation[]` with:
    - `kind`
    - `message`
    - `position`
    - optional `relatedPosition` (for prior consume in same path).

## Rule Model

The checker enforces:

- Consumer-once-per-leaf-path semantics.
- Reader exemption for direct reader arguments.
- Wrapped-before-reader semantics (`R<[A]>`, `R<C<A>>` consume).
- Monad variable in conditional check is forbidden.
- Monad argument can only flow to generic parameters constrained by same monad type.
- `infer A extends O` is valid, while complex monad infer constraints are invalid.

Conditional bodies are represented as ternary-tree paths:

- No conditional => one path.
- One conditional => root + two leaf paths.
- Nested conditionals => expanded path keys.

## Testing

- Framework: `node:test` + `node:assert/strict`.
- Parser tests: `test/parseTypes.test.ts` (30+ matrix cases).
- Monad checker matrix: `test/checkMonad.samples.ts` + `test/checkMonad.test.ts` (70 samples).
- Sample format:
    - each sample is a backtick string
    - first line comment starts with `ok:` or `fail:`
    - loop runner parses and checks each sample.

## Requirement To Test Traceability

- **Ternary tree behavior**
    - Covered by `ok: declaration with no ternary has one path`, `ok: branch isolated consumption`, generated branch samples.
- **Consumer once per path**
    - Covered by `fail: double consume in one path`.
- **Readers do not consume**
    - Covered by `ok: direct reader call is free`, `ok: nested readers remain non-consuming`, generated ok reader-path samples.
- **Wrapped value before reader consumes**
    - Covered by `fail: wrapped before reader counts consume`, `fail: consumer inside reader argument`, generated invalid wrapped samples.
- **Reader transitivity**
    - Covered by `ok: nested readers remain reader` and generated ok samples through reader wrappers.
- **Forced reader/consumer support**
    - Covered in checker tests (`checker skips forcibly marked reader declaration`, `checker skips forcibly marked consumer declaration`).
- **Monad generic argument constraint match**
    - Covered by `ok: monad argument passed to constrained parameter` and `fail: generic target parameter lacks monad constraint`.
- **No monad variable usage in conditional check**
    - Covered by `fail: monad variable in conditional condition`.
- **Infer constraints**
    - Covered by `ok: infer extends monad itself` and `fail: infer constraint is complex wrapper`.
- **parseTypes metadata requirements**
    - Name/path/refPath/scope/position/import metadata covered in parser matrix cases.

## Notes And Assumptions

- Monad types are only those explicitly listed in `options.monadTypes[path]`.
- Monad identity may propagate through direct type-parameter `extends` chains (for example, `C extends A` and `A extends O` means `C` is treated as bound to `O`).
- Import `refPath` uses normalized `dirname(path) + importSpecifier` and symbol suffix (`#TypeName`) without cwd absolutization.
- Outputs intentionally contain no AST nodes or source text blobs.
