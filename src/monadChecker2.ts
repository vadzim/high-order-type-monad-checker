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

	const monadReceivers = new Set<CGType>([monadReader, monadConsumer])

	// parameter of monadClass can be only the first one

	for (const type of graph.types) {
		for (const [index, arg] of type.arguments.entries()) {
			if (
				arg.extends?.type.name === "<extends>" &&
				arg.extends?.arguments[0].type.name === "<typeDeclaration>" &&
				arg.extends?.arguments[1].type.ref === monadClass
			) {
				if (index === 0) {
					monadReceivers.add(type)
				} else {
					violations.push({
						kind: "monad.invalidUsage",
						message: `Monad type ${arg.variable.name} can only be declared as the first parameter`,
						position: arg.variable.position,
						path: arg.variable.scope.path,
					})
				}
			}
		}
	}

	const initialMonads = new Set<CGType>()

	// monadClass can only be used in the right side of extends immediately

	for (const call of usages(monadClass)) {
		if (
			call.parent?.type.name !== "<extends>" ||
			call.parent?.arguments.length !== 2 ||
			call.parent?.arguments[1] !== call ||
			call.parent?.arguments[0].type.name !== "<typeDeclaration>"
		) {
			violations.push({
				kind: "monad.invalidUsage",
				message: `Type ${call.type.name} is a monad type class. It can only be used to declare a monad type using extends`,
				position: call.position,
				path: call.scope.path,
			})
		} else {
			initialMonads.add(call.parent?.arguments[0]?.arguments[0]?.type.ref ?? never())
		}
	}

	const callToType = new Map(graph.types.values().flatMap(t => allCallsForType(t).map(c => [c, t])))

	const isReturned = (call: CGCall) => returns(callToType.get(call)?.body).some(c => c === call)

	const monads = new Set(walk(initialMonads, m => m.returnedBy.values().map(t => t.ref)))

	// if a type returns a monad, it should always return a monad

	for (const monad of monads.difference(initialMonads)) {
		for (const ret of returns(monad.body ?? never())) {
			if (!monads.has(ret.type.ref) && ret.type.name !== "never") {
				const returningMonad = returns(monad.body ?? never()).find(r => monads.has(r.type.ref)) ?? never()
				violations.push({
					kind: "monad.incompatibleTypes",
					message: `Incompatible types. Returning type ${ret.type.name} is not a monad`,
					position: ret.position,
					path: ret.scope.path,
					relatedMessage: `Though the other return ${returningMonad.type.name} is a monad`,
					relatedPosition: returningMonad.position,
					relatedPath: returningMonad.scope.path,
				})
			}
		}
	}

	const rootTypes = new Set(graph.types.values().filter(t => t.kind === "typeAlias"))

	const aliases = new Set(rootTypes.values().filter(t => t.arguments.length === 0))

	for (const monad of monads) {
		for (const call of usages(monad)) {
			// monad cannot be used within extends' right side
			if (isInRightSideOfExtends(call)) {
				violations.push({
					kind: "monad.invalidUsage",
					message: `Monad type ${monad.name} cannot be used within the right side of extends operator`,
					position: call.position,
					path: call.scope.path,
				})
			}

			if (call.parent && !isReturned(call)) {
				// a monad can be passed to a generic type only as a first parameter
				if (call.parent.arguments[0] !== call) {
					violations.push({
						kind: "monad.invalidUsage",
						message: `Monad type ${monad.name} can be passed to a generic type only as a first parameter`,
						position: call.position,
						path: call.scope.path,
					})
				}

				// a monad can be passed to a generic type only if that argument is mark as a monad
				if (
					call.parent.type.name !== "<extends>" &&
					(call.parent.type.ref.arguments[0]?.extends?.type.name !== "<extends>" ||
						call.parent.type.ref.arguments[0]?.extends?.arguments[1].type.ref !== monadClass)
				) {
					const type = callToType.get(call)
					const isReader = type === monadReader
					const isConsumer = type === monadConsumer
					const isInReturningTuple = returns(type?.body).some(
						c => c.type.name === "<tuple>" && c.arguments[0] === call,
					)

					if (!isReader && !isConsumer && !isInReturningTuple) {
						violations.push({
							kind: "monad.invalidUsage",
							message: `Monad type ${monad.name} can be passed to a generic type only if that argument is mark as a monad`,
							position: call.position,
							path: call.scope.path,
							relatedMessage: `${call.parent.type.ref.arguments[0]?.variable.name} is not marked as a monad`,
							relatedPosition: call.parent.type.ref.arguments[0]?.variable.position,
							relatedPath: call.parent.type.ref.arguments[0]?.variable.scope.path,
						})
					}
				}
			}
		}
	}

	// to a type which defines the first parameter as a monad

	// result of monad consumers call can only be immediately assigned to a variable of monad class type

	return violations
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

function* allCalls(c: CGCall | null): Generator<CGCall> {
	if (c) {
		yield c
		yield* c.arguments.values().flatMap(allCalls)
	}
}

function* allCallsForType(type: CGType): Generator<CGCall> {
	yield* allCalls(type.body)
	for (const arg of type.arguments) {
		yield* allCalls(arg.extends)
		yield* allCalls(arg.default)
	}
}

function isInRightSideOfExtends(call: CGCall): boolean {
	const pr = [call, ...parents(call)]
	const ei = pr.findIndex(p => p.type.name === "<extends>")
	return ei >= 0 && pr[ei].arguments[1] === pr[ei - 1]
}
