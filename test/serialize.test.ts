import assert from "node:assert/strict"
import test from "node:test"
import { serialize } from "../src/utils.ts"

function materialize(source: string): unknown {
	return Function(`return (${source})`)() as unknown
}

test("serialize preserves shared references", () => {
	const shared = { v: 1 }
	const input = { a: shared, b: shared }
	const out = materialize(serialize(input)) as { a: { v: number }; b: { v: number } }
	assert.equal(out.a, out.b)
	assert.equal(out.a.v, 1)
})

test("serialize supports Map/Set/Date", () => {
	const shared = { z: 1 }
	const date = new Date("2024-01-01T00:00:00.000Z")
	const map = new Map<unknown, unknown>([
		["k", shared],
		[date, new Set([shared])],
	])
	const out = materialize(serialize(map)) as Map<unknown, unknown>

	assert.equal(out instanceof Map, true)
	const outShared = out.get("k") as { z: number }
	assert.equal(outShared.z, 1)
	const outDateKey = [...out.keys()].find(k => k instanceof Date) as Date
	assert.equal(outDateKey.toISOString(), "2024-01-01T00:00:00.000Z")
	const outSet = out.get(outDateKey) as Set<unknown>
	assert.equal(outSet instanceof Set, true)
	assert.equal(outSet.has(outShared), true)
})

test("serialize supports global symbol values", () => {
	const s = Symbol.for("x")
	const out = materialize(serialize({ s })) as { s: symbol }
	assert.equal(out.s, s)
})

test("serialize rejects functions", () => {
	assert.throws(() => serialize({ fn: () => 1 }), /functions\/classes are not supported/)
})

test("serialize rejects non-global symbols", () => {
	assert.throws(() => serialize({ s: Symbol("x") }), /non-global symbol/)
})
