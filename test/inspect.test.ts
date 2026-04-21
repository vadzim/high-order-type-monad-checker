import assert from "node:assert/strict"
import test from "node:test"
import { inspect } from "../src/utils.ts"

function countObjectUsages(root: unknown): Map<object, number> {
	const counts = new Map<object, number>()
	const expanded = new Set<object>()

	const visit = (value: unknown): void => {
		if (typeof value !== "object" || value === null) return
		counts.set(value, (counts.get(value) ?? 0) + 1)
		if (expanded.has(value)) return
		expanded.add(value)

		if (Array.isArray(value)) {
			for (const item of value) visit(item)
			return
		}
		if (value instanceof Set) {
			for (const item of value) visit(item)
			return
		}
		if (value instanceof Map) {
			for (const [k, v] of value) {
				visit(k)
				visit(v)
			}
			return
		}
		for (const key of Object.keys(value as Record<string, unknown>)) {
			visit((value as Record<string, unknown>)[key])
		}
	}

	visit(root)
	return counts
}

test("inspect prints shared object at topmost depth", () => {
	const b = { c: 1 }
	const a = { b }

	assert.equal(
		inspect({ a, b }),
		`{
  a: {
    b: <ref *1>,
  },
  b: <ref *1> {
    c: 1,
  },
}`,
	)
})

test("inspect picks first occurrence when depth is same", () => {
	const shared = { c: 1 }

	assert.equal(
		inspect({ x: shared, y: shared }),
		`{
  x: <ref *1> {
    c: 1,
  },
  y: <ref *1>,
}`,
	)
})

test("inspect supports node-like color output", () => {
	const shared = { c: 1 }
	const out = inspect({ x: shared, y: shared }, { colors: true })

	assert.match(out, /\u001b\[36m<ref \*1>\u001b\[39m/)
	assert.match(out, /\u001b\[33m1\u001b\[39m/)
})

test("inspect supports Set", () => {
	const shared = { c: 1 }
	const out = inspect(new Set([shared, shared]))
	assert.equal(
		out,
		`Set(1) [
  {
    c: 1,
  },
]`,
	)
})

test("inspect supports Map", () => {
	const shared = { c: 1 }
	const out = inspect(
		new Map([
			["x", shared],
			["y", shared],
		]),
	)
	assert.equal(
		out,
		`Map(2) {
  'x' => <ref *1> {
    c: 1,
  },
  'y' => <ref *1>,
}`,
	)
})

test("inspect uses refs only for repeated object identities", () => {
	const out = inspect({ onlyOnce: { c: 1 } })
	assert.doesNotMatch(out, /<ref \*\d+>/)
})

test("complex object", () => {
	const t = (() => {
		const v0: any = {}
		const v1: any = new Set()
		const v2: any = {}
		const v3: any = {}
		const v4: any = []
		const v5: any = {}
		const v6: any = {}
		const v7: any = new Set()
		const v8: any = {}
		const v9: any = {}
		const v10: any = {}
		const v11: any = {}
		const v12: any = {}
		const v13: any = []
		const v14: any = new Set()
		const v15: any = new Set()
		const v16: any = new Set()
		const v17: any = new Set()
		const v18: any = {}
		const v19: any = new Set()
		const v20: any = {}
		const v21: any = {}
		const v22: any = {}
		const v23: any = {}
		const v24: any = []
		const v25: any = {}
		const v26: any = {}
		const v27: any = new Set()
		const v28: any = {}
		const v29: any = {}
		const v30: any = new Set()
		const v31: any = new Set()
		const v32: any = new Set()
		const v33: any = new Set()
		const v34: any = new Set()
		const v35: any = {}
		const v36: any = []
		const v37: any = {}
		const v38: any = []
		const v39: any = new Set()
		const v40: any = new Set()
		const v41: any = new Set()
		const v42: any = new Set()
		const v43: any = new Set()
		const v44: any = new Set()
		v0.types = v1
		v0.scopes = v43
		v0.calls = v44
		v1.add(v2)
		v1.add(v22)
		v1.add(v11)
		v2.name = "A"
		v2.position = v3
		v2.arguments = v4
		v2.scope = v5
		v2.kind = "typeAlias"
		v2.called = v39
		v2.returnedBy = v40
		v2.returns = v41
		v2.refs = v42
		v3.start = 5
		v3.end = 6
		v5.kind = "file"
		v5.path = "/tmp/file.ts"
		v5.position = v6
		v5.types = v7
		v5.calls = v19
		v5.parent = v25
		v6.start = 0
		v6.end = 28
		v7.add(v8)
		v7.add(v10)
		v8.ref = v2
		v8.name = "A"
		v8.position = v9
		v8.scope = v5
		v9.start = 5
		v9.end = 6
		v10.ref = v11
		v10.name = "B"
		v10.position = v18
		v10.scope = v5
		v11.name = "B"
		v11.position = v12
		v11.arguments = v13
		v11.scope = v5
		v11.kind = "typeAlias"
		v11.called = v14
		v11.returnedBy = v15
		v11.returns = v16
		v11.refs = v17
		v12.start = 22
		v12.end = 23
		v16.add(v8)
		v17.add(v8)
		v18.start = 22
		v18.end = 23
		v19.add(v20)
		v19.add(v37)
		v20.type = v21
		v20.scope = v5
		v20.arguments = v36
		v21.ref = v22
		v21.name = "string"
		v21.position = v35
		v21.scope = v5
		v22.name = "string"
		v22.position = v23
		v22.arguments = v24
		v22.scope = v25
		v22.kind = "typeAlias"
		v22.called = v31
		v22.returnedBy = v32
		v22.returns = v33
		v22.refs = v34
		v23.start = 9
		v23.end = 15
		v25.kind = "global"
		v25.path = "[global]"
		v25.position = v26
		v25.types = v27
		v25.calls = v30
		v25.parent = null
		v26.start = 0
		v26.end = 28
		v27.add(v28)
		v28.ref = v22
		v28.name = "string"
		v28.position = v29
		v28.scope = v25
		v29.start = 9
		v29.end = 15
		v31.add(v20)
		v32.add(v8)
		v35.start = 9
		v35.end = 15
		v37.type = v8
		v37.scope = v5
		v37.arguments = v38
		v39.add(v37)
		v40.add(v10)
		v41.add(v21)
		v42.add(v21)
		v43.add(v25)
		v43.add(v5)
		v44.add(v20)
		v44.add(v37)
		return v0
	})()
	const out = inspect(t)
	const usageCounts = countObjectUsages(t)
	const expectedRefObjectCount = [...usageCounts.values()].filter(c => c > 1).length
	const allRefMatches = [...out.matchAll(/<ref \*(\d+)>/g)]
	const distinctRefIds = new Set(allRefMatches.map(m => Number(m[1])))
	assert.equal(distinctRefIds.size, expectedRefObjectCount, "objects used once must not get <ref *> labels")

	assert.equal(
		out,
		`{
  types: Set(3) [
    <ref *1> {
      name: 'A',
      position: {
        start: 5,
        end: 6,
      },
      arguments: [],
      scope: <ref *2>,
      kind: 'typeAlias',
      called: Set(1) [
        <ref *7>,
      ],
      returnedBy: Set(1) [
        <ref *8> {
          ref: <ref *10>,
          name: 'B',
          position: {
            start: 22,
            end: 23,
          },
          scope: <ref *2>,
        },
      ],
      returns: Set(1) [
        <ref *9> {
          ref: <ref *4>,
          name: 'string',
          position: {
            start: 9,
            end: 15,
          },
          scope: <ref *2>,
        },
      ],
      refs: Set(1) [
        <ref *9>,
      ],
    },
    <ref *4> {
      name: 'string',
      position: {
        start: 9,
        end: 15,
      },
      arguments: [],
      scope: <ref *5>,
      kind: 'typeAlias',
      called: Set(1) [
        <ref *6>,
      ],
      returnedBy: Set(1) [
        <ref *3>,
      ],
      returns: Set(0) [],
      refs: Set(0) [],
    },
    <ref *10> {
      name: 'B',
      position: {
        start: 22,
        end: 23,
      },
      arguments: [],
      scope: <ref *2>,
      kind: 'typeAlias',
      called: Set(0) [],
      returnedBy: Set(0) [],
      returns: Set(1) [
        <ref *3>,
      ],
      refs: Set(1) [
        <ref *3>,
      ],
    },
  ],
  scopes: Set(2) [
    <ref *5> {
      kind: 'global',
      path: '[global]',
      position: {
        start: 0,
        end: 28,
      },
      types: Set(1) [
        {
          ref: <ref *4>,
          name: 'string',
          position: {
            start: 9,
            end: 15,
          },
          scope: <ref *5>,
        },
      ],
      calls: Set(0) [],
      parent: null,
    },
    <ref *2> {
      kind: 'file',
      path: '/tmp/file.ts',
      position: {
        start: 0,
        end: 28,
      },
      types: Set(2) [
        <ref *3>,
        <ref *8>,
      ],
      calls: Set(2) [
        <ref *6>,
        <ref *7>,
      ],
      parent: <ref *5>,
    },
  ],
  calls: Set(2) [
    <ref *6> {
      type: <ref *9>,
      scope: <ref *2>,
      arguments: [],
    },
    <ref *7> {
      type: <ref *3>,
      scope: <ref *2>,
      arguments: [],
    },
  ],
}`,
	)
})
