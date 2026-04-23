import test from "node:test"
import { getMonadViolations } from "../src/monadChecker.ts"
import { buildContentGraph } from "../src/buildContentGraph.ts"
import { concatContentGraphs } from "../src/concatContentGraphs.ts"
import assert from "node:assert/strict"
import { never } from "../src/utils.ts"
import { validateContracts } from "./buildContentGraph.test.ts"
import { monadSamples } from "./checkMonad.samples.ts"
import { formatGraphViolation } from "../cli/format-graph-violation.ts"

const monadModule = `
export type Monad = { head: string, tail: string }
export type MCreate<Text extends string> =
    Parse<string> extends [infer Head extends string, infer Tail extends string]
    ? [{ head: Head, tail: Tail }] extends [infer Result extends Monad]
        ? Result
        : never
    : never
export type MRead<M extends Monad> = M["head"]
export type MNext<M extends Monad> = MCreate<M["tail"]>
export type MGet<M extends Monad> = [MNext<M>, MRead<M>]
export type MGet2<M extends Monad> = MGet<M>
`

const fileModule = `
import type { Monad, MCreate, MRead, MNext, MGet, MGet2 } from "./api.ts"
`

function buildScenarioGraph(files: Map<string, string>) {
	return validateContracts(
		concatContentGraphs(
			files.entries().map(([path, content]) => validateContracts(buildContentGraph(path, content))),
		),
	)
}

test("checkMonad basic", async () => {
	const files = new Map([["../samples/api.ts", monadModule]])
	const graph = buildScenarioGraph(files)

	const monadDecls = Array.from(graph.types.values().find(t => t.name === "Monad")?.called ?? []).filter(
		c => c.parent?.type.name !== "<typeDeclaration>",
	)

	assert.ok(monadDecls.every(c => c.parent?.type.name === "<extends>" && c.parent?.arguments[1] === c))

	const infers = monadDecls.map(c => c.parent?.arguments[0]).filter(t => t != null)

	assert.ok(infers.every(c => c.type.name === "<typeDeclaration>"))

	const violations = getMonadViolations(graph, {
		path: "./api.ts",
		name: "Monad",
		constructorName: "MCreate",
		readerName: "MRead",
		consumerName: "MNext",
	})

	for (const violation of violations) {
		const file = files.get(violation.path) ?? never()
		console.log(violation.message)
		console.log(
			"\x1b[90m" + // dar gray
				file.slice(0, violation.position.start) +
				"\x1b[0m" +
				"\x1b[91;1m" + // light red + bold
				file.slice(violation.position.start, violation.position.end) +
				"\x1b[0m" +
				"\x1b[90m" + // dar gray
				file.slice(violation.position.end) +
				"\x1b[0m",
		)
		console.log("")
	}

	assert.deepEqual(violations, [])
})

test("checkMonad rule matrix", async t => {
	for (const sample of monadSamples) {
		for (const multipleFilesMode of ["same", "different", "alone"] as const) {
			const files = new Map(
				(multipleFilesMode === "same"
					? "source" in sample
						? [[sample.file || "../samples/api.ts", `${monadModule}\n${sample.source}`] as const]
						: []
					: [
							...(multipleFilesMode === "different" ? [["../samples/api.ts", monadModule] as const] : []),
							...("source" in sample
								? [{ file: sample.file || "../samples/file.ts", source: sample.source }]
								: sample.modules
							).map(({ file, source }) => [file, `${fileModule}\n${source}`] as const),
						]
				).map(([path, content]) => [path, content.trim()] as const),
			)

			if (files.size === 0) continue

			await t.test(sample.name + " (" + multipleFilesMode + ")", () => {
				// console.log(sample.name + " " + multipleFiles)

				const graph = buildScenarioGraph(files)

				const violations = getMonadViolations(graph, {
					path: "../samples/api.ts",
					name: "Monad",
					constructorName: "MCreate",
					readerName: "MRead",
					consumerName: "MNext",
					strictMonadModule: multipleFilesMode !== "alone",
				})

				const formattedViolations = violations
					.map(violation => formatGraphViolation(violation, files, { contextBefore: 7, contextAfter: 5 }))
					.join("\n\n")

				// const { files, violations } = getScenarioViolations(sample.source, multipleFilesMode)
				if (sample.name.startsWith("ok:")) {
					assert.ok(violations.length === 0, formattedViolations)
				} else {
					if (formattedViolations && multipleFilesMode === "different") {
						console.error(formattedViolations)
					}
					assert.ok(violations.length > 0, "Expected at least one violation")
					if (sample.expectedKinds) {
						const actualKinds = Array.from(new Set(violations.map(violation => violation.kind))).sort()
						const expectedKinds = Array.from(new Set(sample.expectedKinds)).sort()
						assert.deepEqual(
							actualKinds,
							expectedKinds,
							[
								`Expected exact violation kinds for sample: ${sample.name}`,
								`Expected: ${expectedKinds.join(", ")}`,
								`Actual: ${actualKinds.join(", ")}`,
								formattedViolations,
							].join("\n"),
						)
					}
				}
			})
		}
	}
})
