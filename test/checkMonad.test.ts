import test from "node:test"
import assert from "node:assert/strict"
import { parseTypes } from "../src/parseContent.ts"
import { getMonadViolations } from "../src/monadChecker.ts"
import { monadSamples } from "./checkMonad.samples.ts"
import { parseFilesContent } from "../src/parseContent.ts"
import { formatViolation } from "../cli/format-violation.ts"

function sampleHeader(source: string): string {
	return source.split("\n")[0]?.replace("//", "").trim() ?? "unknown"
}

test("checkMonad sample matrix", async (t: import("node:test").TestContext) => {
	for (const [idx, sample] of monadSamples.entries()) {
		const files =
			typeof sample === "object" && "modules" in sample
				? sample
				: typeof sample === "string"
					? {
							expectedKinds: undefined,
							test: sampleHeader(sample),
							modules: [{ source: sample, file: "../samples/file.ts" }],
						}
					: {
							expectedKinds: sample.expectedKinds,
							test: sampleHeader(sample.source),
							modules: [{ source: sample.source, file: sample.file ?? "../samples/file.ts" }],
						}

		await t.test(`${idx + 1}. ${files.test}`, () => {
			const sources = new Map(files.modules.map(({ file, source }) => [file, source]))

			const parsed = parseFilesContent(sources, {
				idPrefix: `test-${idx}`,
			})

			const violations = getMonadViolations(parsed, {
				monadTypes: [{ path: "../samples/api.ts", name: "Monad" }],
			})

			const isOk = files.test.startsWith("ok:")
			const isFail = files.test.startsWith("fail:")
			assert.equal(isOk || isFail, true, "Sample header must start with ok: or fail:")

			if (isOk) {
				assert.equal(violations.length, 0, `Expected no violations, got ${JSON.stringify(violations)}`)
			} else {
				assert.ok(violations.length > 0, "Expected at least one violation")

				for (const violation of violations) {
					const formatted = formatViolation(
						violation,
						{ files: sources, parsed: parsed },
						{ contextAfter: 3 },
					)
					console.log(formatted)
				}

				if (files.expectedKinds?.length) {
					const kinds = new Set(violations.map(v => v.kind))
					for (const expected of files.expectedKinds) {
						assert.ok(kinds.has(expected), `Missing expected violation kind ${expected}`)
					}
				}
			}
		})
	}
})

test("skipDeclarationBodies drops violations attributed to that declaration", () => {
	const file = "../samples/skip-body-test.ts"
	const source = `import { Monad } from "./api.ts";
type Ignored<A extends Monad> = { a: A };
type StillChecked<A extends Monad> = { a: A };
`
	const sources = new Map([[file, source]])
	const parsed = parseFilesContent(sources, { idPrefix: "skip-body" })
	const base = getMonadViolations(parsed, {
		monadTypes: [{ path: "../samples/api.ts", name: "Monad" }],
	})
	assert.ok(base.length >= 2, "Expected violations in both declarations without skip")

	const ignoredId = [...parsed.values()]
		.flatMap(({ types }) => [...types.values()])
		.find(t => t.name === "Ignored" && t.kind === "typeAlias")?.id
	assert.ok(ignoredId)

	const skipped = getMonadViolations(parsed, {
		monadTypes: [{ path: "../samples/api.ts", name: "Monad" }],
		skipDeclarationBodies: [{ path: file, name: "Ignored" }],
	})
	assert.equal(
		skipped.filter(v => v.declarationId === ignoredId).length,
		0,
		"No diagnostics for Ignored body when skipped",
	)
	assert.ok(
		skipped.some(v => v.declarationId !== ignoredId),
		"StillChecked should still produce violations",
	)
})
