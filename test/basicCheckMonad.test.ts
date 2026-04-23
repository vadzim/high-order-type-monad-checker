import test from "node:test"
import { getMonadViolations } from "../src/monadChecker2.ts"
import { buildContentGraph } from "../src/buildContentGraph.ts"
import { concatContentGraphs } from "../src/concatContentGraphs.ts"
import assert from "node:assert/strict"
import { never } from "../src/utils.ts"
import { validateContracts } from "./buildContentGraph.test.ts"
import { monadSamples, type MonadSample } from "./checkMonad.samples.ts"

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

function getScenarioViolations(fileSource: string, multipleFilesMode: "same" | "different" | "alone") {
	const files =
		multipleFilesMode === "different"
			? new Map([
					["../samples/api.ts", monadModule],
					["../samples/file.ts", `${fileModule}\n${fileSource}`],
				])
			: multipleFilesMode === "same"
				? new Map([["../samples/api.ts", `${monadModule}\n${fileSource}`]])
				: multipleFilesMode === "alone"
					? new Map([["../samples/file.ts", `${fileModule}\n${fileSource}`]])
					: never()

	const graph = buildScenarioGraph(files)

	const violations = getMonadViolations(graph, {
		path: "../samples/api.ts",
		name: "Monad",
		constructorName: "MCreate",
		readerName: "MRead",
		consumerName: "MNext",
		strictMonadModule: multipleFilesMode !== "alone",
	})

	return { files, violations }
}

function formatViolations(files: Map<string, string>, violations: ReturnType<typeof getMonadViolations>) {
	return violations.map(violation => {
		const file = files.get(violation.path) ?? ""
		return `${violation.kind}: ${violation.message}\n${file.slice(violation.position.start, violation.position.end)}`
	})
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
	const samples: MonadSample[] = [
		{
			name: "ok: marker is used to declare first generic parameter",
			source: `type Ok<M extends Monad> = [M, 0];`,
		},
		{
			name: "fail: monad class marker cannot be used as value",
			source: `type Bad = [Monad, 1];`,
		},
		{
			name: "fail: only first generic parameter may be monad-marked",
			source: `type Bad<X, M extends Monad> = [M, X];`,
		},
		{
			name: "fail: monad value can only be passed as first generic argument",
			source: `type Pair<X, Y> = [X, Y]; type Bad<M extends Monad> = Pair<1, M>;`,
		},
		{
			name: "ok: reader may consume monad multiple times",
			source: `type Ok<M extends Monad> = [M, [MRead<M>, MRead<M>]];`,
		},
		{
			name: "fail: same branch cannot consume monad twice outside reader",
			source: `type Pair<X, Y> = [X, Y]; type Bad<M extends Monad> = Pair<M, M>;`,
		},
		{
			name: "ok: sibling conditional branches may consume separately",
			source: `type Ok<M extends Monad> = 1 extends 2 ? [M, 0] : [M, 1];`,
		},
		{
			name: "fail: consumer must return consumer shape in all branches",
			source: `type Bad<M extends Monad> = 1 extends 2 ? [M, 0] : string;`,
		},
		{
			name: "fail: user type with monad input cannot return bare monad",
			source: `type Bad<M extends Monad> = MNext<M>;`,
		},
		{
			name: "fail: consumer call cannot be wrapped",
			source: `type Wrap<T> = T; type Bad<M extends Monad> = Wrap<MNext<M>>;`,
		},
		{
			name: "ok: configured consumer may be passed as first arg to monad-input type",
			source: `type Use<M extends Monad> = [M, 0]; type Ok<M extends Monad> = Use<MNext<MNext<M>>>;`,
		},
		{
			name: "ok: configured consumer may be returned as first item in a tuple",
			source: `type Ok<M extends Monad> = [MNext<MNext<M>>, 0];`,
		},
		{
			name: "fail: monad cannot be consumed twice in a tuple",
			source: `type Bad<M extends Monad> = [MNext<M>, MNext<M>];`,
		},
		{
			name: "fail: monad cannot be consumed twice in an object",
			source: `type Bad<M extends Monad> = { head: MNext<M>, tail: MNext<M> };`,
		},
		{
			name: "ok: monad can be consumed in a conditional infer constraint in a first arg of a tuple",
			source: `type Ok<M extends Monad> = [MNext<M>] extends [infer X extends Monad] ? [X, 1] : never;`,
		},
		{
			name: "fail: monad M cannot be consumed in a condition and in its true branch",
			source: `type Bad<M extends Monad> = [MNext<M>] extends [infer X extends Monad] ? [MNext<M>, 1] : never;`,
		},
		{
			name: "fail: monad M cannot be consumed in a condition and in its false branch",
			source: `type Bad<M extends Monad> = [MNext<M>] extends [infer X extends Monad] ? never : [MNext<M>, 1];`,
		},
		{
			name: "fail: consumer call with direct marker tuple rhs is not allowed",
			source: `type Bad<M extends Monad> = MNext<M> extends [Monad, infer R] ? never : never;`,
		},
		{
			name: "ok: consumer call may appear on left side of extends with infer constrained by marker",
			source: `type Ok<M extends Monad> = MNext<M> extends [infer N extends Monad, ...infer _] ? never : never;`,
		},
		{
			name: "fail: consumer call on left side of extends needs tuple rhs",
			source: `type Bad<M extends Monad> = MNext<M> extends Monad ? never : never;`,
		},
		{
			name: "ok: monad M can be passed to argument of Monad type class",
			source: `type Wrap<T extends Monad> = [T, 1]; type Ok<M extends Monad> = Wrap<M> extends [infer N extends Monad, infer R] ? [N, R] : never;`,
		},
		{
			name: "fail: monad M should be passed only to argument of Monad type class",
			source: `type Wrap<T> = T; type Bad<M extends Monad> = Wrap<M> extends [infer N extends Monad, infer R] ? [N, R] : never;`,
		},
		{
			name: "fail: monad M should be passed only to argument of Monad type class (2)",
			source: `type Bad<M extends Monad> = Array<M> extends [infer N extends Monad, infer R] ? [N, R] : never;`,
		},
		{
			name: "fail: monad M should be passed only to argument of Monad type class (3)",
			source: `type Bad<M extends Monad> = M[1] extends [infer N extends Monad, infer R] ? [N, R] : never;`,
		},
		{
			name: "fail: monad M should be passed only to argument of Monad type class (4)",
			source: `type Bad<M extends Monad> = \`\${M}\` extends [infer N extends Monad, infer R] ? [N, R] : never;`,
		},
		{
			name: "ok: user producer call with extra args may be returned immediately by another producer",
			source: `type P<A extends Monad, Msg extends string> = [A, Msg]; type R<A extends Monad> = P<A, "x">;`,
		},
		{
			name: "ok: user producer call with extra args may be immediately destructured in conditional",
			source: `type P<A extends Monad, Msg extends string> = [A, Msg]; type R<A extends Monad> = P<A, "x"> extends [infer M2 extends Monad, infer R2] ? [M2, R2] : never;`,
		},
		{
			name: "fail: user producer call must not be used as generic argument",
			source: `type P<A extends Monad, Msg extends string> = [A, Msg]; type Wrap<T extends Monad> = [T, 0]; type Bad<A extends Monad> = Wrap<P<A, "x">>;`,
		},
		{
			name: "fail: user producer call in conditional must destructure first item as infer ... extends Monad",
			source: `type P<A extends Monad, Msg extends string> = [A, Msg]; type Bad<A extends Monad> = P<A, "x"> extends [infer M2, infer R2] ? [M2, R2] : never;`,
		},
		{
			name: "fail: user producer call in conditional must destructure monad in first slot",
			source: `type P<A extends Monad, Msg extends string> = [A, Msg]; type Bad<A extends Monad> = P<A, "x"> extends [infer R2, infer M2 extends Monad] ? [M2, R2] : never;`,
		},
		{
			name: "ok: user producer that returns another producer is still a user producer and may be returned immediately",
			source: `type P<A extends Monad> = [A, 1]; type Q<A extends Monad> = P<A>; type R<A extends Monad> = Q<A>;`,
		},
		{
			name: "fail: user producer that returns another producer keeps producer invocation restrictions",
			source: `type P<A extends Monad> = [A, 1]; type Q<A extends Monad> = P<A>; type Bad<A extends Monad> = [A, Q<A>];`,
		},
		...monadSamples,
	]

	for (const sample of samples) {
		for (const multipleFilesMode of ["same", "different", "alone"] as const) {
			const files = new Map(
				multipleFilesMode === "same"
					? "source" in sample
						? [[sample.file || "../samples/api.ts", `${monadModule}\n${sample.source}`] as const]
						: []
					: [
							...(multipleFilesMode === "different" ? [["../samples/api.ts", monadModule] as const] : []),
							...("source" in sample
								? [{ file: sample.file || "../samples/file.ts", source: sample.source }]
								: sample.modules
							).map(({ file, source }) => [file, `${fileModule}\n${source}`] as const),
						],
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

				// const { files, violations } = getScenarioViolations(sample.source, multipleFilesMode)
				if (sample.name.startsWith("ok:")) {
					assert.ok(violations.length === 0, formatViolations(files, violations).join("\n\n"))
				} else {
					assert.ok(violations.length > 0, "Expected at least one violation")
				}
			})
		}
	}
})
