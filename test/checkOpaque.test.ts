import test from "node:test"
import assert from "node:assert/strict"
import { parseTypes } from "../src/parseTypes.ts"
import { getOpaqueViolations } from "../src/borrowChecker.ts"
import { opaqueSamples } from "./checkOpaque.samples.ts"

function sampleHeader(source: string): string {
	return source.split("\n")[0]?.replace("//", "").trim() ?? "unknown"
}

test("checkOpaque sample matrix", async (t: import("node:test").TestContext) => {
	for (const [idx, sample] of opaqueSamples.entries()) {
		const source = typeof sample === "string" ? sample : sample.source
		const filePath = typeof sample === "string" || !sample.file ? "../samples/file.ts" : sample.file
		const expectedKinds = typeof sample === "object" ? sample.expectedKinds : undefined
		const header = sampleHeader(source)
		await t.test(`${idx + 1}. ${header}`, () => {
			const parsed = parseTypes(filePath, source, { idPrefix: `sample-${idx}` })
			const violations = getOpaqueViolations(parsed, {
				opaqueTypes: [
					{ path: "../samples/file.ts", name: "O" },
					{ path: "../samples/api.ts", name: "Opaque" },
				],
				forcedReaders: [{ path: "../samples/api.ts", name: "Read", index: 0 }],
				forcedConsumers: [{ path: "../samples/api.ts", name: "Consume", index: 0 }],
			})
			const isOk = header.startsWith("ok:")
			const isFail = header.startsWith("fail:")
			assert.equal(isOk || isFail, true, "Sample header must start with ok: or fail:")

			if (isOk) {
				assert.equal(violations.length, 0, `Expected no violations, got ${JSON.stringify(violations)}`)
			} else {
				assert.ok(violations.length > 0, "Expected at least one violation")
				if (expectedKinds?.length) {
					const kinds = new Set(violations.map(v => v.kind))
					for (const expected of expectedKinds) {
						assert.ok(kinds.has(expected), `Missing expected violation kind ${expected}`)
					}
				}
			}
		})
	}
})

test("checker throws when no opaqueTypes provided", () => {
	const source = `type O = { __opaque: "O" }; type X<A extends O> = A;`
	const parsed = parseTypes("/samples/no-opaque-option.ts", source, {
		idPrefix: "missing-opaque-option",
	})
	assert.throws(() => getOpaqueViolations(parsed), /requires at least one opaque type in options\.opaqueTypes/i)
})

test("forced reader slot applies only selected argument index", () => {
	const source = `
type O = { __opaque: "O" };
type Pair<T, U> = [T, U];
type X<A extends O> = [Pair<A, string>, Pair<number, A>];
`
	const parsed = parseTypes("/samples/file.ts", source, {
		idPrefix: "test",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/file.ts", name: "O" }],
		forcedReaders: [{ path: "/samples/file.ts", name: "Pair", index: 0 }],
	})
	assert.ok(!violations.some(v => v.kind === "opaque.consumeMultipleInPath"))
})

test("checker keeps non-forced arguments as consumers", () => {
	const source = `
type O = { __opaque: "O" };
type Pair<T, U> = [T, U];
type X<A extends O> = [Pair<A, A>, Pair<A, A>];
`
	const parsed = parseTypes("/samples/file.ts", source, {
		idPrefix: "forced-consumer",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/file.ts", name: "O" }],
		forcedReaders: [{ path: "/samples/file.ts", name: "Pair", index: 0 }],
	})
	assert.ok(violations.some(v => v.kind === "opaque.consumeMultipleInPath"))
})

test("forced consumer only affects propagation stage", () => {
	const source = `
type O = { __opaque: "O" };
type R<A extends O> = A;
type X<A extends O> = [R<A>, R<A>];
`
	const parsed = parseTypes("/samples/file.ts", source, {
		idPrefix: "forced-consumer-override",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/file.ts", name: "O" }],
		forcedConsumers: [{ path: "/samples/file.ts", name: "R", index: 0 }],
	})
	assert.ok(violations.some(v => v.kind === "opaque.consumeMultipleInPath"))
})

test("checker supports explicit opaqueTypes map", () => {
	const source = `
type Secret<T> = T;
type X<U> = U extends infer A extends Secret<string> ? A : never;
`
	const parsed = parseTypes("/samples/explicit-opaque.ts", source, {
		idPrefix: "explicit-opaque",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/explicit-opaque.ts", name: "Secret" }],
	})
	assert.ok(violations.some(v => v.kind === "opaque.invalidInferConstraint"))
})

test("checker does not infer opaque types outside explicit options", () => {
	const source = `
type O = { __opaque: "O" };
type G<A> = A;
type Y<A extends O> = G<A>;
type Secret<T> = T;
type Z<U> = U extends infer A extends Secret<string> ? A : never;
`
	const parsed = parseTypes("/samples/merge-opaque.ts", source, {
		idPrefix: "merge-opaque",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/merge-opaque.ts", name: "Secret" }],
	})
	const kinds = new Set(violations.map(v => v.kind))
	assert.ok(!kinds.has("opaque.invalidGenericArgumentConstraint"))
	assert.ok(kinds.has("opaque.invalidInferConstraint"))
})

test("invalid generic constraint includes related declaration position", () => {
	const source = `
type O = { __opaque: "O" };
type G<A> = A;
type X<A extends O> = G<A>;
`
	const parsed = parseTypes("/samples/related-position.ts", source, {
		idPrefix: "related-position",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/related-position.ts", name: "O" }],
	})
	const v = violations.find(x => x.kind === "opaque.invalidGenericArgumentConstraint")
	assert.ok(v, `Expected invalid generic constraint violation: ${JSON.stringify(violations)}`)
	assert.ok(v!.relatedPosition, "Expected related declaration position for invalid generic constraint.")
})

test("options resolve imported path when target file is not parsed", () => {
	const source = `
import type { Secret } from "./opaque";
type X<T> = T extends infer A extends [Secret] ? A : never;
`
	const parsed = parseTypes("/samples/main.ts", source, {
		idPrefix: "imported-option-resolution",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/opaque", name: "Secret" }],
	})
	assert.ok(!violations.some(v => v.kind === "opaque.invalidInferConstraint"))
})

test("ok: unresolved forced target allows call-site generic constraints", () => {
	const source = `
type O = { __opaque: "O" };
type X<A extends O> = ExternalFn<A>;
`
	const parsed = parseTypes("/samples/unresolved-forced-ok.ts", source, {
		idPrefix: "unresolved-forced-ok",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/unresolved-forced-ok.ts", name: "O" }],
		forcedConsumers: [{ path: "/samples/api.ts", name: "ExternalFn", index: 0 }],
	})
	assert.equal(violations.length, 0, `Expected unresolved forced call to be allowed: ${JSON.stringify(violations)}`)
})

test("ok: unresolved imported generic is accepted as consumer", () => {
	const source = `
type O = { __opaque: "O" };
import type { ReadExpectedIdentifier } from "./helpers";
type X<Tokens extends O> = ReadExpectedIdentifier<Tokens, "err">;
`
	const parsed = parseTypes("/samples/unresolved-imported-generic-ok.ts", source, {
		idPrefix: "unresolved-imported-generic-ok",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/unresolved-imported-generic-ok.ts", name: "O" }],
	})
	assert.ok(
		!violations.some(v => v.kind === "opaque.invalidGenericArgumentConstraint"),
		`Expected unresolved imported generic to be accepted: ${JSON.stringify(violations)}`,
	)
})

test("fail: resolvable forced declaration must extend opaque at forced index", () => {
	const source = `
type O = { __opaque: "O" };
type Pair<T, U extends O> = [T, U];
type X<A extends O> = Pair<A, A>;
`
	const parsed = parseTypes("/samples/resolved-forced-fail.ts", source, {
		idPrefix: "resolved-forced-fail",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/resolved-forced-fail.ts", name: "O" }],
		forcedReaders: [{ path: "/samples/resolved-forced-fail.ts", name: "Pair", index: 0 }],
	})
	assert.ok(
		violations.some(v => v.kind === "opaque.invalidGenericArgumentConstraint"),
		`Expected forced declaration mismatch violation: ${JSON.stringify(violations)}`,
	)
})

test("opaque identity propagates through type-parameter chains", () => {
	const source = `
type O = { __opaque: "O" };
type G<T> = T;
type X<A extends O, C extends A> = G<C>;
`
	const parsed = parseTypes("/samples/chained-opaque-constraint.ts", source, {
		idPrefix: "chained-opaque-constraint",
	})
	const violations = getOpaqueViolations(parsed, {
		opaqueTypes: [{ path: "/samples/chained-opaque-constraint.ts", name: "O" }],
	})
	assert.ok(
		violations.some(v => v.kind === "opaque.invalidGenericArgumentConstraint"),
		`Expected chained opaque variable to preserve opaque identity: ${JSON.stringify(violations)}`,
	)
	const genericViolation = violations.find(v => v.kind === "opaque.invalidGenericArgumentConstraint")
	assert.ok(
		genericViolation?.message.includes("'C extends O'"),
		`Expected violation for argument C: ${JSON.stringify(violations)}`,
	)
	assert.ok(
		!violations.some(v => v.message.includes("'A'") && v.kind === "opaque.invalidGenericArgumentConstraint"),
		`Did not expect A to be treated as opaque identity: ${JSON.stringify(violations)}`,
	)
})
