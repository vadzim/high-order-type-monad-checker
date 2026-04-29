function typeKey(path, name) {
    return `${normalizeTypePath(path)}::${name}`;
}
function normalizeTypePath(path) {
    const slashNormalized = path.replaceAll("\\", "/");
    const withoutDotPrefix = slashNormalized.startsWith("./") ? slashNormalized.slice(2) : slashNormalized;
    return withoutDotPrefix.replaceAll(/\/+/g, "/");
}
export function concatContentGraphs(input) {
    const out = {
        refs: new Set(),
        types: new Set(),
        scopes: new Set(),
        calls: new Set(),
    };
    const graphs = Array.from(input);
    if (graphs.length === 0)
        return out;
    const globalScope = {
        kind: "global",
        path: "<global>",
        position: { start: 0, end: 0 },
        types: new Set(),
        calls: new Set(),
        parent: null,
    };
    const scopeMap = new Map();
    const typeMap = new Map();
    const refMap = new Map();
    const callMap = new Map();
    for (const graph of graphs) {
        for (const scope of graph.scopes) {
            if (scope.kind === "global") {
                scopeMap.set(scope, globalScope);
                continue;
            }
            const clonedScope = {
                kind: scope.kind,
                path: scope.path,
                position: { ...scope.position },
                types: new Set(),
                calls: new Set(),
                parent: null,
            };
            scopeMap.set(scope, clonedScope);
            out.scopes.add(clonedScope);
        }
    }
    out.scopes.add(globalScope);
    for (const [oldScope, clonedScope] of scopeMap) {
        if (oldScope.kind === "global")
            continue;
        clonedScope.parent = oldScope.parent ? (scopeMap.get(oldScope.parent) ?? null) : null;
    }
    for (const graph of graphs) {
        for (const type of graph.types) {
            const clonedType = {
                name: type.name,
                position: { ...type.position },
                arguments: [],
                declaration: null,
                body: null,
                scope: scopeMap.get(type.scope),
                kind: type.kind,
                called: new Set(),
                returnedBy: new Set(),
                returns: new Set(),
                refs: new Set(),
            };
            typeMap.set(type, clonedType);
            out.types.add(clonedType);
        }
    }
    for (const graph of graphs) {
        for (const ref of graph.refs) {
            const clonedRef = {
                ref: typeMap.get(ref.ref),
                name: ref.name,
                position: { ...ref.position },
                scope: scopeMap.get(ref.scope),
            };
            refMap.set(ref, clonedRef);
            out.refs.add(clonedRef);
        }
        for (const scope of graph.scopes) {
            for (const scopeRef of scope.types) {
                if (refMap.has(scopeRef))
                    continue;
                refMap.set(scopeRef, {
                    ref: typeMap.get(scopeRef.ref),
                    name: scopeRef.name,
                    position: { ...scopeRef.position },
                    scope: scopeMap.get(scopeRef.scope),
                });
            }
        }
    }
    for (const [oldScope, clonedScope] of scopeMap) {
        for (const scopeRef of oldScope.types)
            clonedScope.types.add(refMap.get(scopeRef));
    }
    for (const graph of graphs) {
        for (const call of graph.calls) {
            const clonedCall = {
                parent: null,
                type: refMap.get(call.type),
                scope: scopeMap.get(call.scope),
                arguments: [],
                position: call.position,
            };
            callMap.set(call, clonedCall);
            out.calls.add(clonedCall);
        }
    }
    for (const graph of graphs) {
        for (const call of graph.calls) {
            const clonedCall = callMap.get(call);
            clonedCall.arguments = call.arguments.map(arg => callMap.get(arg));
            clonedCall.parent = call.parent ? callMap.get(call.parent) : null;
            for (const arg of clonedCall.arguments)
                arg.parent = clonedCall;
        }
    }
    for (const graph of graphs) {
        for (const type of graph.types) {
            const clonedType = typeMap.get(type);
            clonedType.arguments = type.arguments.map(arg => ({
                variable: refMap.get(arg.variable),
                extends: arg.extends ? callMap.get(arg.extends) : null,
                default: arg.default ? callMap.get(arg.default) : null,
            }));
            clonedType.declaration = type.declaration ? callMap.get(type.declaration) : null;
            clonedType.body = type.body ? callMap.get(type.body) : null;
            clonedType.called = new Set([...type.called].map(call => callMap.get(call)));
            clonedType.returnedBy = new Set([...type.returnedBy].map(ref => refMap.get(ref)));
            clonedType.returns = new Set([...type.returns].map(ref => refMap.get(ref)));
            clonedType.refs = new Set([...type.refs].map(ref => refMap.get(ref)));
        }
    }
    for (const [oldScope, clonedScope] of scopeMap) {
        clonedScope.calls = new Set([...oldScope.calls].map(call => callMap.get(call)));
    }
    const concreteTypes = new Map();
    for (const type of out.types) {
        if (type.scope.kind !== "file")
            continue;
        if (type.scope.parent !== globalScope)
            continue;
        concreteTypes.set(typeKey(type.scope.path, type.name), type);
    }
    const stubTypesByKey = new Map();
    const typeRewrite = new Map();
    for (const type of out.types) {
        if (type.scope.kind !== "file")
            continue;
        if (type.scope.parent !== null)
            continue;
        const key = typeKey(type.scope.path, type.name);
        const concrete = concreteTypes.get(key);
        if (concrete) {
            typeRewrite.set(type, concrete);
            continue;
        }
        const existingStub = stubTypesByKey.get(key);
        if (existingStub) {
            typeRewrite.set(type, existingStub);
            continue;
        }
        stubTypesByKey.set(key, type);
    }
    if (typeRewrite.size > 0) {
        for (const ref of refMap.values()) {
            ref.ref = typeRewrite.get(ref.ref) ?? ref.ref;
        }
        for (const [fromType, toType] of typeRewrite) {
            for (const call of fromType.called)
                toType.called.add(call);
            for (const ref of fromType.returnedBy)
                toType.returnedBy.add(ref);
            for (const ref of fromType.returns)
                toType.returns.add(ref);
            for (const ref of fromType.refs)
                toType.refs.add(ref);
            if (toType.declaration === null && fromType.declaration !== null)
                toType.declaration = fromType.declaration;
            if (toType.body === null && fromType.body !== null)
                toType.body = fromType.body;
            if (toType.arguments.length === 0 && fromType.arguments.length > 0)
                toType.arguments = fromType.arguments;
        }
        for (const type of out.types) {
            if (typeRewrite.has(type))
                continue;
            type.called.clear();
            type.returnedBy.clear();
        }
        for (const call of out.calls) {
            call.type.ref.called.add(call);
        }
        for (const type of out.types) {
            if (typeRewrite.has(type))
                continue;
            const declRef = [...type.scope.types].find(ref => ref.ref === type && ref.name === type.name);
            if (!declRef)
                continue;
            for (const returnedRef of type.returns)
                returnedRef.ref.returnedBy.add(declRef);
        }
    }
    for (const [fromType] of typeRewrite) {
        out.types.delete(fromType);
    }
    for (const scope of out.scopes) {
        const nextTypes = new Set();
        for (const ref of scope.types) {
            if (typeRewrite.has(ref.ref))
                continue;
            nextTypes.add(ref);
        }
        scope.types = nextTypes;
    }
    const keptRefs = new Set();
    for (const ref of out.refs) {
        if (typeRewrite.has(ref.ref))
            continue;
        keptRefs.add(ref);
    }
    out.refs = keptRefs;
    const keptScopes = new Set();
    for (const scope of out.scopes) {
        if (scope === globalScope) {
            keptScopes.add(scope);
            continue;
        }
        if (scope.parent !== null) {
            keptScopes.add(scope);
            continue;
        }
        if (scope.types.size > 0 || scope.calls.size > 0) {
            keptScopes.add(scope);
        }
    }
    out.scopes = keptScopes;
    rebuildRecursionSets(out);
    return out;
}
function rebuildRecursionSets(graph) {
    for (const type of graph.types)
        delete type.recursion;
    const nodes = Array.from(graph.types).filter(type => (type.kind === "typeAlias" || type.kind === "interface" || type.kind === "class") && type.body !== null);
    const nodeSet = new Set(nodes);
    const edges = new Map(nodes.map(type => [
        type,
        new Set(Array.from(walkCalls(type.body)).flatMap(call => (nodeSet.has(call.type.ref) ? [call.type.ref] : []))),
    ]));
    const components = stronglyConnectedComponents(nodes, type => edges.get(type) ?? new Set());
    for (const component of components) {
        const recursive = component.length > 1 || component.some(type => edges.get(type)?.has(type) === true);
        if (!recursive)
            continue;
        const recursionSet = new Set(component);
        for (const type of component)
            type.recursion = recursionSet;
    }
}
function* walkCalls(call) {
    if (!call)
        return;
    yield call;
    for (const argument of call.arguments)
        yield* walkCalls(argument);
}
function stronglyConnectedComponents(nodes, edges) {
    let index = 0;
    const indices = new Map();
    const lowLinks = new Map();
    const stack = [];
    const onStack = new Set();
    const components = [];
    function visit(node) {
        indices.set(node, index);
        lowLinks.set(node, index);
        index += 1;
        stack.push(node);
        onStack.add(node);
        for (const next of edges(node)) {
            if (!indices.has(next)) {
                visit(next);
                lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
                continue;
            }
            if (onStack.has(next)) {
                lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(next)));
            }
        }
        if (lowLinks.get(node) !== indices.get(node))
            return;
        const component = [];
        while (stack.length > 0) {
            const member = stack.pop();
            onStack.delete(member);
            component.push(member);
            if (member === node)
                break;
        }
        components.push(component);
    }
    for (const node of nodes) {
        if (indices.has(node))
            continue;
        visit(node);
    }
    return components;
}
