# Project Development Rules

## Workflow

- Run `prettier` after every code change.
- Run tests after behavior changes; prefer `npm test` for full validation.
- Keep one-file and multi-file behavior identical.
- Make focused commits with clear descriptions when asked.

## Code Style

- Keep logic plain and human-readable.
- Prefer straightforward control flow over helper functions with many arguments.
- Refactor large modules for readability when complexity grows.

## Content Graph / Structure Guarantees

- `CGTypeRef.ref` must always resolve to the correct declared type.
- `CGTypeRef.name` must preserve the correct local name.
- `CGType.declaration` points to the first argument of `<typeDeclaration>`.
- `CGType.body` points to the second argument of `<typeDeclaration>`.
- Fail fast on duplicate names in scope (including duplicate imports) to avoid building huge invalid structures.

## Monad Checker Rules (project-level)

- Monad marker type (`monad class` from settings) is only a marker, with explicitly allowed structural uses.
- A monad value can be consumed once per branch scope (except configured reader semantics).
- Monad passing rules must be enforced consistently across tuples, conditionals, generic args, and cross-file references.
- Producer/consumer usage and return-shape constraints must be enforced in all branches.
- Configured special consumer rules override user-consumer defaults where explicitly allowed.

## Diagnostics

- Error messages must be explicit and actionable.
- Include precise source marks and related/context locations when possible.
- Prefer Rust-like diagnostics quality: primary error + useful related “because/previously here” context.
- If output seems noisy or redundant, prioritize clearer, higher-signal diagnostics.

## Documentation

- Update `README.md` whenever checker behavior or rules change.
- Keep internal assumptions out of README (internal details stay internal).
