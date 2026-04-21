import assert from "node:assert/strict"
import test from "node:test"
import { buildContentGraph } from "../src/buildContentGraph.ts"
import { concatContentGraphs } from "../src/concatContentGraphs.ts"
import { validateContracts } from "./buildContentGraph.test.ts"

test("concatContentGraphs: handles empty input", () => {
	const merged = validateContracts(concatContentGraphs([]))
	assert.equal(merged.types.size, 0)
	assert.equal(merged.refs.size, 0)
	assert.equal(merged.scopes.size, 0)
	assert.equal(merged.calls.size, 0)
})

test("concatContentGraphs: merges into one global scope", () => {
	const graph1 = buildContentGraph("/tmp/a.ts", "type A = string;")
	const graph2 = buildContentGraph("/tmp/b.ts", "type B = number;")
	const merged = validateContracts(concatContentGraphs([graph1, graph2]))

	const globalScopes = [...merged.scopes].filter(scope => scope.kind === "global")
	assert.equal(globalScopes.length, 1)
	assert.equal(globalScopes[0]!.path, "<global>")

	const globalScope = globalScopes[0]!
	for (const scope of merged.scopes) {
		if (scope.kind === "file" && scope.path !== "/tmp/a.ts" && scope.path !== "/tmp/b.ts") continue
		if (scope.kind !== "file") continue
		assert.equal(scope.parent, globalScope)
	}
})

test("concatContentGraphs: rewires imported stubs to concrete source type", () => {
	const consumerGraph = buildContentGraph("/tmp/file.ts", "import type { X as LocalX } from './x'; type Y = LocalX;")
	const sourceGraph = buildContentGraph("/tmp/x", "export type X = string;")
	const merged = validateContracts(concatContentGraphs([consumerGraph, sourceGraph]))

	const yType = [...merged.types].find(type => type.name === "Y" && type.scope.path === "/tmp/file.ts")
	assert.ok(yType)
	const localXRef = [...yType!.returns].find(ref => ref.name === "LocalX")
	assert.ok(localXRef)
	assert.equal(localXRef!.ref.name, "X")
	assert.equal(localXRef!.ref.scope.path, "/tmp/x")
	assert.equal(localXRef!.ref.scope.parent?.kind, "global")
	assert.equal(localXRef!.ref.scope.parent?.path, "<global>")

	const xStubs = [...merged.types].filter(
		type => type.name === "X" && type.scope.path === "/tmp/x" && type.scope.parent === null,
	)
	assert.equal(xStubs.length, 0)

	const sourceX = [...merged.types].find(
		type => type.name === "X" && type.scope.path === "/tmp/x" && type.scope.parent !== null,
	)
	assert.ok(sourceX)
	assert.equal(
		[...sourceX!.returnedBy].some(ref => ref.ref === yType),
		true,
	)
	assert.equal(
		[...sourceX!.called].some(call => call.type.name === "LocalX"),
		true,
	)
})

test("concatContentGraphs: does not mutate source graphs", () => {
	const consumerGraph = buildContentGraph("/tmp/file.ts", "import type { X as LocalX } from './x'; type Y = LocalX;")
	const sourceGraph = buildContentGraph("/tmp/x", "export type X = string;")

	const consumerStubBefore = [...consumerGraph.types].find(type => type.name === "X" && type.scope.path === "/tmp/x")
	assert.ok(consumerStubBefore)
	assert.equal(consumerStubBefore!.scope.parent, null)

	const merged = validateContracts(concatContentGraphs([consumerGraph, sourceGraph]))
	assert.ok(merged)

	const consumerStubAfter = [...consumerGraph.types].find(type => type.name === "X" && type.scope.path === "/tmp/x")
	assert.ok(consumerStubAfter)
	assert.equal(consumerStubAfter, consumerStubBefore)
	assert.equal(consumerStubAfter!.scope.parent, null)
})

test("concatContentGraphs: keeps one merged stub when source is missing", () => {
	const graph1 = buildContentGraph("/tmp/a.ts", "import type { X as ALocalX } from './x'; type A = ALocalX;")
	const graph2 = buildContentGraph("/tmp/b.ts", "import type { X as BLocalX } from './x'; type B = BLocalX;")
	const merged = validateContracts(concatContentGraphs([graph1, graph2]))

	const xTypes = [...merged.types].filter(type => type.name === "X" && type.scope.path === "/tmp/x")
	assert.equal(xTypes.length, 1)
	assert.equal(xTypes[0]!.scope.parent, null)

	const aType = [...merged.types].find(type => type.name === "A" && type.scope.path === "/tmp/a.ts")
	const bType = [...merged.types].find(type => type.name === "B" && type.scope.path === "/tmp/b.ts")
	assert.ok(aType)
	assert.ok(bType)

	const aRef = [...aType!.returns].find(ref => ref.name === "ALocalX")
	const bRef = [...bType!.returns].find(ref => ref.name === "BLocalX")
	assert.ok(aRef)
	assert.ok(bRef)
	assert.equal(aRef!.ref, xTypes[0])
	assert.equal(bRef!.ref, xTypes[0])
})

test("concatContentGraphs: dedupes identical missing imports across many graphs", () => {
	const g1 = buildContentGraph("/tmp/a.ts", "import type { X as ALocalX } from './x'; type A = ALocalX;")
	const g2 = buildContentGraph("/tmp/b.ts", "import type { X as BLocalX } from './x'; type B = BLocalX;")
	const g3 = buildContentGraph("/tmp/c.ts", "import type { X as CLocalX } from './x'; type C = CLocalX;")
	const merged = validateContracts(concatContentGraphs([g1, g2, g3]))

	const xTypes = [...merged.types].filter(type => type.name === "X" && type.scope.path === "/tmp/x")
	assert.equal(xTypes.length, 1)
	const x = xTypes[0]!

	for (const [typeName, localName, path] of [
		["A", "ALocalX", "/tmp/a.ts"],
		["B", "BLocalX", "/tmp/b.ts"],
		["C", "CLocalX", "/tmp/c.ts"],
	] as const) {
		const t = [...merged.types].find(type => type.name === typeName && type.scope.path === path)
		assert.ok(t)
		const ref = [...t!.returns].find(r => r.name === localName)
		assert.ok(ref)
		assert.equal(ref!.ref, x)
	}
})

test("concatContentGraphs: preserves type parameter metadata when target is rewritten", () => {
	const consumerGraph = buildContentGraph(
		"/tmp/file.ts",
		"import type { X } from './x'; type Y<T extends X = X> = T;",
	)
	const sourceGraph = buildContentGraph("/tmp/x", "export type X = string;")
	const merged = validateContracts(concatContentGraphs([consumerGraph, sourceGraph]))

	const yType = [...merged.types].find(type => type.name === "Y" && type.scope.path === "/tmp/file.ts")
	assert.ok(yType)
	assert.equal(yType!.arguments.length, 1)
	assert.ok(yType!.arguments[0]!.extends)
	assert.ok(yType!.arguments[0]!.default)
	assert.equal(yType!.arguments[0]!.extends!.type.ref.scope.path, "/tmp/x")
	assert.equal(yType!.arguments[0]!.default!.type.ref.scope.path, "/tmp/x")
	assert.equal(yType!.arguments[0]!.extends!.type.ref.scope.parent?.kind, "global")
})
