import test from "node:test"
import { getMonadViolations } from "../src/monadChecker2.ts"
import { buildContentGraph } from "../src/buildContentGraph.ts"
import { concatContentGraphs } from "../src/concatContentGraphs.ts"
import assert from "node:assert"
import { never } from "../src/utils.ts"

test("checkMonad basic", async (t: import("node:test").TestContext) => {
	const files = new Map([
		[
			"./monad.ts",
			`
export type Monad = { head: string, tail: string }
export type MCreate<Text extends string> =
    Parse<string> extends [infer Head extends string, infer Tail extends string]
    ? { head: Head, tail: Tail } extends infer Result extends Monad
        ? Result
        : never
    : never
export type MRead<M extends Monad> = M["head"]
export type MNext<M extends Monad> = MCreate<M["tail"]>
export type MGet<M extends Monad> = [MNext<M>, MRead<M>]
export type MGet2<M extends Monad> = MNext<M> extends infer N extends Monad ? [N, MRead<M>] : never
`,
		],
		[
			"./file.ts",
			`
import { Monad } from "./monad.ts"    
`,
		],
	])

	const graph = concatContentGraphs(files.entries().map(([path, content]) => buildContentGraph(path, content)))

	const monadDecls = graph.types.values().find(t => t.name === "Monad")?.called

	assert.ok(monadDecls?.values().every(c => c.parent?.type.name === "<extends>" && c.parent?.arguments[1] === c))

	const infers = monadDecls
		?.values()
		.map(c => c.parent?.arguments[0])
		.filter(t => t != null)
		.toArray()

	assert.ok(infers?.values().every(c => c.type.name === "<typeDeclaration>"))

	// console.log(infers)

	const violations = getMonadViolations(graph, {
		path: "./monad.ts",
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

	// assert.deepEqual(violations, [])
})
