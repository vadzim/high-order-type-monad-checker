import test from "node:test"
import assert from "node:assert/strict"
import { parseTypes } from "../src/parseTypes.ts"

const parserCases = [
	{
		name: "single type alias",
		source: `type A = string;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			assert.equal(
				result.types.some(t => t.name === "A" && t.kind === "typeAlias"),
				true,
			)
			assert.equal(
				result.scopes.some(s => s.kind === "file"),
				true,
			)
		},
	},
	{
		name: "imported type has resolved refPath",
		source: `import type { A } from "./x"; type B = A;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const imported = result.types.find(t => t.kind === "imported" && t.name === "A")
			assert.ok(imported)
			assert.match(imported!.refPath, /x$/)
		},
	},
	{
		name: "type parameter scope exists",
		source: `type A<T> = T;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			assert.equal(
				result.scopes.some(s => s.kind === "typeParameters"),
				true,
			)
			assert.equal(
				result.types.some(t => t.kind === "typeParameter" && t.name === "T"),
				true,
			)
		},
	},
	{
		name: "type parameter extends is parsed for identifier constraint",
		source: `type A<B extends C> = B; type C = string;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const b = result.types.find(t => t.kind === "typeParameter" && t.name === "B")
			const c = result.types.find(t => t.name === "C")
			assert.ok(b)
			assert.ok(c)
			assert.equal(typeof b!.extends === "string" ? undefined : b!.extends?.typeId, c!.id)
		},
	},
	{
		name: "infer extends is parsed for identifier constraint only",
		source: `type A<B extends C> = B extends infer D extends E ? D : K extends infer I extends [number] ? I : never; type C = string; type E = string; type K = string;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const d = result.types.find(t => t.kind === "infer" && t.name === "D")
			const i = result.types.find(t => t.kind === "infer" && t.name === "I")
			const e = result.types.find(t => t.name === "E")
			assert.ok(d)
			assert.ok(i)
			assert.ok(e)
			assert.equal(typeof d!.extends === "string" ? undefined : d!.extends?.typeId, e!.id)
			assert.deepEqual(i!.extends, {})
		},
	},
	{
		name: "scope references include real positions",
		source: `type A<B extends C> = B; type C = string;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const hasReference = result.scopes.some(scope =>
				scope.references.some(ref => ref.position.start >= 0 && ref.position.end >= ref.position.start),
			)
			assert.equal(hasReference, true)
		},
	},
	{
		name: "scope calls include resolved and complex arguments",
		source: `type B = string; type C = number; type T = boolean; type A<X, Y> = [X, Y]; type D<Z> = Z; type X = A<B, C> | D<[T]>;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const a = result.types.find(t => t.kind === "typeAlias" && t.name === "A")
			const b = result.types.find(t => t.kind === "typeAlias" && t.name === "B")
			const c = result.types.find(t => t.kind === "typeAlias" && t.name === "C")
			const d = result.types.find(t => t.kind === "typeAlias" && t.name === "D")
			assert.ok(a)
			assert.ok(b)
			assert.ok(c)
			assert.ok(d)
			const calls = result.scopes.flatMap(s => s.calls)
			const aCall = calls.find(call => call.typeId === a!.id)
			const dCall = calls.find(call => call.typeId === d!.id)
			assert.ok(aCall)
			assert.ok(dCall)
			assert.equal(aCall!.arguments.length, 2)
			assert.equal(aCall!.arguments[0]?.typeId, b!.id)
			assert.equal(aCall!.arguments[1]?.typeId, c!.id)
			assert.equal(dCall!.arguments.length, 1)
			assert.equal(dCall!.arguments[0]?.typeId, "")
		},
	},
	{
		name: "unresolved module-external types use global ids",
		source: `type X<T extends string> = Promise<number>;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const t = result.types.find(x => x.kind === "typeParameter" && x.name === "T")
			assert.ok(t)
			assert.equal(t!.extends?.typeId, "global:string")
			const calls = result.scopes.flatMap(s => s.calls)
			const promiseCall = calls.find(call => call.typeId === "global:Promise")
			assert.ok(promiseCall)
			assert.equal(promiseCall!.arguments[0]?.typeId, "global:number")
		},
	},
	{
		name: "parsed type arguments include declaration type parameter ids",
		source: `type D = string; type C<A, B extends D> = [A, B];`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const x = result.types.find(t => t.kind === "typeAlias" && t.name === "C")
			const a = result.types.find(t => t.kind === "typeParameter" && t.name === "A")
			const b = result.types.find(t => t.kind === "typeParameter" && t.name === "B")
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
		source: `type A<X> = X extends infer T extends O ? T : never; type O = {__opaque:"O"};`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			assert.equal(
				result.scopes.some(s => s.kind === "infer"),
				true,
			)
			assert.equal(
				result.types.some(t => t.kind === "infer" && t.name === "T"),
				true,
			)
		},
	},
	{
		name: "conditional creates branch scopes",
		source: `type A<T> = T extends string ? 1 : 2;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			assert.equal(
				result.scopes.some(s => s.kind === "branchTrue"),
				true,
			)
			assert.equal(
				result.scopes.some(s => s.kind === "branchFalse"),
				true,
			)
		},
	},
	{
		name: "positions are populated",
		source: `type PositionType = string;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const decl = result.types.find(t => t.name === "PositionType")
			assert.ok(decl)
			assert.ok(decl!.position.start >= 0)
			assert.ok(decl!.position.end >= decl!.position.start)
		},
	},
	{
		name: "duplicate type parameter names in nested scopes",
		source: `type A<T extends O> = T extends infer T extends O ? T : never; type O = {__opaque:"O"};`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const params = result.types.filter(
				t => t.name === "T" && (t.kind === "typeParameter" || t.kind === "infer"),
			)
			assert.ok(params.length >= 2)
			assert.notEqual(params[0].scopeId, params[1].scopeId)
		},
	},
	{
		name: "mixed declarations captured",
		source: `type A = string; interface B {}; class C<T extends O> {}; type O = {__opaque:"O"};`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			assert.equal(
				result.types.some(t => t.kind === "typeAlias" && t.name === "A"),
				true,
			)
			assert.equal(
				result.types.some(t => t.kind === "interface" && t.name === "B"),
				true,
			)
			assert.equal(
				result.types.some(t => t.kind === "class" && t.name === "C"),
				true,
			)
		},
	},
	{
		name: "parseTypes keeps declaration role neutral",
		source: `type Consume<A extends O> = [A]; type O = {__opaque:"O"};`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const t = result.types.find(x => x.name === "Consume")
			assert.ok(t)
			assert.equal(t!.kind, "typeAlias")
		},
	},
	{
		name: "declaration metadata produced",
		source: `type O = {__opaque:"O"}; type X<A extends O> = A;`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const x = result.types.find(t => t.kind === "typeAlias" && t.name === "X")
			assert.ok(x)
			assert.ok(x!.position.start >= 0)
			assert.equal((x!.arguments ?? []).length > 0, true)
		},
	},
	{
		name: `import path normalization`,
		source: `import type { T1 } from "../mod1"; type X1<A extends O> = T1; type O = {__opaque:"O"};`,
		verify: (result: ReturnType<typeof parseTypes>) => {
			const imported = result.types.find(t => t.kind === "imported" && t.name === `T1`)
			assert.ok(imported)
			assert.match(imported!.refPath, new RegExp(`mod1$`))
		},
	},
]

test("parseTypes edge matrix", async (t: import("node:test").TestContext) => {
	for (const c of parserCases) {
		await t.test(c.name, () => {
			const result = parseTypes("/tmp/case.ts", c.source, (c as { options?: { idPrefix?: string } }).options)
			c.verify(result)
			assert.equal(Array.isArray(result.types), true)
			assert.equal(Array.isArray(result.scopes), true)
			assert.equal(result.scopes.every(s => Array.isArray(s.references)), true)
			assert.equal(result.scopes.every(s => Array.isArray(s.calls)), true)
			assert.equal(result.types.every(t => t.arguments === undefined || Array.isArray(t.arguments)), true)
		})
	}
})
