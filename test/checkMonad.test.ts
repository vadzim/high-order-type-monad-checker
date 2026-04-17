import test from "node:test"
import assert from "node:assert/strict"
import { parseTypes } from "../src/parseTypes.ts"
import { getMonadViolations } from "../src/monadChecker.ts"
import { monadSamples } from "./checkMonad.samples.ts"

function sampleHeader(source: string): string {
	return source.split("\n")[0]?.replace("//", "").trim() ?? "unknown"
}

test("checkMonad sample matrix", async (t: import("node:test").TestContext) => {
	for (const [idx, sample] of monadSamples.entries()) {
		const source = typeof sample === "string" ? sample : sample.source
		const filePath = typeof sample === "string" || !sample.file ? "../samples/file.ts" : sample.file
		const expectedKinds = typeof sample === "object" ? sample.expectedKinds : undefined
		const header = sampleHeader(source)
		await t.test(`${idx + 1}. ${header}`, () => {
			const parsed = parseTypes(filePath, source, { idPrefix: `sample-${idx}` })
			const violations = getMonadViolations(new Map([[filePath, parsed]]), {
				monadTypes: [{ path: "../samples/api.ts", name: "Monad" }],
				// forcedReaders: [{ path: "../samples/api.ts", name: "Read", index: 0 }],
				// forcedConsumers: [{ path: "../samples/api.ts", name: "Consume", index: 0 }],
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
