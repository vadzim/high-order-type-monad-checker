import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { getMonadViolations } from "../src/monadChecker.ts"
import { monadSamples } from "./checkMonad.samples.ts"
import { parseFilesContent } from "../src/parseContent.ts"
import { formatViolation } from "../cli/format-violation.ts"

const sharedApiSource = readFileSync(new URL("../samples/api.ts", import.meta.url), "utf8")

test("checkMonad sample matrix", async (t: import("node:test").TestContext) => {
	for (const [idx, sample] of monadSamples.entries()) {
		const files =
			"modules" in sample
				? sample
				: {
						expectedKinds: sample.expectedKinds,
						name: sample.name,
						modules: [{ source: sample.source, file: sample.file ?? "../samples/file.ts" }],
					}

		await t.test(`${idx + 1}. ${files.name}`, () => {
			const sources = new Map(
				files.modules.map(({ file, source }) => [file, 'import { Monad } from "./api.ts";\n' + source]),
			)
			sources.set("../samples/api.ts", sharedApiSource)

			const parsed = parseFilesContent(sources, {
				idPrefix: `test-${idx}`,
			})

			const violations = getMonadViolations(parsed, {
				monadTypes: [
					{
						path: "../samples/api.ts",
						name: "Monad",
						consumerName: "MonadPrivate",
						constructorName: "MonadConstructor",
						readerName: "MonadReader",
					},
				],
			})

			const isOk = files.name.startsWith("ok:")
			const isFail = files.name.startsWith("fail:")
			assert.equal(isOk || isFail, true, "Sample header must start with ok: or fail:")

			if (violations.length > 0) {
				console.log(`${idx + 1}. ${files.name}`)
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
