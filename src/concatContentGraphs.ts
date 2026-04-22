import type { CGCall, CGScope, CGType, CGTypeRef, ContentGraph } from "./buildContentGraph.ts"

function typeKey(path: string, name: string): string {
	return `${path}::${name}`
}

export function concatContentGraphs(input: Iterable<ContentGraph>): ContentGraph {
	const out: ContentGraph = {
		refs: new Set(),
		types: new Set(),
		scopes: new Set(),
		calls: new Set(),
	}
	const graphs = Array.from(input)
	if (graphs.length === 0) return out

	const globalScope: CGScope = {
		kind: "global",
		path: "<global>",
		position: { start: 0, end: 0 },
		types: new Set(),
		calls: new Set(),
		parent: null,
	}

	const scopeMap = new Map<CGScope, CGScope>()
	const typeMap = new Map<CGType, CGType>()
	const refMap = new Map<CGTypeRef, CGTypeRef>()
	const callMap = new Map<CGCall, CGCall>()

	for (const graph of graphs) {
		for (const scope of graph.scopes) {
			if (scope.kind === "global") {
				scopeMap.set(scope, globalScope)
				continue
			}
			const clonedScope: CGScope = {
				kind: scope.kind,
				path: scope.path,
				position: { ...scope.position },
				types: new Set(),
				calls: new Set(),
				parent: null,
			}
			scopeMap.set(scope, clonedScope)
			out.scopes.add(clonedScope)
		}
	}
	out.scopes.add(globalScope)

	for (const [oldScope, clonedScope] of scopeMap) {
		if (oldScope.kind === "global") continue
		clonedScope.parent = oldScope.parent ? (scopeMap.get(oldScope.parent) ?? null) : null
	}

	for (const graph of graphs) {
		for (const type of graph.types) {
			const clonedType: CGType = {
				name: type.name,
				position: { ...type.position },
				arguments: [],
				body: null,
				scope: scopeMap.get(type.scope)!,
				kind: type.kind,
				called: new Set(),
				returnedBy: new Set(),
				returns: new Set(),
				refs: new Set(),
			}
			typeMap.set(type, clonedType)
			out.types.add(clonedType)
		}
	}

	for (const graph of graphs) {
		for (const ref of graph.refs) {
			const clonedRef: CGTypeRef = {
				ref: typeMap.get(ref.ref)!,
				name: ref.name,
				position: { ...ref.position },
				scope: scopeMap.get(ref.scope)!,
			}
			refMap.set(ref, clonedRef)
			out.refs.add(clonedRef)
		}
		for (const scope of graph.scopes) {
			for (const scopeRef of scope.types) {
				if (refMap.has(scopeRef)) continue
				refMap.set(scopeRef, {
					ref: typeMap.get(scopeRef.ref)!,
					name: scopeRef.name,
					position: { ...scopeRef.position },
					scope: scopeMap.get(scopeRef.scope)!,
				})
			}
		}
	}

	for (const [oldScope, clonedScope] of scopeMap) {
		for (const scopeRef of oldScope.types) clonedScope.types.add(refMap.get(scopeRef)!)
	}

	for (const graph of graphs) {
		for (const call of graph.calls) {
			const clonedCall: CGCall = {
				parent: null,
				type: refMap.get(call.type)!,
				scope: scopeMap.get(call.scope)!,
				arguments: [],
				position: call.position,
			}
			callMap.set(call, clonedCall)
			out.calls.add(clonedCall)
		}
	}

	for (const graph of graphs) {
		for (const call of graph.calls) {
			const clonedCall = callMap.get(call)!
			clonedCall.arguments = call.arguments.map(arg => callMap.get(arg)!)
			clonedCall.parent = call.parent ? callMap.get(call.parent)! : null
			for (const arg of clonedCall.arguments) arg.parent = clonedCall
		}
	}

	for (const graph of graphs) {
		for (const type of graph.types) {
			const clonedType = typeMap.get(type)!
			clonedType.arguments = type.arguments.map(arg => ({
				variable: refMap.get(arg.variable)!,
				extends: arg.extends ? callMap.get(arg.extends)! : null,
				default: arg.default ? callMap.get(arg.default)! : null,
			}))
			clonedType.body = type.body ? callMap.get(type.body)! : null
			clonedType.called = new Set([...type.called].map(call => callMap.get(call)!))
			clonedType.returnedBy = new Set([...type.returnedBy].map(ref => refMap.get(ref)!))
			clonedType.returns = new Set([...type.returns].map(ref => refMap.get(ref)!))
			clonedType.refs = new Set([...type.refs].map(ref => refMap.get(ref)!))
		}
	}

	for (const [oldScope, clonedScope] of scopeMap) {
		clonedScope.calls = new Set([...oldScope.calls].map(call => callMap.get(call)!))
	}

	const concreteTypes = new Map<string, CGType>()
	for (const type of out.types) {
		if (type.scope.kind !== "file") continue
		if (type.scope.parent !== globalScope) continue
		concreteTypes.set(typeKey(type.scope.path, type.name), type)
	}

	const stubTypesByKey = new Map<string, CGType>()
	const typeRewrite = new Map<CGType, CGType>()
	for (const type of out.types) {
		if (type.scope.kind !== "file") continue
		if (type.scope.parent !== null) continue
		const key = typeKey(type.scope.path, type.name)
		const concrete = concreteTypes.get(key)
		if (concrete) {
			typeRewrite.set(type, concrete)
			continue
		}
		const existingStub = stubTypesByKey.get(key)
		if (existingStub) {
			typeRewrite.set(type, existingStub)
			continue
		}
		stubTypesByKey.set(key, type)
	}

	if (typeRewrite.size > 0) {
		for (const ref of refMap.values()) {
			ref.ref = typeRewrite.get(ref.ref) ?? ref.ref
		}
		for (const [fromType, toType] of typeRewrite) {
			for (const call of fromType.called) toType.called.add(call)
			for (const ref of fromType.returnedBy) toType.returnedBy.add(ref)
			for (const ref of fromType.returns) toType.returns.add(ref)
			for (const ref of fromType.refs) toType.refs.add(ref)
			if (toType.body === null && fromType.body !== null) toType.body = fromType.body
			if (toType.arguments.length === 0 && fromType.arguments.length > 0) toType.arguments = fromType.arguments
		}
		for (const type of out.types) {
			if (typeRewrite.has(type)) continue
			type.called.clear()
			type.returnedBy.clear()
		}
		for (const call of out.calls) {
			call.type.ref.called.add(call)
		}
		for (const type of out.types) {
			if (typeRewrite.has(type)) continue
			const declRef = [...type.scope.types].find(ref => ref.ref === type && ref.name === type.name)
			if (!declRef) continue
			for (const returnedRef of type.returns) returnedRef.ref.returnedBy.add(declRef)
		}
	}

	for (const [fromType] of typeRewrite) {
		out.types.delete(fromType)
	}

	for (const scope of out.scopes) {
		const nextTypes = new Set<CGTypeRef>()
		for (const ref of scope.types) {
			if (typeRewrite.has(ref.ref)) continue
			nextTypes.add(ref)
		}
		scope.types = nextTypes
	}

	const keptRefs = new Set<CGTypeRef>()
	for (const ref of out.refs) {
		if (typeRewrite.has(ref.ref)) continue
		keptRefs.add(ref)
	}
	out.refs = keptRefs

	const keptScopes = new Set<CGScope>()
	for (const scope of out.scopes) {
		if (scope === globalScope) {
			keptScopes.add(scope)
			continue
		}
		if (scope.parent !== null) {
			keptScopes.add(scope)
			continue
		}
		if (scope.types.size > 0 || scope.calls.size > 0) {
			keptScopes.add(scope)
		}
	}
	out.scopes = keptScopes

	return out
}
