import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { getMonadViolations } from "../src/monadChecker.ts"
import { monadSamples } from "./checkMonad.samples.ts"
import { parseFilesContent } from "../src/parseContent.ts"
import { formatViolation } from "../cli/format-violation.ts"

function sampleHeader(source: string): string {
	return source.split("\n")[0]?.replace("//", "").trim() ?? "unknown"
}

function sampleText(source: string): string {
	return source.replace(/^\/\/ .*?\n/, "").trim()
}

const sharedApiSource = readFileSync(new URL("../samples/api.ts", import.meta.url), "utf8")

test("checkMonad sample matrix", async (t: import("node:test").TestContext) => {
	for (const [idx, sample] of monadSamples.entries()) {
		const files =
			typeof sample === "object" && "modules" in sample
				? sample
				: typeof sample === "string"
					? {
							expectedKinds: undefined,
							test: sampleHeader(sample),
							modules: [{ source: sampleText(sample), file: "../samples/file.ts" }],
						}
					: {
							expectedKinds: sample.expectedKinds,
							test: sampleHeader(sample.source),
							modules: [{ source: sampleText(sample.source), file: sample.file ?? "../samples/file.ts" }],
						}

		await t.test(`${idx + 1}. ${files.test}`, () => {
			const sources = new Map(files.modules.map(({ file, source }) => [file, source]))
			sources.set("../samples/api.ts", sharedApiSource)

			const parsed = parseFilesContent(sources, {
				idPrefix: `test-${idx}`,
			})

			const violations = getMonadViolations(parsed, {
				monadTypes: [{ path: "../samples/api.ts", name: "Monad", privateName: "MonadPrivate" }],
			})

			const isOk = files.test.startsWith("ok:")
			const isFail = files.test.startsWith("fail:")
			assert.equal(isOk || isFail, true, "Sample header must start with ok: or fail:")

			if (violations.length > 0) {
				console.log(`${idx + 1}. ${files.test}`)
				for (const violation of violations) {
					const formatted = formatViolation(
						violation,
						{ files: sources, parsed: parsed },
						{ contextAfter: 3 },
					)
					console.log(formatted)
				}
			}

			if (isOk) {
				assert.equal(violations.length, 0, `Expected no violations, got ${JSON.stringify(violations)}`)
			} else {
				assert.ok(violations.length > 0, "Expected at least one violation")

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
