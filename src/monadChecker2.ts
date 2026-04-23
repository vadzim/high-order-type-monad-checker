import "core-js"
import { never } from "./utils.ts"
import type { CGCall, CGPosition, CGType, ContentGraph } from "./buildContentGraph.ts"
import { walk } from "./iterables.ts"

// monadChecker responsibility boundary:
// - evaluate borrow rules over parseTypes output
// - emit violations only (no CLI/output formatting concerns)

export type MonadTypeOption = {
	path: string
	name: string
	consumerName: string
	constructorName: string
	readerName: string
}

export type MonadViolation = {
	kind: string
	message: string
	position: CGPosition
	path: string
	relatedMessage?: string
	relatedPosition?: CGPosition
	relatedPath?: string
}

export function getMonadViolations(graph: ContentGraph, options: MonadTypeOption): MonadViolation[] {
	const violations: MonadViolation[] = []

	const monadInfo = new Map(
		graph.types
			.values()
			.filter(t => t.scope.path === options.path && t.kind === "typeAlias")
			.map(t => [t.name, t]),
	)

	const monadClass = monadInfo.get(options.name) ?? never("Monad class not found")

	const monadConstructor = monadInfo.get(options.constructorName) ?? never("Monad constructor not found")
	const monadReader = monadInfo.get(options.readerName) ?? never("Monad reader not found")
	const monadConsumer = monadInfo.get(options.consumerName) ?? never("Monad consumer not found")

	const callToOwner = new Map(graph.types.values().flatMap(type => allCallsForType(type).map(call => [call, type])))

	const monadValueTypes = new Set<CGType>()

	for (const type of graph.types) {
		for (const [index, arg] of type.arguments.entries()) {
			if (arg.extends?.type.ref !== monadClass) continue
			if (index !== 0) {
				violations.push({
					kind: "monad.invalidUsage",
					message: `Using ${arg.variable.name} here as a monad-marked type parameter is not allowed, because only the first generic parameter may extend ${monadClass.name}`,
					position: arg.variable.position,
					path: arg.variable.scope.path,
				})
			}
			monadValueTypes.add(arg.variable.ref)
		}
	}

	for (const call of usages(monadClass)) {
		if (!isAllowedMonadClassMarkerUse(call)) {
			violations.push({
				kind: "monad.invalidUsage",
				message: `Using ${call.type.name} here is not allowed, because ${call.type.name} is only a marker type. It may only appear on the right side of extends in a declaration either immediately or as the first item of a tuple`,
				position: call.position,
				path: call.scope.path,
			})
			continue
		}
		if (call.parent?.type.name === "<extends>" && call.parent.arguments[1] === call) {
			monadValueTypes.add(call.parent.arguments[0]!.arguments[0]!.type.ref)
		}
	}

	let changed = true
	while (changed) {
		changed = false
		for (const type of graph.types) {
			if (type.kind !== "typeAlias" || monadValueTypes.has(type)) continue
			const branches = terminalReturns(type)
			if (branches.length === 0) continue
			if (branches.every(call => call.type.name === "never" || monadValueTypes.has(call.type.ref))) {
				monadValueTypes.add(type)
				changed = true
			}
		}
	}

	const consumerTypes = new Set<CGType>([monadConsumer])
	const userMonadInputTypes = new Set(
		Array.from(graph.types).filter(
			type => type.kind === "typeAlias" && type !== monadConsumer && type !== monadReader && hasMonadInput(type),
		),
	)
	const tupleReturnTypes = new Set<CGType>()

	changed = true
	while (changed) {
		changed = false
		for (const type of graph.types) {
			if (type.kind !== "typeAlias" || tupleReturnTypes.has(type)) continue
			const branches = terminalReturns(type)
			if (branches.length === 0) continue
			if (branches.every(isAllowedConsumerBranch)) {
				tupleReturnTypes.add(type)
				changed = true
			}
		}
	}

	for (const consumerType of userMonadInputTypes) {
		const branches = terminalReturns(consumerType)
		for (const branch of branches) {
			if (isAllowedConsumerBranch(branch)) continue
			violations.push({
				kind: "monad.incompatibleTypes",
				message: `This branch of ${consumerType.name} is not allowed, because a user type that accepts monad input must return [monad, result] or never in every branch`,
				position: branch.position,
				path: branch.scope.path,
				relatedMessage: `${consumerType.name} accepts monad input here`,
				relatedPosition: consumerType.position,
				relatedPath: consumerType.scope.path,
			})
		}
	}

	for (const consumerType of consumerTypes) {
		for (const call of usages(consumerType)) {
			if (isAllowedConsumerInvocation(call)) continue
			violations.push({
				kind: "monad.invalidUsage",
				message: `Using consumer ${consumerType.name} here is not allowed. It must be either the terminal return of another consumer branch, or the immediate left side of extends with a right side like [${monadClass.name}, result]`,
				position: call.position,
				path: call.scope.path,
			})
		}
	}

	for (const monadType of monadValueTypes) {
		for (const call of usages(monadType)) {
			if (isIgnoredMonadUsage(call)) continue
			if (!isMonadArgumentUsage(call)) continue
			if (isAllowedTupleConsumerResultPosition(call)) continue
			const parent = call.parent
			if (!parent) continue
			if (parent.arguments[0] !== call) {
				violations.push({
					kind: "monad.invalidUsage",
					message: `Using monad ${call.type.name} here is not allowed, because a monad may only be passed as the first argument of another type, except in [monad, result] consumer returns`,
					position: call.position,
					path: call.scope.path,
				})
			}
		}
	}

	for (const monadType of monadValueTypes) {
		const seenInBranch: CGCall[] = []
		const calls = Array.from(usages(monadType)).sort(compareCalls)
		for (const call of calls) {
			if (isIgnoredMonadUsage(call)) continue
			const previous = seenInBranch.find(
				prev => prev.type.ref === call.type.ref && scopeContains(prev.scope, call.scope),
			)
			if (previous) {
				violations.push({
					kind: "monad.invalidUsage",
					message: `Using monad ${call.type.name} here is not allowed, because this branch already consumed it earlier. Only ${monadReader.name} may read the same monad multiple times`,
					position: call.position,
					path: call.scope.path,
					relatedMessage: `The same branch already consumed ${call.type.name} here`,
					relatedPosition: previous.position,
					relatedPath: previous.scope.path,
				})
				continue
			}
			seenInBranch.push(call)
		}
	}

	return violations

	function terminalReturns(type: CGType): CGCall[] {
		return Array.from(returns(body(type)))
	}

	function isTupleWithMonadResult(call: CGCall): boolean {
		return call.type.name === "<tuple>" && call.arguments.length === 2 && isMonadValueCall(call.arguments[0]!)
	}

	function isAllowedConsumerBranch(call: CGCall): boolean {
		return call.type.name === "never" || isTupleWithMonadResult(call) || tupleReturnTypes.has(call.type.ref)
	}

	function isMonadValueCall(call: CGCall): boolean {
		return monadValueTypes.has(call.type.ref)
	}

	function isAllowedConsumerInvocation(call: CGCall): boolean {
		if (consumerTypeInTupleHead(call)) return true
		const owner = callToOwner.get(call)
		if (owner === monadConsumer && terminalReturns(owner).some(ret => ret === call)) return true
		if (call.parent?.type.name !== "<extends>" || call.parent.arguments[0] !== call) return false
		return isTupleWithConfiguredMonadPattern(call.parent.arguments[1] ?? null)
	}

	function isTupleWithConfiguredMonadPattern(call: CGCall | null): boolean {
		if (!call || call.type.name !== "<tuple>" || call.arguments.length !== 2) return false
		const head = call.arguments[0]
		if (!head) return false
		if (head.type.ref === monadClass) return true
		return (
			head.type.name === "<extends>" &&
			head.arguments[1]?.type.ref === monadClass &&
			head.arguments[0]?.type.name === "<typeDeclaration>"
		)
	}

	function isIgnoredMonadUsage(call: CGCall): boolean {
		const owner = callToOwner.get(call)
		if (owner === monadReader || owner === monadConsumer) return true
		return call.parent?.type.ref === monadReader
	}

	function isAllowedMonadClassMarkerUse(call: CGCall): boolean {
		if (
			// [infer] T extends Monad
			call.parent?.type.name === "<extends>" &&
			call.parent.arguments[1] === call &&
			call.parent.arguments[0]?.type.name === "<typeDeclaration>"
		) {
			if (
				// infer T extends Monad ? ...
				call.parent.parent?.type.name === "<conditional>" &&
				call.parent.parent.arguments[0] === call.parent
			) {
				return true
			}

			if (
				// type X<T extends Monad, ...> =
				call.parent.parent?.type.name === "<typeDeclaration>" &&
				call.parent.parent.arguments[2] === call.parent
			) {
				return true
			}

			if (
				// consumerCall extends [infer T extends Monad, ...] ? ...
				call.parent.parent?.type.name === "<tuple>" &&
				call.parent.parent.arguments[0] === call.parent &&
				call.parent.parent.parent?.type.name === "<extends>" &&
				call.parent.parent.parent.arguments[1] === call.parent.parent &&
				call.parent.parent.parent.parent?.type.name === "<conditional>" &&
				call.parent.parent.parent.parent.arguments[0] === call.parent.parent.parent
			) {
				return true
			}
		}

		return false
	}

	function isMonadArgumentUsage(call: CGCall): boolean {
		if (!call.parent) return false
		if (call.parent.type.name === "<typeDeclaration>") return false
		if (call.parent.type.name === "<declaration>") return false
		if (call.parent.type.name === "<extends>") return false
		if (call.parent.type.name === "<conditional>") return false
		return true
	}

	function isAllowedTupleConsumerResultPosition(call: CGCall): boolean {
		if (call.parent?.type.name !== "<tuple>") return false
		if (call.parent.arguments[0] !== call) return false
		const owner = callToOwner.get(call.parent)
		if (!owner || !(owner === monadConsumer || hasMonadInput(owner))) return false
		return terminalReturns(owner).some(ret => ret === call.parent)
	}

	function consumerTypeInTupleHead(call: CGCall): boolean {
		if (call.type.ref !== monadConsumer) return false
		if (call.parent?.type.name !== "<tuple>") return false
		if (call.parent.arguments[0] !== call) return false
		const owner = callToOwner.get(call.parent)
		if (!owner || !(owner === monadConsumer || hasMonadInput(owner))) return false
		return terminalReturns(owner).some(ret => ret === call.parent)
	}

	function hasMonadInput(type: CGType): boolean {
		return type.arguments[0]?.extends?.type.ref === monadClass
	}
}

function usages(type: CGType) {
	return type.called.values().filter(c => c.parent?.type.name !== "<typeDeclaration>")
}

function* parents(call: CGCall): Generator<CGCall> {
	let current = call
	while (current.parent != null) {
		yield current.parent
		current = current.parent
	}
}

function* returns(body: CGCall | null | undefined): Generator<CGCall> {
	if (body) {
		if (body.type.name !== "<conditional>") {
			yield body
		} else {
			yield* returns(body.arguments[1])
			yield* returns(body.arguments[2])
		}
	}
}

function* allCalls(c: CGCall | null | undefined): Generator<CGCall> {
	if (c) {
		yield c
		yield* c.arguments.values().flatMap(allCalls)
	}
}

function* allCallsForType(type: CGType): Generator<CGCall> {
	yield* allCalls(type.declaration?.parent)
}

function body(type: CGType | null | undefined): CGCall | undefined | null {
	return type?.declaration?.parent?.arguments[1] ?? type?.body
}

function scopeContains(parent: { parent: typeof parent | null }, child: { parent: typeof child | null }): boolean {
	let current: typeof child | null = child
	while (current) {
		if (current === parent) return true
		current = current.parent
	}
	return false
}

function compareCalls(left: CGCall, right: CGCall): number {
	if (left.scope.path !== right.scope.path) return left.scope.path.localeCompare(right.scope.path)
	if (left.position.start !== right.position.start) return left.position.start - right.position.start
	return left.position.end - right.position.end
}
