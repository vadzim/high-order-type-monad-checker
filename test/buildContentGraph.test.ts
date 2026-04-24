import assert from "node:assert/strict"
import test from "node:test"
import { buildContentGraph, type CGCall, type ContentGraph } from "../src/buildContentGraph.ts"
// import { inspect } from "../src/utils.ts"

test("buildContentTreeFromSource: declared types use self refs and alias returns", () => {
	const graph = validateContracts(
		buildContentGraph(
			"/tmp/file.ts",
			"import C from './c.ts'; type B = A; type A<Y extends number = 1> = Y extends [infer X, infer Z extends string] ? [C, X, X] : string;",
		),
	)

	// console.log(inspect(graph, { colors: true }))
	// console.log(inspect({ ...graph, scopes: [...graph.scopes], calls: undefined, refs: undefined }, { colors: true }))
	// function getDecls(scope: CGScope | null | undefined): string[][] {
	// 	if (!scope) return []
	// 	return [[...scope.types.values().map(t => t.name)], ...getDecls(scope.parent)]
	// }
	// console.log(inspect(getDecls(graph.scopes.values().find(s => s.kind === "branchTrue")), { colors: true }))
	// console.log(inspect(getDecls(graph.scopes.values().find(s => s.kind === "branchFalse")), { colors: true }))

	assert.equal(1, [...graph.types].filter(t => t.name === "X").length)
	assert.equal(1, [...graph.refs].filter(t => t.name === "X").length)
	assert.equal(1, [...graph.types].filter(t => t.name === "Y").length)
	assert.equal(1, [...graph.refs].filter(t => t.name === "Y").length)
	assert.equal(1, [...graph.types].filter(t => t.name === "A").length)
	assert.equal(1, [...graph.refs].filter(t => t.name === "A").length)
	assert.equal(1, [...graph.types].filter(t => t.name === "B").length)
	assert.equal(1, [...graph.refs].filter(t => t.name === "B").length)
	assert.equal(1, [...graph.types].filter(t => t.name === "C").length)
	assert.equal(1, [...graph.refs].filter(t => t.name === "C").length)

	const aType = graph.types.values().find(t => t.name === "A" && t.scope.path === "/tmp/file.ts")
	const bType = graph.types.values().find(t => t.name === "B" && t.scope.path === "/tmp/file.ts")
	const xType = graph.types.values().find(t => t.name === "X")
	const yType = graph.types.values().find(t => t.name === "Y")
	const cType = graph.types.values().find(t => t.name === "C")
	assert.ok(aType)
	assert.ok(bType)
	assert.ok(xType)
	assert.ok(yType)
	assert.ok(cType)

	assert.ok(aType.body)
	assert.ok(bType.body)
	assert.ok(aType.declaration)
	assert.ok(bType.declaration)
	assert.ok(xType.body)
	assert.ok(yType.body)
	assert.ok(!cType.body)

	assert.equal(aType.refs.size, 1)
	assert.equal(bType.refs.size, 1)
	assert.equal(xType.refs.size, 1)
	assert.equal(yType.refs.size, 1)
	assert.equal(cType.refs.size, 1)

	assert.equal(aType.called.size, 2)
	assert.equal(bType.called.size, 1)
	assert.equal(xType.called.size, 3)
	assert.equal(yType.called.size, 2)
	assert.equal(cType.called.size, 1)

	assert.equal(aType.body!.type.name, "<conditional>")
	assert.equal(bType.body!.type.name, "A")
	assert.equal(aType.declaration!.type.name, "A")
	assert.equal(aType.declaration!.arguments.length, 0)
	assert.equal(aType.declaration!.parent?.type.name, "<typeDeclaration>")
	assert.equal(aType.declaration!.parent?.arguments[0], aType.declaration)
	assert.equal(bType.declaration!.type.name, "B")
	assert.equal(xType.body!.type.name, "unknown")
	assert.equal(yType.body!.type.name, "<1>")

	const bDeclRef = [...bType!.scope.types].find(r => r.ref === bType)
	assert.ok(bDeclRef)
	assert.equal(bDeclRef!.name, "B")

	const aDeclRef = [...aType!.scope.types].find(r => r.ref === aType)
	assert.ok(aDeclRef)
	const globalScope = [...graph.scopes].find(s => s.kind === "global")
	assert.ok(globalScope)
	assert.equal(globalScope!.path, "<global>")
	assert.deepEqual(globalScope!.position, { start: 0, end: 0 })
	const cCall = [...graph.calls].find(c => c.type.name === "C")
	assert.ok(cCall)
	assert.equal(cCall!.type.ref.scope.kind, "file")
	assert.equal(cCall!.type.ref.scope.path, "/tmp/c.ts")
	assert.deepEqual(cCall!.type.position, { start: 7, end: 8 })
	assert.deepEqual(cCall!.type.ref.position, { start: 0, end: 0 })
	assert.deepEqual(cCall!.type.ref.scope.position, { start: 0, end: 0 })
	assert.equal(
		[...bType!.returns].some(
			r => r.name === aDeclRef!.name && r.ref === aDeclRef!.ref && r.scope === aDeclRef!.scope,
		),
		true,
	)
	assert.equal(
		[...aType!.returnedBy].some(r => r.name === bDeclRef!.name),
		true,
	)
	assert.equal(
		[...graph.types].some(t => t.name === "X" && t.scope.kind === "global"),
		false,
	)
})

test("buildContentTreeFromSource: imported type is local ref to placeholder CTType", () => {
	const graph = validateContracts(
		buildContentGraph("/tmp/file.ts", 'import type { X as LocalX } from "./x"; type Y = LocalX;'),
	)

	const yType = [...graph.types].find(t => t.name === "Y" && t.scope.path === "/tmp/file.ts")
	assert.ok(yType)

	const localImportRef = [...yType!.returns.values()].find(r => r.name === "LocalX")
	assert.ok(localImportRef)
	assert.equal(localImportRef!.scope.path, "/tmp/file.ts")
	assert.equal(localImportRef!.ref.name, "X")
	assert.equal(localImportRef!.ref.scope.path, "/tmp/x")
	assert.equal(localImportRef!.ref.kind, "typeAlias")
})

test("buildContentTreeFromSource: throws fast on duplicate imported local names", () => {
	assert.throws(
		() =>
			buildContentGraph("/tmp/file.ts", "import type { A as X } from './a'; import type { B as X } from './b';"),
		/Duplicate type name 'X'/,
	)
})

test("buildContentTreeFromSource: throws fast on duplicate declarations in the same scope", () => {
	assert.throws(
		() => buildContentGraph("/tmp/file.ts", "type A = string; type A = number;"),
		/Duplicate type name 'A'/,
	)
})

test("buildContentTreeFromSource: returns capture referenced types from body calls", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type A = string; type B<T> = A | T;"))

	const bType = [...graph.types].find(t => t.name === "B" && t.scope.path === "/tmp/file.ts")
	assert.ok(bType)
	const returnNames = new Set([...bType!.returns].map(r => r.name))
	assert.equal(returnNames.has("A"), true)
	assert.equal(returnNames.has("T"), true)
})

test("buildContentTreeFromSource: tuple builtin is represented as global pseudo type", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type X = [string, number];"))
	const tupleCall = [...graph.calls].find(c => c.type.name === "<tuple>" && c.scope.path === "/tmp/file.ts")
	assert.ok(tupleCall)
	assert.equal(tupleCall!.type.ref.scope.kind, "global")
	assert.equal(tupleCall!.type.ref.scope.path, "<global>")
})

test("buildContentTreeFromSource: readonly tuple is represented as readonly pseudo type", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type X = readonly [string, number];"))
	const readonlyTupleCall = [...graph.calls].find(
		c => c.type.name === "<readonlyTuple>" && c.scope.path === "/tmp/file.ts",
	)
	assert.ok(readonlyTupleCall)
	assert.equal(readonlyTupleCall!.type.ref.scope.kind, "global")
	assert.equal(readonlyTupleCall!.type.ref.scope.path, "<global>")
	assert.equal(
		[...graph.calls].some(c => c.type.name === "<typeOperator>" && c.scope.path === "/tmp/file.ts"),
		false,
	)
})

test("buildContentTreeFromSource: readonly array is represented as readonly pseudo type", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type X = readonly string[];"))
	const readonlyArrayCall = [...graph.calls].find(
		c => c.type.name === "<readonlyArray>" && c.scope.path === "/tmp/file.ts",
	)
	assert.ok(readonlyArrayCall)
	assert.equal(readonlyArrayCall!.type.ref.scope.kind, "global")
	assert.equal(readonlyArrayCall!.type.ref.scope.path, "<global>")
	assert.equal(
		[...graph.calls].some(c => c.type.name === "<typeOperator>" && c.scope.path === "/tmp/file.ts"),
		false,
	)
})

test("buildContentTreeFromSource: builtins and unresolved types are represented in global scope", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type A = Missing | string | [number];"))
	const aType = [...graph.types].find(t => t.name === "A" && t.scope.path === "/tmp/file.ts")
	assert.ok(aType)

	const globalScope = [...graph.scopes].find(s => s.kind === "global")
	assert.ok(globalScope)

	const missingRef = [...aType!.returns].find(r => r.name === "Missing")
	assert.ok(missingRef)
	assert.equal(missingRef!.ref.scope.kind, "global")
	assert.equal(missingRef!.ref.scope.path, "<global>")

	const stringRef = [...aType!.returns].find(r => r.name === "string")
	assert.ok(stringRef)
	assert.equal(stringRef!.ref.scope.kind, "global")

	const tupleRef = [...aType!.returns].find(r => r.name === "<tuple>")
	assert.ok(tupleRef)
	assert.equal(tupleRef!.ref.scope.kind, "global")

	const calledNames = new Set([...graph.calls].map(c => c.type.name))
	assert.equal(calledNames.has("Missing"), true)
	assert.equal(calledNames.has("string"), true)
	assert.equal(calledNames.has("<tuple>"), true)
})

test("buildContentTreeFromSource: graph.refs aggregates graph refs", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type A = string; type B<T> = A | T;"))
	assert.ok(graph.refs.size > 0)
	const names = new Set([...graph.refs].map(r => r.name))
	assert.equal(names.has("A"), true)
	assert.equal(names.has("B"), true)
	assert.equal(names.has("T"), true)
	assert.equal(names.has("string"), true)
})

test("buildContentTreeFromSource: refs are declaration refs (not usage sites)", () => {
	const graph = validateContracts(
		buildContentGraph("/tmp/file.ts", "import { X as LocalX } from './x'; type A = LocalX;"),
	)
	const declaredRefs = new Set<unknown>()
	for (const scope of graph.scopes) for (const ref of scope.types) declaredRefs.add(ref)
	for (const ref of graph.refs) {
		assert.equal(declaredRefs.has(ref), true, "graph.refs must only contain declaration refs from scope.types")
	}

	const importRef = [...graph.refs].find(r => r.name === "LocalX")
	assert.ok(importRef)
	assert.equal(importRef!.name, "LocalX")
	assert.equal(importRef!.ref.name, "X")
})

test("buildContentTreeFromSource: conditional and extends pseudo calls are emitted", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", 'type A = 1 extends 2 ? "abc" : string;'))
	const extendsCall = [...graph.calls].find(c => c.type.name === "<extends>")
	const conditionalCall = [...graph.calls].find(c => c.type.name === "<conditional>")
	assert.ok(extendsCall)
	assert.ok(conditionalCall)
	assert.equal(extendsCall!.arguments.length, 2)
	assert.equal(conditionalCall!.arguments.length, 3)
	assert.equal(extendsCall!.scope.kind, "conditional")
	assert.equal(conditionalCall!.arguments[2]?.scope.kind, "branchFalse")
	const pseudoNames = new Set([...graph.calls].map(c => c.type.name))
	assert.equal(pseudoNames.has("<1>"), true)
	assert.equal(pseudoNames.has("<2>"), true)
	assert.equal(pseudoNames.has('<"abc">'), true)
})

test("buildContentTreeFromSource: object and pair pseudo calls are emitted", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type X = { a: string; b: [number, boolean] };"))
	const objectCall = [...graph.calls].find(c => c.type.name === "<object>")
	const pairCalls = [...graph.calls].filter(c => c.type.name === "<pair>")
	assert.ok(objectCall)
	assert.equal(pairCalls.length >= 2, true)
	const pseudoNames = new Set([...graph.calls].map(c => c.type.name))
	assert.equal(pseudoNames.has('<"a">'), true)
	assert.equal(pseudoNames.has('<"b">'), true)
	assert.equal(pseudoNames.has("<tuple>"), true)
	assert.equal(pseudoNames.has("<array>"), false)
})

test("buildContentTreeFromSource: readonly object property uses readonly pair pseudo", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type X = { readonly a: string; b: number };"))
	const readonlyPairCalls = [...graph.calls].filter(c => c.type.name === "<readonlyPair>")
	const pairCalls = [...graph.calls].filter(c => c.type.name === "<pair>")
	assert.equal(readonlyPairCalls.length, 1)
	assert.equal(pairCalls.length, 1)
	assert.equal(readonlyPairCalls[0]!.arguments[0]!.type.name, '<"a">')
	assert.equal(pairCalls[0]!.arguments[0]!.type.name, '<"b">')
})

test("buildContentTreeFromSource: interface and class heritage types are preserved", () => {
	const graph = validateContracts(
		buildContentGraph(
			"/tmp/file.ts",
			"type A = string; interface I<T> extends A { x: T } class C<U> extends A { y: U }",
		),
	)
	const iType = [...graph.types].find(t => t.name === "I" && t.scope.path === "/tmp/file.ts")
	const cType = [...graph.types].find(t => t.name === "C" && t.scope.path === "/tmp/file.ts")
	assert.ok(iType)
	assert.ok(cType)
	assert.ok(iType!.body)
	assert.ok(cType!.body)
	assert.equal(
		[...iType!.returns].some(ref => ref.name === "A"),
		true,
	)
	assert.equal(
		[...cType!.returns].some(ref => ref.name === "A"),
		true,
	)
	const iDecl = [...graph.calls].find(
		c =>
			c.type.name === "<declaration>" &&
			c.scope.path === "/tmp/file.ts" &&
			c.arguments.some(arg => arg.type.name === "A"),
	)
	assert.ok(iDecl)
})

test("buildContentTreeFromSource: type alias declaration root carries self ref, body, and generic constraints", () => {
	const graph = validateContracts(
		buildContentGraph("/tmp/file.ts", "type X<T extends string> = { a: string; b: [number] } | (boolean);"),
	)
	const declCall = [...graph.calls].find(
		c =>
			c.type.name === "<typeDeclaration>" && c.scope.path === "/tmp/file.ts" && c.arguments[0]?.type.name === "X",
	)
	assert.ok(declCall)
	assert.equal(declCall!.arguments.length, 3)
	assert.equal(declCall!.arguments[0]!.arguments.length, 0)
	assert.equal(declCall!.arguments[1]!.type.name, "<union>")
	assert.equal(declCall!.arguments[2]!.type.name, "<extends>")
	assert.equal(declCall!.arguments[2]!.arguments[0]!.type.name, "<typeDeclaration>")
	assert.equal(declCall!.arguments[2]!.arguments[1]!.type.name, "string")
})

test("buildContentTreeFromSource: forward file-local refs resolve after declaration pass", () => {
	const graph = validateContracts(
		buildContentGraph(
			"/tmp/file.ts",
			"import C from './c.ts'; type B = A; type A<Y> = Y extends [infer X] ? [C, X] : string;",
		),
	)
	const aType = [...graph.types].find(t => t.name === "A" && t.scope.path === "/tmp/file.ts")
	const bType = [...graph.types].find(t => t.name === "B" && t.scope.path === "/tmp/file.ts")
	assert.ok(aType)
	assert.ok(bType)
	assert.ok(bType!.body)
	assert.equal(bType!.body!.type.ref, aType)
	assert.equal(bType!.body!.type.name, "A")
	assert.equal(bType!.body!.type.ref.scope.kind, "file")
})

test("buildContentTreeFromSource: unconstrained type and infer params normalize to extends unknown", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type A<B> = B extends [infer C] ? C : never;"))
	const aType = [...graph.types].find(t => t.name === "A" && t.scope.path === "/tmp/file.ts")
	assert.ok(aType)
	assert.equal(aType!.arguments.length, 1)

	const typeArgument = aType!.arguments[0]
	assert.ok(typeArgument)
	assert.ok(typeArgument!.extends)
	assert.equal(typeArgument!.extends!.type.name, "unknown")
	assert.equal(typeArgument!.variable.ref.declaration?.parent?.parent?.type.name, "<extends>")
	assert.equal(typeArgument!.variable.ref.declaration?.parent?.parent?.arguments[0]!.type.name, "<typeDeclaration>")
	assert.equal(typeArgument!.variable.ref.declaration?.parent?.parent?.arguments[0]!.arguments.length, 2)
	assert.equal(typeArgument!.variable.ref.declaration?.parent?.parent?.arguments[0]!.arguments[0]!.type.name, "B")
	assert.equal(
		typeArgument!.variable.ref.declaration?.parent?.parent?.arguments[0]!.arguments[1]!.type.name,
		"unknown",
	)
	assert.equal(
		typeArgument!.variable.ref.declaration,
		typeArgument!.variable.ref.declaration?.parent?.parent?.arguments[0]!.arguments[0],
	)
	assert.equal(typeArgument!.variable.ref.declaration?.parent?.parent?.arguments[1], typeArgument!.extends)

	const inferExtendsCall = [...graph.calls].find(
		call =>
			call.type.name === "<extends>" &&
			call.arguments[0]?.type.name === "<typeDeclaration>" &&
			call.arguments[0]?.arguments[0]?.type.name === "C",
	)
	assert.ok(inferExtendsCall)
	assert.equal(inferExtendsCall!.arguments.length, 2)
	assert.equal(inferExtendsCall!.arguments[0]!.arguments.length, 2)
	assert.equal(inferExtendsCall!.arguments[0]!.arguments[1]!.type.name, "unknown")
	assert.equal(inferExtendsCall!.arguments[1]!.type.name, "unknown")
})

test("buildContentTreeFromSource: self recursion points to a shared one-item recursion set", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type A<T> = A<T>;"))
	const aType = [...graph.types].find(type => type.name === "A" && type.scope.path === "/tmp/file.ts")
	assert.ok(aType)
	assert.ok(aType!.recursion)
	assert.equal(aType!.recursion!.size, 1)
	assert.equal(aType!.recursion!.has(aType!), true)
})

test("buildContentTreeFromSource: mutual recursion shares the same recursion set object", () => {
	const graph = validateContracts(buildContentGraph("/tmp/file.ts", "type A = B; type B = A; type C = string;"))
	const aType = [...graph.types].find(type => type.name === "A" && type.scope.path === "/tmp/file.ts")
	const bType = [...graph.types].find(type => type.name === "B" && type.scope.path === "/tmp/file.ts")
	const cType = [...graph.types].find(type => type.name === "C" && type.scope.path === "/tmp/file.ts")
	assert.ok(aType)
	assert.ok(bType)
	assert.ok(cType)
	assert.ok(aType!.recursion)
	assert.ok(bType!.recursion)
	assert.equal(aType!.recursion, bType!.recursion)
	assert.equal(aType!.recursion!.size, 2)
	assert.equal(aType!.recursion!.has(aType!), true)
	assert.equal(aType!.recursion!.has(bType!), true)
	assert.equal(cType!.recursion, undefined)
})

export function validateContracts(graph: ContentGraph) {
	assert.deepEqual(new Set(graph.refs.values().map(r => r.ref)), graph.types)
	assert.deepEqual(new Set(graph.types.values().flatMap(r => r.refs)), graph.refs)

	for (const [ref, refs] of Map.groupBy(graph.refs, t => t.ref)) {
		assert.deepEqual({ refsSize: refs.length }, { refsSize: ref.refs.size })
	}

	const x1 = graph.types
		.values()
		.flatMap(t => t.returnedBy.values().map(x => [t, x.ref] as const))
		.toArray()
	const x2 = graph.types
		.values()
		.flatMap(t => t.returns.values().map(x => [x.ref, t] as const))
		.toArray()

	assert.equal(x1.length, x2.length)
	for (const t1 of x1) assert.ok(x2.find(t2 => t2[0] === t1[0] && t2[1] === t1[1]))
	for (const t2 of x2) assert.ok(x1.find(t1 => t1[0] === t2[0] && t1[1] === t2[1]))

	for (const call of graph.calls) {
		for (const arg of call.arguments) {
			assert.ok(arg.parent === call)
		}
		assert.ok(call.parent?.arguments.includes(call) ?? true)
	}

	for (const type of graph.types) {
		if (type.declaration) {
			assert.equal(type.declaration?.arguments.length, 0)
			assert.ok(type.declaration.parent)
			assert.equal(type.declaration.parent!.type.name, "<typeDeclaration>")
			assert.ok(type.declaration.parent!.arguments[0] === type.declaration)
			assert.ok(type.declaration.parent!.arguments[1] === type.body)
			if (type.kind === "typeAlias") {
				for (const [index, arg] of type.arguments.entries()) {
					assert.ok(arg.extends)
					assert.ok(arg.extends === type.declaration.parent!.arguments[2 + index].arguments[1])
					assert.ok(
						arg.variable === type.declaration.parent!.arguments[2 + index].arguments[0].arguments[0].type,
					)
					assert.ok(arg.default === type.declaration.parent!.arguments[2 + index].arguments[0].arguments[1])
				}
			}
		}
		if (!type.declaration && type.body) {
			assert.ok(type.kind === "interface" || type.kind === "class")
		}
	}

	const declarationCalls = new Set(
		graph.calls
			.values()
			.filter(call => call.parent == null)
			.flatMap(walkCalls),
	)

	const typesCalled = new Set(graph.types.values().flatMap(t => t.called))

	assert.ok(typesCalled.isSubsetOf(declarationCalls))

	return graph
}

function* walkCalls(call: CGCall | null | undefined): Generator<CGCall> {
	if (!call) return
	yield call
	for (const arg of call.arguments) {
		yield* walkCalls(arg)
	}
}
