import test from "node:test"
import assert from "node:assert/strict"
import { parseTypes, type ParseTypesResult, type TypeCall } from "../src/parseContent.ts"

const typeList = (result: ParseTypesResult) => [...result.types.values()]
const scopeList = (result: ParseTypesResult) => [...result.scopes.values()]

function isCallNode(c: TypeCall): c is Extract<TypeCall, { kind: "call" }> {
	return c.kind === "call"
}

function assertCallTree(c: TypeCall): void {
	if (c.kind === "scope") return
	assert.ok(Array.isArray(c.arguments))
	for (const a of c.arguments) assertCallTree(a)
}

const parserCases = [
	{
		name: "single type alias",
		source: `type A = string;`,
		verify: (result: ParseTypesResult) => {
			const types = typeList(result)
			const scopes = scopeList(result)
			assert.equal(
				types.some(t => t.name === "A" && t.kind === "typeAlias"),
				true,
			)
			assert.equal(
				scopes.some(s => s.kind === "file"),
				true,
			)
		},
	},
	{
		name: "imported type has resolved refPath",
		source: `import type { A } from "./x"; type B = A;`,
		verify: (result: ParseTypesResult) => {
			const imported = typeList(result).find(t => t.kind === "imported" && t.name === "A")
			assert.ok(imported)
			assert.match(imported!.refPath, /x$/)
		},
	},
	{
		name: "type parameter scope exists",
		source: `type A<T> = T;`,
		verify: (result: ParseTypesResult) => {
			const scopes = scopeList(result)
			const types = typeList(result)
			assert.equal(
				scopes.some(s => s.kind === "typeParameters"),
				true,
			)
			assert.equal(
				types.some(t => t.kind === "typeParameter" && t.name === "T"),
				true,
			)
		},
	},
	{
		name: "type parameter extends is parsed for identifier constraint",
		source: `type A<B extends C> = B; type C = string;`,
		verify: (result: ParseTypesResult) => {
			const types = typeList(result)
			const b = types.find(t => t.kind === "typeParameter" && t.name === "B")
			const c = types.find(t => t.name === "C")
			assert.ok(b)
			assert.ok(c)
		},
	},
	{
		name: "infer extends is parsed for identifier constraint only",
		source: `type A<B extends C> = B extends infer D extends E ? D : K extends infer I extends [number] ? I : never; type C = string; type E = string; type K = string;`,
		verify: (result: ParseTypesResult) => {
			const types = typeList(result)
			const d = types.find(t => t.kind === "infer" && t.name === "D")
			const i = types.find(t => t.kind === "infer" && t.name === "I")
			const e = types.find(t => t.name === "E")
			assert.ok(d)
			assert.ok(i)
			assert.ok(e)
		},
	},
	{
		name: "conditional scope stores check and extends call roots",
		source: `type A<T> = T extends string ? 1 : 2;`,
		verify: (result: ParseTypesResult) => {
			const cond = scopeList(result).find(s => s.kind === "conditional")
			assert.ok(cond)
			assert.equal(cond!.calls.length, 2)
			for (const c of cond!.calls) assertCallTree(c)
		},
	},
	{
		name: "scope calls include resolved and complex arguments",
		source: `type B = string; type C = number; type T = boolean; type A<X, Y> = [X, Y]; type D<Z> = Z; type X = A<B, C> | D<[T]>;`,
		verify: (result: ParseTypesResult) => {
			const types = typeList(result)
			const a = types.find(t => t.kind === "typeAlias" && t.name === "A")
			const b = types.find(t => t.kind === "typeAlias" && t.name === "B")
			const c = types.find(t => t.kind === "typeAlias" && t.name === "C")
			const d = types.find(t => t.kind === "typeAlias" && t.name === "D")
			const tAlias = types.find(t => t.kind === "typeAlias" && t.name === "T")
			assert.ok(a)
			assert.ok(b)
			assert.ok(c)
			assert.ok(d)
			assert.ok(tAlias)
			const calls = scopeList(result).flatMap(s => s.calls)
			const unionCall = calls.find(
				(c): c is Extract<TypeCall, { kind: "call" }> =>
					c.kind === "call" &&
					c.typeId === "[union]" &&
					c.arguments.length === 2 &&
					c.arguments[0]!.kind === "call" &&
					c.arguments[0].typeId === a!.id,
			)
			assert.ok(unionCall, "expected one root [union] for A<B,C> | D<[T]>")
			const aCall = unionCall!.arguments[0]!
			const dCall = unionCall!.arguments[1]!
			assert.ok(isCallNode(aCall) && isCallNode(dCall))
			assert.equal(dCall.typeId, d!.id)
			assert.equal(aCall.arguments.length, 2)
			const a0 = aCall.arguments[0]
			const a1 = aCall.arguments[1]
			assert.ok(isCallNode(a0))
			assert.ok(isCallNode(a1))
			assert.equal(a0.typeId, b!.id)
			assert.equal(a1.typeId, c!.id)
			assert.equal(dCall.arguments.length, 1)
			const tupleArg = dCall.arguments[0]!
			assert.ok(isCallNode(tupleArg))
			assert.equal(tupleArg.typeId, "[tuple]")
			assert.equal(tupleArg.arguments.length, 1)
			const innerT = tupleArg.arguments[0]
			assert.ok(isCallNode(innerT))
			assert.equal(innerT.typeId, tAlias!.id)
		},
	},
	{
		name: "unresolved module-external types use global ids",
		source: `type X<T extends string> = Promise<number>;`,
		verify: (result: ParseTypesResult) => {
			const t = typeList(result).find(x => x.kind === "typeParameter" && x.name === "T")
			assert.ok(t)
			const calls = scopeList(result).flatMap(s => s.calls)
			const promiseCall = calls.find(
				(c): c is Extract<TypeCall, { kind: "call" }> => c.kind === "call" && c.typeId === "global:Promise",
			)
			assert.ok(promiseCall)
			const promArg0 = promiseCall.arguments[0]
			assert.ok(isCallNode(promArg0))
			assert.equal(promArg0.typeId, "global:number")
		},
	},
	{
		name: "parsed type arguments include declaration type parameter ids",
		source: `type D = string; type C<A, B extends D> = [A, B];`,
		verify: (result: ParseTypesResult) => {
			const types = typeList(result)
			const x = types.find(t => t.kind === "typeAlias" && t.name === "C")
			const a = types.find(t => t.kind === "typeParameter" && t.name === "A")
			const b = types.find(t => t.kind === "typeParameter" && t.name === "B")
			assert.ok(x)
			assert.ok(a)
			assert.ok(b)
			assert.equal(x!.arguments?.length, 2)
			assert.equal(x!.arguments?.[0]?.typeId, a!.id)
			assert.equal(x!.arguments?.[1]?.typeId, b!.id)
		},
	},
	{
		name: "infer creates scope and inferred type",
		source: `type A<X> = X extends infer T extends O ? T : never; type O = {__monad:"O"};`,
		verify: (result: ParseTypesResult) => {
			const scopes = scopeList(result)
			const types = typeList(result)
			assert.equal(
				scopes.some(s => s.kind === "infer"),
				true,
			)
			assert.equal(
				types.some(t => t.kind === "infer" && t.name === "T"),
				true,
			)
		},
	},
	{
		name: "infer creates scope and inferred type",
		source: `type A<X> = \`asd\${3}\${P<A,B,X>}xxx\`;`,
		verify: (result: ParseTypesResult) => {
			// console.log(inspect(result, { depth: null, colors: true }))
		},
	},
	{
		name: "conditional creates branch scopes",
		source: `type A<T> = T extends string ? 1 : 2;`,
		verify: (result: ParseTypesResult) => {
			const scopes = scopeList(result)
			assert.equal(
				scopes.some(s => s.kind === "branchTrue"),
				true,
			)
			assert.equal(
				scopes.some(s => s.kind === "branchFalse"),
				true,
			)
			const calls = scopeList(result).flatMap(s => s.calls)
			const cond = calls.find(
				(c): c is Extract<TypeCall, { kind: "call" }> => c.kind === "call" && c.typeId === "[conditional]",
			)
			assert.ok(cond)
			assert.equal(cond.arguments.length, 3)
			const [s0, s1, s2] = cond.arguments
			assert.equal(s0?.kind, "scope")
			assert.equal(s1?.kind, "scope")
			assert.equal(s2?.kind, "scope")
			assert.ok(s0?.kind === "scope" && s1?.kind === "scope" && s2?.kind === "scope", "expected scope refs")
			const byId = new Map(scopes.map(s => [s.id, s]))
			assert.equal(byId.get(s0.scopeId)?.kind, "conditional")
			assert.equal(byId.get(s1.scopeId)?.kind, "branchTrue")
			assert.equal(byId.get(s2.scopeId)?.kind, "branchFalse")
		},
	},
	{
		name: "positions are populated",
		source: `type PositionType = string;`,
		verify: (result: ParseTypesResult) => {
			const decl = typeList(result).find(t => t.name === "PositionType")
			assert.ok(decl)
			assert.ok(decl!.position.start >= 0)
			assert.ok(decl!.position.end >= decl!.position.start)
		},
	},
	{
		name: "duplicate type parameter names in nested scopes",
		source: `type A<T extends O> = T extends infer T extends O ? T : never; type O = {__monad:"O"};`,
		verify: (result: ParseTypesResult) => {
			const params = typeList(result).filter(
				t => t.name === "T" && (t.kind === "typeParameter" || t.kind === "infer"),
			)
			assert.ok(params.length >= 2)
			assert.notEqual(params[0].scopeId, params[1].scopeId)
		},
	},
	{
		name: "mixed declarations captured",
		source: `type A = string; interface B {}; class C<T extends O> {}; type O = {__monad:"O"};`,
		verify: (result: ParseTypesResult) => {
			const types = typeList(result)
			assert.equal(
				types.some(t => t.kind === "typeAlias" && t.name === "A"),
				true,
			)
			assert.equal(
				types.some(t => t.kind === "interface" && t.name === "B"),
				true,
			)
			assert.equal(
				types.some(t => t.kind === "class" && t.name === "C"),
				true,
			)
		},
	},
	{
		name: "parseTypes keeps declaration role neutral",
		source: `type Consume<A extends O> = [A]; type O = {__monad:"O"};`,
		verify: (result: ParseTypesResult) => {
			const t = typeList(result).find(x => x.name === "Consume")
			assert.ok(t)
			assert.equal(t!.kind, "typeAlias")
		},
	},
	{
		name: "declaration metadata produced",
		source: `type O = {__monad:"O"}; type X<A extends O> = A;`,
		verify: (result: ParseTypesResult) => {
			const x = typeList(result).find(t => t.kind === "typeAlias" && t.name === "X")
			assert.ok(x)
			assert.ok(x!.position.start >= 0)
			assert.equal((x!.arguments ?? []).length > 0, true)
		},
	},
	{
		name: `import path normalization`,
		source: `import type { T1 } from "../mod1"; type X1<A extends O> = T1; type O = {__monad:"O"};`,
		verify: (result: ParseTypesResult) => {
			const imported = typeList(result).find(t => t.kind === "imported" && t.name === `T1`)
			assert.ok(imported)
			assert.match(imported!.refPath, new RegExp(`mod1$`))
		},
	},
	{
		name: "forward file-local type refs resolve after pass (infer extends; jsql EmptyTokenList vs TokensList)",
		source: `type Early = 1 extends infer R extends Later ? R : never; type Later = string;`,
		verify: (result: ParseTypesResult) => {
			const later = typeList(result).find(t => t.name === "Later" && t.kind === "typeAlias")
			const inferR = typeList(result).find(t => t.kind === "infer" && t.name === "R")
			assert.ok(later)
			assert.ok(inferR)
			let found = false
			const visit = (c: TypeCall): void => {
				if (c.kind !== "call") return
				if (
					c.typeId === inferR!.id &&
					c.arguments[0]?.kind === "call" &&
					c.arguments[0].typeId === later!.id
				) {
					found = true
				}
				for (const a of c.arguments) visit(a)
			}
			for (const s of scopeList(result)) for (const root of s.calls) visit(root)
			assert.ok(found, "infer constraint should reference local Later id, not global:Later")
		},
	},
]

test("parseTypes edge matrix", async (t: import("node:test").TestContext) => {
	for (const c of parserCases) {
		await t.test(c.name, () => {
			const result = parseTypes("/tmp/case.ts", c.source, (c as { options?: { idPrefix?: string } }).options)
			c.verify(result)
			assert.equal(result.types instanceof Map, true)
			assert.equal(result.scopes instanceof Map, true)
			assert.equal(
				scopeList(result).every(s => Array.isArray(s.calls)),
				true,
			)
			for (const s of scopeList(result)) {
				for (const c of s.calls) assertCallTree(c)
			}
			assert.equal(
				typeList(result).every(t => t.arguments === undefined || Array.isArray(t.arguments)),
				true,
			)
		})
	}
})
