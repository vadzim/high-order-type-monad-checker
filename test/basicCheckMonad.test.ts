import test from "node:test"
import { getMonadViolations } from "../src/monadChecker2.ts"
import { buildContentGraph } from "../src/buildContentGraph.ts"
import { concatContentGraphs } from "../src/concatContentGraphs.ts"
import assert from "node:assert/strict"
import { never } from "../src/utils.ts"
import { validateContracts } from "./buildContentGraph.test.ts"

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

function buildScenarioGraph(fileSource: string) {
	const files = new Map([["./monad.ts", `${monadModule}\n${fileSource}`]])

	return {
		files,
		graph: validateContracts(
			concatContentGraphs(
				files.entries().map(([path, content]) => validateContracts(buildContentGraph(path, content))),
			),
		),
	}
}

function getScenarioViolations(fileSource: string) {
	const { files, graph } = buildScenarioGraph(fileSource)
	const violations = getMonadViolations(graph, {
		path: "./monad.ts",
		name: "Monad",
		constructorName: "MCreate",
		readerName: "MRead",
		consumerName: "MNext",
	})

	return { files, graph, violations }
}

function formatViolations(files: Map<string, string>, violations: ReturnType<typeof getMonadViolations>) {
	return violations.map(violation => {
		const file = files.get(violation.path) ?? ""
		return `${violation.kind}: ${violation.message}\n${file.slice(violation.position.start, violation.position.end)}`
	})
}

test("checkMonad basic", async (t: import("node:test").TestContext) => {
	const { files, graph } = buildScenarioGraph("")

	const monadDecls = Array.from(graph.types.values().find(t => t.name === "Monad")?.called ?? []).filter(
		c => c.parent?.type.name !== "<typeDeclaration>",
	)

	assert.ok(monadDecls.every(c => c.parent?.type.name === "<extends>" && c.parent?.arguments[1] === c))

	const infers = monadDecls.map(c => c.parent?.arguments[0]).filter(t => t != null)

	assert.ok(infers.every(c => c.type.name === "<typeDeclaration>"))

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

	assert.deepEqual(violations, [])
})

test("checkMonad rule matrix", async t => {
	for (const sample of [
		{
			name: "ok: marker is used to declare first generic parameter",
			source: `type Ok<M extends Monad> = M;`,
			ok: true,
		},
		{
			name: "fail: monad class marker cannot be used as value",
			source: `type Bad = [Monad, 1];`,
			ok: false,
		},
		{
			name: "fail: only first generic parameter may be monad-marked",
			source: `type Bad<X, M extends Monad> = [M, X];`,
			ok: false,
		},
		{
			name: "fail: monad value can only be passed as first generic argument",
			source: `type Pair<X, Y> = [X, Y]; type Bad<M extends Monad> = Pair<1, M>;`,
			ok: false,
		},
		{
			name: "ok: reader may consume monad multiple times",
			source: `type Ok<M extends Monad> = [M, [MRead<M>, MRead<M>]];`,
			ok: true,
		},
		{
			name: "fail: same branch cannot consume monad twice outside reader",
			source: `type Pair<X, Y> = [X, Y]; type Bad<M extends Monad> = Pair<M, M>;`,
			ok: false,
		},
		{
			name: "ok: sibling conditional branches may consume separately",
			source: `type Ok<M extends Monad> = 1 extends 2 ? [M, 0] : [M, 1];`,
			ok: true,
		},
		{
			name: "fail: consumer must return consumer shape in all branches",
			source: `type Bad<M extends Monad> = 1 extends 2 ? [M, 0] : string;`,
			ok: false,
		},
		{
			name: "ok: consumer may return another consumer call",
			source: `type Ok<M extends Monad> = MNext<M>;`,
			ok: true,
		},
		{
			name: "fail: consumer call cannot be wrapped",
			source: `type Wrap<T> = T; type Bad<M extends Monad> = Wrap<MNext<M>>;`,
			ok: false,
		},
		{
			name: "fail: consumer call with direct marker tuple rhs is not allowed",
			source: `type Bad<M extends Monad> = MNext<M> extends [Monad, infer R] ? never : never;`,
			ok: false,
		},
		{
			name: "ok: consumer call may appear on left side of extends with infer constrained by marker",
			source: `type Ok<M extends Monad> = MNext<M> extends [infer N extends Monad, ...infer _] ? never : never;`,
			ok: true,
		},
		{
			name: "fail: consumer call on left side of extends needs tuple rhs",
			source: `type Bad<M extends Monad> = MNext<M> extends Monad ? never : never;`,
			ok: false,
		},
	] as const) {
		await t.test(sample.name, () => {
			const { files, violations } = getScenarioViolations(sample.source)
			if (sample.ok) {
				assert.deepEqual(violations, [], formatViolations(files, violations).join("\n\n"))
			} else {
				assert.ok(violations.length > 0, "Expected at least one violation")
			}
		})
	}
})
