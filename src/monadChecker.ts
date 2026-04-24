import "core-js"
import { never } from "./utils.ts"
import type { CGCall, CGPosition, CGType, ContentGraph } from "./buildContentGraph.ts"

// monadChecker responsibility boundary:
// - evaluate borrow rules over parseTypes output
// - emit violations only (no CLI/output formatting concerns)

export type MonadTypeOption = {
	path: string
	name: string
	consumerName: string
	constructorName: string
	readerName: string
	strictMonadModule?: boolean
}

export type MonadViolation = {
	kind: string
	message: string
	position: CGPosition
	path: string
	related?: {
		message?: string
		position: CGPosition
		path: string
	}[]
}

export function getMonadViolations(graph: ContentGraph, options: MonadTypeOption): MonadViolation[] {
	type ViolationRecord = { violation: MonadViolation; owner: CGType | null }
	const violations: ViolationRecord[] = []
	const settingsPath = normalizeTypePath(options.path)

	const monadInfo = new Map(
		graph.types
			.values()
			.filter(t => normalizeTypePath(t.scope.path) === settingsPath && t.kind === "typeAlias")
			.map(t => [t.name, t]),
	)

	const monadClass = monadInfo.get(options.name)

	const monadConstructor = monadInfo.get(options.constructorName)
	const monadReader = monadInfo.get(options.readerName)
	const monadConsumer = monadInfo.get(options.consumerName)

	if (options.strictMonadModule) {
		if (
			!monadClass?.declaration ||
			!monadConstructor?.declaration ||
			!monadReader?.declaration ||
			!monadConsumer?.declaration
		)
			never()
	}

	if (!monadClass) return []

	function related(
		...items: (
			| {
					message?: string
					position?: CGPosition
					path?: string
			  }
			| null
			| undefined
		)[]
	): MonadViolation["related"] {
		const normalized = items.flatMap(item =>
			item?.position && item.path ? [{ message: item.message, position: item.position, path: item.path }] : [],
		)
		return normalized.length > 0 ? normalized : undefined
	}

	function findMonadConstraintFor(typeRef: CGType): {
		decl: { message: string; position: CGPosition; path: string } | null
		constraint: { message: string; position: CGPosition; path: string } | null
	} {
		const declarationCall = typeRef.declaration
		const declarationRoot = declarationCall?.parent
		const extendsCall = declarationRoot?.parent
		const constraintTarget = extendsCall?.arguments[1]
		if (!constraintTarget || constraintTarget.type.ref !== monadClass) return { decl: null, constraint: null }
		if (declarationCall?.position && declarationCall.scope.path) {
			return {
				decl: {
					message: `${typeRef.name} is declared here`,
					position: declarationCall.position,
					path: declarationCall.scope.path,
				},
				constraint: {
					message: `${typeRef.name} is constrained by ${monadClass.name} here`,
					position: constraintTarget.position,
					path: constraintTarget.scope.path,
				},
			}
		}
		return {
			decl: null,
			constraint: {
				message: `${typeRef.name} is constrained by ${monadClass.name} here`,
				position: constraintTarget.position,
				path: constraintTarget.scope.path,
			},
		}
	}

	const callToOwner = new Map(graph.types.values().flatMap(type => allCallsForType(type).map(call => [call, type])))

	const monadValueTypes = new Set<CGType>()

	if (monadConsumer && !monadConsumer.declaration) {
		monadValueTypes.add(monadConsumer)
	}
	if (monadConstructor && !monadConstructor.declaration) {
		monadValueTypes.add(monadConstructor)
	}

	for (const type of graph.types) {
		for (const [index, arg] of type.arguments.entries()) {
			if (arg.extends?.type.ref !== monadClass) continue
			if (index !== 0) {
				violations.push({
					owner: type,
					violation: {
						kind: "monad.invalidTypeParameterOrder",
						message: `Using ${arg.variable.name} here as a monad-marked type parameter is not allowed, because only the first generic parameter may extend ${monadClass.name}`,
						position: arg.variable.position,
						path: arg.variable.scope.path,
						related: related({
							message: type.arguments[0]
								? `Only the first generic parameter may extend ${monadClass.name}`
								: undefined,
							position: type.arguments[0]?.variable.position,
							path: type.arguments[0]?.variable.scope.path,
						}),
					},
				})
			}
			monadValueTypes.add(arg.variable.ref)
		}
	}

	for (const call of usages(monadClass)) {
		if (!isAllowedMonadClassMarkerUse(call)) {
			violations.push({
				owner: callToOwner.get(call) ?? null,
				violation: {
					kind: "monad.invalidMarkerUsage",
					message: `Using ${call.type.name} here is not allowed, because ${call.type.name} is only a marker type. It may be used only as an extends-constraint target (for example, T extends ${call.type.name}, including [infer T extends ${call.type.name}, ...]) and not as a standalone value type`,
					position: call.position,
					path: call.scope.path,
					related: related({
						message: `${monadClass.name} marker declaration is here`,
						position: monadClass.position,
						path: monadClass.scope.path,
					}),
				},
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

	for (const type of graph.types) {
		for (const arg of type.arguments) {
			const defaultCall = arg.default
			if (!defaultCall) continue
			const badDefaultUse = Array.from(allCalls(defaultCall)).find(
				call => call.type.ref === monadClass || monadValueTypes.has(call.type.ref),
			)
			if (!badDefaultUse) continue
			const monadConstraint = findMonadConstraintFor(badDefaultUse.type.ref)
			violations.push({
				owner: type,
				violation: {
					kind: "monad.invalidTypeParameterDefault",
					message: `Using ${badDefaultUse.type.name} in a type parameter default is not allowed, because monad marker and monad value types cannot appear in generic defaults`,
					position: badDefaultUse.position,
					path: badDefaultUse.scope.path,
					related: related(
						{
							message: "Type parameter declaration is here",
							position: arg.variable.position,
							path: arg.variable.scope.path,
						},
						monadConstraint.constraint,
					),
				},
			})
		}
	}

	const consumerTypes = new Set<CGType>()
	if (monadConsumer) consumerTypes.add(monadConsumer)
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
		const monadInputArg = consumerType.arguments.find(arg => arg.extends?.type.ref === monadClass) ?? null
		for (const branch of branches) {
			if (isAllowedConsumerBranch(branch)) continue
			const sourceReturn = body(branch.type.ref)
			const sourceRelated =
				sourceReturn && branch.type.ref !== consumerType
					? {
							message: `${branch.type.name} return source is here`,
							position: sourceReturn.position,
							path: sourceReturn.scope.path,
						}
					: null
			violations.push({
				owner: consumerType,
				violation: {
					kind: "monad.incompatibleTypes",
					message:
						branches.length > 1
							? `This branch of ${consumerType.name} is not allowed, because a user type that accepts monad input must return [monad, result] or never in every branch`
							: `Return type of ${consumerType.name} is not allowed, because a user type that accepts monad input must return [monad, result] or never`,
					position: branch.position,
					path: branch.scope.path,
					related: related(
						{
							message: `${consumerType.name} accepts monad input via this constraint`,
							position: monadInputArg?.extends?.position ?? consumerType.position,
							path: monadInputArg?.extends?.scope.path ?? consumerType.scope.path,
						},
						sourceRelated,
					),
				},
			})
		}
	}

	for (const consumerType of consumerTypes) {
		for (const call of usages(consumerType)) {
			if (isAllowedConsumerInvocation(call)) continue
			violations.push({
				owner: callToOwner.get(call) ?? consumerType,
				violation: {
					kind: "monad.invalidConsumerInvocation",
					message: `Using consumer ${consumerType.name} here is not allowed. It must be either in terminal return position of another consumer, or as the immediate left side of extends with a tuple pattern on the right side like [infer ... extends ${monadClass.name}, result]`,
					position: call.position,
					path: call.scope.path,
					related: related({
						message: `${consumerType.name} is declared here`,
						position: consumerType.position,
						path: consumerType.scope.path,
					}),
				},
			})
		}
	}

	const userProducerTypes = new Set(Array.from(userMonadInputTypes).filter(type => tupleReturnTypes.has(type)))

	for (const producerType of userProducerTypes) {
		for (const call of usages(producerType)) {
			if (isProducerConditionalPatternError(call)) {
				const wrongPattern = call.parent?.arguments[1]
				violations.push({
					owner: callToOwner.get(call) ?? producerType,
					violation: {
						kind: "monad.invalidProducerPattern",
						message: `Using producer ${producerType.name} here is not allowed, because conditional destructuring must use a right-side tuple pattern like [infer M2 extends ${monadClass.name}, infer R2]`,
						position: call.position,
						path: call.scope.path,
						related: related(
							{
								message: `${producerType.name} is declared here`,
								position: producerType.position,
								path: producerType.scope.path,
							},
							{
								message: "Wrong destructuring pattern is here",
								position: wrongPattern?.position,
								path: wrongPattern?.scope.path,
							},
						),
					},
				})
				continue
			}
			if (isAllowedUserProducerInvocation(call)) continue
			violations.push({
				owner: callToOwner.get(call) ?? producerType,
				violation: {
					kind: "monad.invalidProducerInvocation",
					message: `Using producer ${producerType.name} here is not allowed. A user producer call must be either in immediate terminal return position of another user producer, or as the immediate left side of conditional extends with a tuple pattern like [infer M2 extends ${monadClass.name}, infer R2]`,
					position: call.position,
					path: call.scope.path,
					related: related({
						message: `${producerType.name} is declared here`,
						position: producerType.position,
						path: producerType.scope.path,
					}),
				},
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
			if (parent.arguments[0] !== call || !hasMonadInput(parent.type.ref)) {
				const calleeType = parent.type.ref
				const firstArg = calleeType.arguments[0]
				let relatedMessage =
					parent.arguments[0] !== call
						? "The first argument slot is here"
						: firstArg
							? `${calleeType.name}'s first generic parameter is declared here`
							: undefined
				let relatedPosition =
					parent.arguments[0] !== call ? parent.arguments[0]?.position : firstArg?.variable.position
				let relatedPath =
					parent.arguments[0] !== call ? parent.arguments[0]?.scope.path : firstArg?.variable.scope.path
				const monadConstraint = findMonadConstraintFor(call.type.ref)
				violations.push({
					owner: callToOwner.get(call) ?? null,
					violation: {
						kind: monadArgumentUsageKind(parent),
						message: monadUsageErrorMessage(call, parent),
						position: call.position,
						path: call.scope.path,
						related: related(
							{
								message: relatedMessage,
								position: relatedPosition,
								path: relatedPath,
							},
							monadConstraint.constraint,
						),
					},
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
				prev =>
					prev.type.ref === call.type.ref &&
					(scopeContains(prev.scope, call.scope) || sharesConditionalConditionPath(prev, call)),
			)
			if (previous) {
				const monadConstraint = findMonadConstraintFor(call.type.ref)
				violations.push({
					owner: callToOwner.get(call) ?? null,
					violation: {
						kind: "monad.multipleConsumption",
						message: `Using monad ${call.type.name} here is not allowed, because this evaluation path already consumed it earlier. Only ${options.readerName} may read the same monad multiple times`,
						position: call.position,
						path: call.scope.path,
						related: related(
							{
								message: `The same evaluation path already consumed ${call.type.name} here`,
								position: previous.position,
								path: previous.scope.path,
							},
							monadConstraint.constraint,
						),
					},
				})
				continue
			}
			seenInBranch.push(call)
		}
	}

	const ownerKinds = new Map<CGType, Set<string>>()
	const ownerViolations = new Map<CGType, MonadViolation[]>()
	for (const record of violations) {
		if (!record.owner) continue
		if (!ownerKinds.has(record.owner)) ownerKinds.set(record.owner, new Set())
		ownerKinds.get(record.owner)!.add(record.violation.kind)
		if (!ownerViolations.has(record.owner)) ownerViolations.set(record.owner, [])
		ownerViolations.get(record.owner)!.push(record.violation)
	}

	return compactViolations(
		violations
			.filter(record => {
				if (!record.owner) return true
				const kinds = ownerKinds.get(record.owner)
				if (!kinds) return true
				const kind = record.violation.kind

				// Focus on generic parameter-order root cause for this declaration.
				if (kinds.has("monad.invalidTypeParameterOrder")) {
					return kind === "monad.invalidTypeParameterOrder"
				}
				if (kinds.has("monad.invalidTypeParameterDefault")) {
					return kind === "monad.invalidTypeParameterDefault"
				}

				// If invocation structure is wrong, branch-shape incompatibility is derivative noise.
				if (
					kind === "monad.incompatibleTypes" &&
					(kinds.has("monad.invalidProducerPattern") ||
						kinds.has("monad.invalidProducerInvocation") ||
						kinds.has("monad.invalidConsumerInvocation"))
				) {
					return false
				}

				// If producer conditional pattern is wrong, marker-use error in that same declaration is derivative.
				if (kind === "monad.invalidMarkerUsage" && kinds.has("monad.invalidProducerPattern")) {
					return false
				}

				// If "consumed twice" is present, hide generic context-level monad usage diagnostics in that declaration.
				if (kind === "monad.invalidMonadUsageContext" && kinds.has("monad.multipleConsumption")) {
					return false
				}

				// If monad argument-position misuse is present, producer-invocation error is derivative noise.
				if (kind === "monad.invalidProducerInvocation" && kinds.has("monad.invalidMonadUsageContext")) {
					const ownerMessages = ownerViolations.get(record.owner) ?? []
					if (
						ownerMessages.some(
							v =>
								v.kind === "monad.invalidMonadUsageContext" &&
								v.message.includes("first generic parameter is monad-bound"),
						)
					) {
						return false
					}
				}

				return true
			})
			.map(record => record.violation),
	)

	function terminalReturns(type: CGType): CGCall[] {
		return Array.from(returns(body(type)))
	}

	function isTupleWithMonadResult(call: CGCall): boolean {
		return (
			(call.type.name === "<tuple>" || call.type.name === "<readonlyTuple>") &&
			call.arguments.length === 2 &&
			isMonadValueCall(call.arguments[0]!)
		)
	}

	function isAllowedConsumerBranch(call: CGCall): boolean {
		return call.type.name === "never" || isTupleWithMonadResult(call) || tupleReturnTypes.has(call.type.ref)
	}

	function isMonadValueCall(call: CGCall): boolean {
		return monadValueTypes.has(call.type.ref)
	}

	function isAllowedConsumerInvocation(call: CGCall): boolean {
		if (consumerTypeInTupleHead(call)) return true
		if (consumerPassedToUserMonadInputAsFirstArg(call)) return true
		if (consumerInFirstTupleItemOnConditionalExtendsLeft(call)) return true
		const owner = callToOwner.get(call)
		if (monadConsumer && owner === monadConsumer && terminalReturns(owner).some(ret => ret === call)) return true
		if (call.parent?.type.name !== "<extends>" || call.parent.arguments[0] !== call) return false
		return isTupleWithConfiguredMonadPattern(call.parent.arguments[1] ?? null)
	}

	function isAllowedUserProducerInvocation(call: CGCall): boolean {
		if (isProducerReturnedImmediatelyByProducer(call)) return true
		if (isProducerImmediatelyDestructuredInConditional(call)) return true
		return false
	}

	function isProducerConditionalPatternError(call: CGCall): boolean {
		if (call.parent?.type.name !== "<extends>" || call.parent.arguments[0] !== call) return false
		if (call.parent.parent?.type.name !== "<conditional>" || call.parent.parent.arguments[0] !== call.parent)
			return false
		return !isInferMonadTupleDestructurePattern(call.parent.arguments[1] ?? null)
	}

	function isProducerReturnedImmediatelyByProducer(call: CGCall): boolean {
		const owner = callToOwner.get(call)
		if (!owner || !userProducerTypes.has(owner)) return false
		return terminalReturns(owner).some(ret => ret === call)
	}

	function isProducerImmediatelyDestructuredInConditional(call: CGCall): boolean {
		if (call.parent?.type.name !== "<extends>" || call.parent.arguments[0] !== call) return false
		if (call.parent.parent?.type.name !== "<conditional>" || call.parent.parent.arguments[0] !== call.parent)
			return false
		return isInferMonadTupleDestructurePattern(call.parent.arguments[1] ?? null)
	}

	function isInferMonadTupleDestructurePattern(call: CGCall | null): boolean {
		if (!call || !(call.type.name === "<tuple>" || call.type.name === "<readonlyTuple>")) return false
		if (call.arguments.length < 2) return false
		const first = call.arguments[0]
		if (!first || first.type.name !== "<extends>") return false
		const firstLeft = first.arguments[0]
		if (!firstLeft || firstLeft.type.name !== "<typeDeclaration>") return false
		return first.arguments[1]?.type.ref === monadClass
	}

	function monadUsageErrorMessage(call: CGCall, parent: CGCall): string {
		if (parent.type.name === "<indexedAccess>") {
			return `Using monad ${call.type.name} here is not allowed, because indexed access cannot consume monad values`
		}
		if (parent.type.name === "<typeOperator>" || parent.type.name === "<syntax>") {
			return `Using monad ${call.type.name} here is not allowed, because this syntax form cannot consume monad values`
		}
		if (parent.type.name === "<tuple>" || parent.type.name === "<readonlyTuple>") {
			return `Using monad ${call.type.name} here is not allowed, because tuple usage is allowed only for [monad, result] consumer returns`
		}
		if (parent.type.name === "<object>" || parent.type.name === "<pair>" || parent.type.name === "<readonlyPair>") {
			return `Using monad ${call.type.name} here is not allowed, because object wrappers cannot consume monad values`
		}
		return `Using monad ${call.type.name} here is not allowed. Allowed forms are: (1) pass it as the first argument of a type whose first generic parameter is monad-bound; (2) return it as the first item of a [monad, result] tuple`
	}

	function monadArgumentUsageKind(parent: CGCall): string {
		return "monad.invalidMonadUsageContext"
	}

	function monadUsageContextMessage(parent: CGCall): string {
		if (parent.type.name === "<indexedAccess>") return "Indexed access usage context is here"
		if (parent.type.name === "<typeOperator>" || parent.type.name === "<syntax>")
			return "This syntax usage context is here"
		if (parent.type.name === "<tuple>" || parent.type.name === "<readonlyTuple>")
			return "Tuple usage context is here"
		if (parent.type.name === "<object>" || parent.type.name === "<pair>" || parent.type.name === "<readonlyPair>")
			return "Object usage context is here"
		return "Usage context is here"
	}

	function isTupleWithConfiguredMonadPattern(call: CGCall | null): boolean {
		if (
			!call ||
			!(call.type.name === "<tuple>" || call.type.name === "<readonlyTuple>") ||
			call.arguments.length < 1
		)
			return false
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
		if (call.type.ref === monadConsumer) return true
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
				(call.parent.parent?.type.name === "<tuple>" || call.parent.parent?.type.name === "<readonlyTuple>") &&
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
		if (!(call.parent?.type.name === "<tuple>" || call.parent?.type.name === "<readonlyTuple>")) return false
		if (call.parent.arguments[0] !== call) return false
		const owner = callToOwner.get(call.parent)
		if (!owner || !(owner === monadConsumer || hasMonadInput(owner))) return false
		return terminalReturns(owner).some(ret => ret === call.parent)
	}

	function consumerTypeInTupleHead(call: CGCall): boolean {
		if (call.type.ref !== monadConsumer) return false
		if (!(call.parent?.type.name === "<tuple>" || call.parent?.type.name === "<readonlyTuple>")) return false
		if (call.parent.arguments[0] !== call) return false
		const owner = callToOwner.get(call.parent)
		if (!owner || !(owner === monadConsumer || hasMonadInput(owner))) return false
		return terminalReturns(owner).some(ret => ret === call.parent)
	}

	function consumerPassedToUserMonadInputAsFirstArg(call: CGCall): boolean {
		if (call.type.ref !== monadConsumer) return false
		if (!call.parent || call.parent.arguments[0] !== call) return false
		const calleeType = call.parent.type.ref
		return hasMonadInput(calleeType)
	}

	function consumerInFirstTupleItemOnConditionalExtendsLeft(call: CGCall): boolean {
		if (call.type.ref !== monadConsumer) return false
		if (
			!(call.parent?.type.name === "<tuple>" || call.parent?.type.name === "<readonlyTuple>") ||
			call.parent.arguments[0] !== call
		)
			return false
		const extendsCall = call.parent.parent
		if (!extendsCall || extendsCall.type.name !== "<extends>" || extendsCall.arguments[0] !== call.parent)
			return false
		return isTupleWithConfiguredMonadPattern(extendsCall.arguments[1] ?? null)
	}

	function hasMonadInput(type: CGType): boolean {
		if (type === monadConsumer && !monadConsumer.declaration) return true
		if (type === monadReader && !monadReader.declaration) return true
		return type.arguments[0]?.extends?.type.ref === monadClass
	}

	function sharesConditionalConditionPath(left: CGCall, right: CGCall): boolean {
		const leftSlot = nearestConditionalSlot(left)
		const rightSlot = nearestConditionalSlot(right)
		if (!leftSlot || !rightSlot) return false
		if (leftSlot.conditional !== rightSlot.conditional) return false
		return (
			(leftSlot.slot === 0 && (rightSlot.slot === 1 || rightSlot.slot === 2)) ||
			(rightSlot.slot === 0 && (leftSlot.slot === 1 || leftSlot.slot === 2))
		)
	}

	function nearestConditionalSlot(call: CGCall): { conditional: CGCall; slot: number } | null {
		let current: CGCall | null = call
		while (current?.parent) {
			if (current.parent.type.name === "<conditional>") {
				const slot = current.parent.arguments.indexOf(current)
				return slot < 0 ? null : { conditional: current.parent, slot }
			}
			current = current.parent
		}
		return null
	}
}

function compactViolations(violations: MonadViolation[]): MonadViolation[] {
	const unique = new Map<string, MonadViolation>()
	for (const violation of violations) {
		const key = [
			violation.kind,
			violation.path,
			violation.position.start,
			violation.position.end,
			violation.message,
		].join("::")
		if (!unique.has(key)) unique.set(key, violation)
	}

	const reduced = suppressGenericBranchViolations(Array.from(unique.values()))

	const groupedBySpan = Map.groupBy(reduced.values(), violation =>
		[violation.path, violation.position.start, violation.position.end].join("::"),
	)

	return Array.from(groupedBySpan.values())
		.flatMap(group =>
			group
				.sort((left: MonadViolation, right: MonadViolation) => violationRank(left) - violationRank(right))
				.slice(0, 1),
		)
		.sort((left, right) => {
			if (left.path !== right.path) return left.path.localeCompare(right.path)
			if (left.position.start !== right.position.start) return left.position.start - right.position.start
			if (left.position.end !== right.position.end) return left.position.end - right.position.end
			return violationRank(left) - violationRank(right)
		})
}

function suppressGenericBranchViolations(violations: MonadViolation[]): MonadViolation[] {
	return violations.filter(violation => {
		if (violation.kind !== "monad.incompatibleTypes") return true
		return !violations.some(candidate => {
			if (candidate === violation) return false
			if (!candidate.kind.startsWith("monad.invalid")) return false
			if (candidate.path !== violation.path) return false
			return (
				candidate.position.start >= violation.position.start && candidate.position.end <= violation.position.end
			)
		})
	})
}

function violationRank(violation: MonadViolation): number {
	if (violation.message.includes("already consumed it earlier")) return 0
	if (violation.message.startsWith("Using producer ")) return 1
	if (violation.message.startsWith("Using consumer ")) return 1
	if (violation.message.includes("only the first generic parameter may extend")) return 1
	if (violation.message.includes("is only a marker type")) return 2
	switch (violation.kind) {
		case "monad.multipleConsumption":
			return 0
		case "monad.invalidProducerPattern":
		case "monad.invalidProducerInvocation":
		case "monad.invalidConsumerInvocation":
		case "monad.invalidTypeParameterOrder":
		case "monad.invalidTypeParameterDefault":
			return 1
		case "monad.invalidMarkerUsage":
		case "monad.invalidMonadUsageContext":
			return 2
		case "monad.incompatibleTypes":
			return 3
		default:
			return violation.kind.startsWith("monad.invalid") ? 4 : 5
	}
}

function normalizeTypePath(path: string): string {
	return path
		.replaceAll("\\", "/")
		.replace(/^\.\/+/, "")
		.replaceAll(/\/+/g, "/")
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
