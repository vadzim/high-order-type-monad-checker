import type {
	BorrowViolationsOptions,
	OpaqueArgConstraint,
	BorrowViolation,
	ForcedTypeArgumentOption,
} from "./types.ts"
import type { Position, Scope } from "./parseTypes.ts"
import type { ParseTypesResult } from "./parseTypes.ts"

// borrowChecker responsibility boundary:
// - resolve forced reader/consumer options into concrete slots
// - evaluate borrow rules over parseTypes output
// - emit violations only (no CLI/output formatting concerns)

export function getBorrowViolations(input: ParseTypesResult, options: BorrowViolationsOptions = {}): BorrowViolation[] {
	// console.log("getOpaqueViolations", options)

	if (!options.opaqueTypes?.length) {
		throw new Error("getOpaqueViolations requires at least one opaque type in options.opaqueTypes.")
	}
	const violations: BorrowViolation[] = []

	const typeById = input.types
	const typeNameById = new Map(input.types.values().map(t => [t.id, t.name]))
	const declarationTypeById = new Map(
		input.types
			.values()
			.filter(t => t.kind === "typeAlias")
			.map(t => [t.id, t] as const),
	)
	const declarationTypeIdByScopeId = new Map([...declarationTypeById.values()].map(t => [t.scopeId, t.id] as const))
	const declarationTypeIdByPathAndName = new Map<string, string>()
	const importedTypeIdsByRefPathAndName = new Map<string, string[]>()
	const pathNameKey = (path: string, name: string) => `${path}::${name}`
	for (const parsedType of input.types.values()) {
		if (parsedType.kind !== "typeAlias" && parsedType.kind !== "interface" && parsedType.kind !== "class") continue
		const key = pathNameKey(parsedType.path, parsedType.name)
		if (!declarationTypeIdByPathAndName.has(key)) {
			declarationTypeIdByPathAndName.set(key, parsedType.id)
		}
	}
	for (const parsedType of input.types.values()) {
		if (parsedType.kind !== "imported") continue
		const referencedName = parsedType.refName ?? parsedType.name
		const curr = importedTypeIdsByRefPathAndName.get(pathNameKey(parsedType.refPath, referencedName)) ?? []
		curr.push(parsedType.id)
		importedTypeIdsByRefPathAndName.set(pathNameKey(parsedType.refPath, referencedName), curr)
	}
	const actualDeclarationTypeIdByTypeId = new Map<string, string>()
	for (const parsedType of input.types.values()) {
		if (parsedType.kind === "imported") {
			const referencedName = parsedType.refName ?? parsedType.name
			const actualId = declarationTypeIdByPathAndName.get(pathNameKey(parsedType.refPath, referencedName))
			actualDeclarationTypeIdByTypeId.set(parsedType.id, actualId ?? parsedType.id)
		} else {
			actualDeclarationTypeIdByTypeId.set(parsedType.id, parsedType.id)
		}
	}
	const toActualDeclarationTypeId = (typeId: string): string => actualDeclarationTypeIdByTypeId.get(typeId) ?? typeId
	const optionDeclarationTypeIdFor = (path: string, name: string): string | undefined => {
		const declared = declarationTypeIdByPathAndName.get(pathNameKey(path, name))
		if (declared) return declared
		const importedIds = importedTypeIdsByRefPathAndName.get(pathNameKey(path, name)) ?? []
		return importedIds[0]
	}
	const forcedOptionKey = (path: string, name: string, index: number) => `${path}::${name}:${index}`
	const resolvedForcedReaders = resolveForcedTypeArguments([input], options.forcedReaders ?? [])
	const resolvedForcedConsumers = resolveForcedTypeArguments([input], options.forcedConsumers ?? [])
	const unresolvedForcedSlotOptionKeys = new Set<string>()
	const unresolvedForcedReaderOptionKeys = new Set<string>()
	const unresolvedForcedConsumerOptionKeys = new Set<string>()
	const resolvedForcedEntries: Array<{
		kind: "reader" | "consumer"
		path: string
		name: string
		index: number
		declarationTypeId: string
	}> = []
	const forcedReaderSlotKeys = new Set<string>()
	for (const reader of resolvedForcedReaders) {
		const declarationTypeId = optionDeclarationTypeIdFor(reader.path, reader.name)
		if (!declarationTypeId) {
			unresolvedForcedSlotOptionKeys.add(forcedOptionKey(reader.path, reader.name, reader.index))
			unresolvedForcedReaderOptionKeys.add(forcedOptionKey(reader.path, reader.name, reader.index))
			continue
		}
		forcedReaderSlotKeys.add(slotKey(declarationTypeId, reader.index))
		resolvedForcedEntries.push({
			kind: "reader",
			path: reader.path,
			name: reader.name,
			index: reader.index,
			declarationTypeId,
		})
	}
	const forcedConsumerSlotKeys = new Set<string>()
	for (const consumer of resolvedForcedConsumers) {
		const declarationTypeId = optionDeclarationTypeIdFor(consumer.path, consumer.name)
		if (!declarationTypeId) {
			unresolvedForcedSlotOptionKeys.add(forcedOptionKey(consumer.path, consumer.name, consumer.index))
			unresolvedForcedConsumerOptionKeys.add(forcedOptionKey(consumer.path, consumer.name, consumer.index))
			continue
		}
		forcedConsumerSlotKeys.add(slotKey(declarationTypeId, consumer.index))
		resolvedForcedEntries.push({
			kind: "consumer",
			path: consumer.path,
			name: consumer.name,
			index: consumer.index,
			declarationTypeId,
		})
	}
	const explicitOpaqueTypeIds = new Set<string>()
	for (const opaque of options.opaqueTypes ?? []) {
		const declarationTypeId = optionDeclarationTypeIdFor(opaque.path, opaque.name)
		if (!declarationTypeId) continue
		explicitOpaqueTypeIds.add(declarationTypeId)
	}
	const resolveConstraintIdentityTypeId = (typeId: string): string | undefined => {
		let cursor = toActualDeclarationTypeId(typeId)
		const visited = new Set<string>()
		while (true) {
			if (visited.has(cursor)) return undefined
			visited.add(cursor)
			const cursorType = typeById.get(cursor)
			if (!cursorType) return cursor
			if (cursorType.kind !== "typeParameter") return cursor
			const next = cursorType.extends?.typeId
			if (!next) return cursor
			cursor = toActualDeclarationTypeId(next)
		}
	}
	const constraintIdentityName = (path: string, typeId: string): string | undefined => {
		const identityTypeId = resolveConstraintIdentityTypeId(typeId)
		if (!identityTypeId) return undefined
		if (!explicitOpaqueTypeIds.has(identityTypeId)) return undefined
		return typeNameById.get(identityTypeId)
	}

	const scopeById = input.scopes
	const childrenByScopeId = new Map<string, Scope[]>()
	for (const scope of input.scopes.values()) {
		if (!scope.parentScopeId) continue
		const curr = childrenByScopeId.get(scope.parentScopeId) ?? []
		curr.push(scope)
		childrenByScopeId.set(scope.parentScopeId, curr)
	}
	const extendsByDeclarationScopeId = new Map<string, Map<string, string>>()
	const inferExtendsByDeclarationTypeId = new Map<string, Map<string, { typeId?: string }>>()
	const opaqueInferVarsByDeclarationTypeId = new Map<
		string,
		Array<{ name: string; typeId: string; opaqueName: string }>
	>()
	for (const parsedType of input.types.values()) {
		if (!parsedType.extends?.typeId) continue
		if (parsedType.kind !== "typeParameter") continue
		const typeScope = scopeById.get(parsedType.scopeId)
		if (!typeScope || typeScope.kind !== "typeParameters" || !typeScope.parentScopeId) continue
		const declScopeId = typeScope.parentScopeId
		if (!extendsByDeclarationScopeId.has(declScopeId)) {
			extendsByDeclarationScopeId.set(declScopeId, new Map())
		}
		extendsByDeclarationScopeId.get(declScopeId)!.set(parsedType.name, parsedType.extends.typeId)
	}
	for (const parsedType of input.types.values()) {
		if (parsedType.kind !== "infer" || parsedType.extends === undefined) continue
		let scopeId: string | null | undefined = parsedType.scopeId
		let declarationTypeId: string | undefined
		while (scopeId) {
			const scope = scopeById.get(scopeId)
			if (!scope) break
			if (scope.kind === "declaration") {
				declarationTypeId = declarationTypeIdByScopeId.get(scope.id)
				break
			}
			scopeId = scope.parentScopeId
		}
		if (!declarationTypeId) continue
		if (!inferExtendsByDeclarationTypeId.has(declarationTypeId)) {
			inferExtendsByDeclarationTypeId.set(declarationTypeId, new Map())
		}
		inferExtendsByDeclarationTypeId.get(declarationTypeId)!.set(parsedType.name, parsedType.extends)
		const opaqueName = parsedType.extends.typeId
			? constraintIdentityName(parsedType.path, parsedType.extends.typeId)
			: undefined
		if (!opaqueName) continue
		if (!opaqueInferVarsByDeclarationTypeId.has(declarationTypeId)) {
			opaqueInferVarsByDeclarationTypeId.set(declarationTypeId, [])
		}
		opaqueInferVarsByDeclarationTypeId.get(declarationTypeId)!.push({
			name: parsedType.name,
			typeId: parsedType.id,
			opaqueName,
		})
	}
	const isOpaqueTypeForPath = (_path: string, typeId: string): boolean => {
		const actualTypeId = toActualDeclarationTypeId(typeId)
		return explicitOpaqueTypeIds.has(actualTypeId)
	}

	const declarationTypeParams = (declarationId: string): Array<{ name: string; extendsTypeId?: string }> => {
		const declType = typeById.get(declarationId)
		if (!declType?.arguments?.length) return []
		const out: Array<{ name: string; extendsTypeId?: string }> = []
		for (const arg of declType.arguments) {
			const paramType = typeById.get(arg.typeId)
			if (!paramType) continue
			out.push({ name: paramType.name, extendsTypeId: paramType.extends?.typeId })
		}
		return out
	}

	const declarationSubtreeScopes = (declarationScopeId: string): Scope[] => {
		const out: Scope[] = []
		const stack = [declarationScopeId]
		while (stack.length) {
			const id = stack.pop()
			if (!id) continue
			const scope = scopeById.get(id)
			if (!scope) continue
			out.push(scope)
			for (const child of childrenByScopeId.get(id) ?? []) {
				stack.push(child.id)
			}
		}
		return out
	}

	const genericOpaqueConstraints = new Map<string, string[]>()
	for (const declType of declarationTypeById.values()) {
		const extendsByParamName = extendsByDeclarationScopeId.get(declType.scopeId) ?? new Map<string, string>()
		for (const tp of declarationTypeParams(declType.id)) {
			const extendsTypeId = extendsByParamName.get(tp.name)
			if (!extendsTypeId) continue
			const extendsTypeName = constraintIdentityName(declType.path, extendsTypeId)
			if (!extendsTypeName) continue
			if (!genericOpaqueConstraints.has(declType.name)) genericOpaqueConstraints.set(declType.name, [])
			genericOpaqueConstraints.get(declType.name)!.push(extendsTypeName)
		}
	}

	const contexts = new Map<string, DeclarationContext>()
	for (const declType of declarationTypeById.values()) {
		const opaqueVars = new Map<string, string>()
		const opaqueVarTypeIds = new Set<string>()
		const nonConsumingReferenceKeys = new Set<string>()
		const relatedOpaqueTypeIdsByTypeId = new Map<string, Set<string>>()
		const ensureNode = (typeId: string) => {
			if (!relatedOpaqueTypeIdsByTypeId.has(typeId)) {
				relatedOpaqueTypeIdsByTypeId.set(typeId, new Set())
			}
		}
		const linkRelated = (a: string, b: string) => {
			ensureNode(a)
			ensureNode(b)
			relatedOpaqueTypeIdsByTypeId.get(a)!.add(b)
			relatedOpaqueTypeIdsByTypeId.get(b)!.add(a)
		}
		const declarationParamTypeByName = new Map<string, string>()
		for (const arg of declType.arguments ?? []) {
			const t = typeById.get(arg.typeId)
			if (!t) continue
			declarationParamTypeByName.set(t.name, t.id)
		}
		const extendsByParamName = extendsByDeclarationScopeId.get(declType.scopeId) ?? new Map<string, string>()
		for (const tp of declarationTypeParams(declType.id)) {
			const extendsTypeId = extendsByParamName.get(tp.name)
			const tpTypeId = declarationParamTypeByName.get(tp.name)
			const tpType = tpTypeId ? typeById.get(tpTypeId) : undefined
			let extendsTypeName = extendsTypeId ? constraintIdentityName(declType.path, extendsTypeId) : undefined
			if (!extendsTypeName && tpType?.constraintPosition) {
				const tpScope = scopeById.get(tpType.scopeId)
				const opaqueRef = tpScope?.references.find(ref => {
					if (ref.position.start < tpType.constraintPosition!.start) return false
					if (ref.position.end > tpType.constraintPosition!.end) return false
					return Boolean(constraintIdentityName(declType.path, ref.typeId))
				})
				if (opaqueRef) {
					extendsTypeName = constraintIdentityName(declType.path, opaqueRef.typeId)
				}
			}
			if (!extendsTypeName) continue
			opaqueVars.set(tp.name, extendsTypeName)
			if (tpTypeId) {
				opaqueVarTypeIds.add(tpTypeId)
				ensureNode(tpTypeId)
			}
		}
		for (const inferVar of opaqueInferVarsByDeclarationTypeId.get(declType.id) ?? []) {
			opaqueVars.set(inferVar.name, inferVar.opaqueName)
			opaqueVarTypeIds.add(inferVar.typeId)
			ensureNode(inferVar.typeId)
		}
		const declarationScopeIds = new Set(declarationSubtreeScopes(declType.scopeId).map(scope => scope.id))
		const declarationConditionalScopes = [...declarationScopeIds]
			.map(id => scopeById.get(id))
			.filter((scope): scope is Scope => Boolean(scope && scope.kind === "conditional"))
		for (const conditionalScope of declarationConditionalScopes) {
			const checkRange = conditionalScope.conditionalCheckPosition
			const extendsRange = conditionalScope.conditionalExtendsPosition
			if (!checkRange || !extendsRange) continue
			const isReferenceConsumedInCheck = (ref: { typeId: string; position: Position }): boolean => {
				const containingCalls = conditionalScope.calls
					.flatMap(call =>
						call.arguments.map((arg, idx) => ({
							call,
							idx,
							arg,
							contains: arg.position.start <= ref.position.start && arg.position.end >= ref.position.end,
						})),
					)
					.filter(x => x.contains)
					.sort(
						(a, b) =>
							a.arg.position.end - a.arg.position.start - (b.arg.position.end - b.arg.position.start),
					)
				for (const item of containingCalls) {
					const key = slotKey(toActualDeclarationTypeId(item.call.typeId), item.idx)
					if (forcedConsumerSlotKeys.has(key)) return true
					if (forcedReaderSlotKeys.has(key)) {
						const isDirectReaderArgument =
							item.arg.position.start === ref.position.start && item.arg.position.end === ref.position.end
						if (isDirectReaderArgument) return false
					}
				}
				return true
			}
			const inferOpaqueName = (inferType: {
				id: string
				scopeId: string
				path: string
				extends?: { typeId?: string }
				constraintPosition?: Position
			}): string | undefined => {
				const byDirectExtends = inferType.extends?.typeId
					? constraintIdentityName(declType.path, inferType.extends.typeId)
					: undefined
				if (byDirectExtends) return byDirectExtends
				if (!inferType.constraintPosition) return undefined
				const inferScope = scopeById.get(inferType.scopeId)
				const opaqueRef = inferScope?.references.find(ref => {
					if (ref.position.start < inferType.constraintPosition!.start) return false
					if (ref.position.end > inferType.constraintPosition!.end) return false
					return Boolean(constraintIdentityName(declType.path, ref.typeId))
				})
				const byRef = opaqueRef ? constraintIdentityName(declType.path, opaqueRef.typeId) : undefined
				if (byRef) return byRef
				const opaqueArg = inferScope?.calls
					.flatMap(call => call.arguments)
					.find(arg => {
						if (arg.position.start < inferType.constraintPosition!.start) return false
						if (arg.position.end > inferType.constraintPosition!.end) return false
						return Boolean(constraintIdentityName(declType.path, arg.typeId))
					})
				if (!opaqueArg) return undefined
				return constraintIdentityName(declType.path, opaqueArg.typeId)
			}
			const leftRefs = conditionalScope.references.filter(ref => {
				if (ref.position.start < checkRange.start || ref.position.end > checkRange.end) return false
				const type = typeById.get(ref.typeId)
				if (!type) return false
				if (type.kind !== "typeParameter" && type.kind !== "infer") return false
				return declarationScopeIds.has(type.scopeId)
			})
			if (!leftRefs.length) continue
			const leftConsumedRefs = leftRefs.filter(ref => isReferenceConsumedInCheck(ref))
			if (!leftConsumedRefs.length) continue
			const rightInferTypes = (childrenByScopeId.get(conditionalScope.id) ?? [])
				.filter(scope => scope.kind === "infer" && scope.name)
				.map(scope => {
					const inferType = input.types
						.values()
						.find(t => t.kind === "infer" && t.scopeId === scope.id && t.name === scope.name)
					return inferType
				})
				.filter((t): t is NonNullable<typeof t> => Boolean(t))
			const leftOpaqueNameResolved = leftConsumedRefs
				.map(ref => typeById.get(ref.typeId))
				.filter((type): type is NonNullable<typeof type> => Boolean(type))
				.map(type => opaqueVars.get(type.name))
				.find((name): name is string => Boolean(name))
			const rightOpaqueInfers = rightInferTypes
				.map(inferType => ({
					inferType,
					opaqueName: inferOpaqueName(inferType) ?? leftOpaqueNameResolved,
				}))
				.filter((x): x is { inferType: (typeof rightInferTypes)[number]; opaqueName: string } =>
					Boolean(x.opaqueName),
				)
			const rightOpaqueNameFromInfer = rightOpaqueInfers[0]?.opaqueName
			const rightOpaqueNameFromRefs = conditionalScope.references
				.filter(ref => ref.position.start >= extendsRange.start && ref.position.end <= extendsRange.end)
				.map(ref => constraintIdentityName(declType.path, ref.typeId))
				.find((name): name is string => Boolean(name))
			const rightOpaqueName = rightOpaqueNameFromInfer ?? rightOpaqueNameFromRefs
			if (!rightOpaqueName) continue
			const leftTypeIds: string[] = []
			for (const ref of leftConsumedRefs) {
				const leftType = typeById.get(ref.typeId)
				if (!leftType) continue
				const wasAlreadyOpaque = opaqueVarTypeIds.has(leftType.id)
				opaqueVars.set(leftType.name, rightOpaqueName)
				opaqueVarTypeIds.add(leftType.id)
				ensureNode(leftType.id)
				if (!wasAlreadyOpaque) {
					leftTypeIds.push(leftType.id)
					nonConsumingReferenceKeys.add(`${ref.typeId}:${ref.position.start}:${ref.position.end}`)
				}
			}
			const rightInferTypeIds: string[] = []
			for (const { inferType, opaqueName } of rightOpaqueInfers) {
				opaqueVars.set(inferType.name, opaqueName)
				opaqueVarTypeIds.add(inferType.id)
				ensureNode(inferType.id)
				rightInferTypeIds.push(inferType.id)
			}
			for (const inferTypeId of rightInferTypeIds) {
				for (const leftTypeId of leftTypeIds) {
					linkRelated(inferTypeId, leftTypeId)
				}
			}
			if (leftTypeIds.length > 0) {
				for (let i = 0; i < rightInferTypeIds.length; i++) {
					for (let j = i + 1; j < rightInferTypeIds.length; j++) {
						const a = rightInferTypeIds[i]
						const b = rightInferTypeIds[j]
						if (!a || !b) continue
						linkRelated(a, b)
					}
				}
			}
		}
		contexts.set(declType.id, {
			declType,
			subtreeScopes: declarationSubtreeScopes(declType.scopeId),
			opaqueVars,
			opaqueVarTypeIds,
			nonConsumingReferenceKeys,
			relatedOpaqueTypeIdsByTypeId,
		})
	}
	for (const forcedEntry of resolvedForcedEntries) {
		const declType = declarationTypeById.get(forcedEntry.declarationTypeId)
		if (!declType) continue
		const param = declarationTypeParams(declType.id)[forcedEntry.index]
		const extendsTypeId = param?.extendsTypeId
		const valid = Boolean(extendsTypeId && isOpaqueTypeForPath(declType.path, extendsTypeId))
		if (valid) continue
		violations.push({
			declarationId: declType.id,
			kind: "opaque.invalidGenericArgumentConstraint",
			message: `Generic '${declType.name}' does not expose matching opaque parameter for forced ${forcedEntry.kind} slot ${forcedEntry.index}.`,
			position: declType.position,
		})
	}
	const discoveredReaderSlots = propagateReaderKinds({
		contexts,
		forcedReaderSlotKeys,
		forcedConsumerSlotKeys,
		typeIdToActualDeclarationTypeId: actualDeclarationTypeIdByTypeId,
		typeById,
		typeNameById,
	})
	const isReaderArgument = (genericTypeId: string, argIndex: number): boolean => {
		const key = slotKey(genericTypeId, argIndex)
		if (forcedConsumerSlotKeys.has(key)) return false
		if (forcedReaderSlotKeys.has(key)) return true
		return discoveredReaderSlots.has(key)
	}
	const constraintResults = validateGenericConstraints({
		contexts,
		genericOpaqueConstraints,
		declarationTypeById,
		inferExtendsByDeclarationTypeId,
		typeIdToActualDeclarationTypeId: actualDeclarationTypeIdByTypeId,
		typeById,
		typeNameById,
		isReaderArgument,
		unresolvedForcedSlotOptionKeys,
		unresolvedForcedReaderOptionKeys,
		unresolvedForcedConsumerOptionKeys,
	})
	const pathViolations = collectPathViolations({
		contexts,
		isReaderArgument,
		scopeById,
		typeIdToActualDeclarationTypeId: actualDeclarationTypeIdByTypeId,
		typeById,
		typeNameById,
		unresolvedForcedReaderOptionKeys,
		unresolvedForcedConsumerOptionKeys,
	})
	violations.push(...pathViolations)
	for (const [declId, stage] of constraintResults.entries()) {
		const ctx = contexts.get(declId)
		if (!ctx) continue
		for (const invalidArg of stage.invalidOpaqueArguments) {
			const parameterIndex = Number(invalidArg.parameterName.replace(/^T/, ""))
			const parameterNumber = parameterIndex + 1
			const ordinalSuffix =
				Number.isInteger(parameterIndex) && parameterIndex >= 0
					? parameterNumber % 10 === 1 && parameterNumber % 100 !== 11
						? "st"
						: parameterNumber % 10 === 2 && parameterNumber % 100 !== 12
							? "nd"
							: parameterNumber % 10 === 3 && parameterNumber % 100 !== 13
								? "rd"
								: "th"
					: "th"
			const parameterOrdinal =
				Number.isInteger(parameterIndex) && parameterIndex >= 0
					? `${parameterNumber}${ordinalSuffix}`
					: "matching"
			violations.push({
				declarationId: ctx.declType.id,
				kind: "opaque.invalidGenericArgumentConstraint",
				message: `Type '${invalidArg.argumentName}' is opaque ('${invalidArg.opaqueName}'), so generic '${invalidArg.genericName}' must declare its ${parameterOrdinal} parameter as '${invalidArg.argumentName} extends ${invalidArg.opaqueName}'.`,
				position: invalidArg.position,
				relatedPosition: invalidArg.relatedPosition,
			})
		}
		for (const badInfer of stage.invalidOpaqueInferConstraints) {
			const isKnownOpaqueName = [...explicitOpaqueTypeIds]
				.map(typeId => typeNameById.get(typeId))
				.filter(Boolean)
				.includes(badInfer.opaqueName)
			if (isKnownOpaqueName) {
				violations.push({
					declarationId: ctx.declType.id,
					kind: "opaque.invalidInferConstraint",
					message: `Opaque type '${badInfer.opaqueName}' should not be used in infer constraint.`,
					position: badInfer.position,
				})
			}
		}
	}

	return violations
}

export function resolveForcedTypeArguments(
	_inputs: ParseTypesResult[],
	specs: ForcedTypeArgumentOption[],
): ForcedTypeArgumentOption[] {
	const seen = new Set<string>()
	const deduped: ForcedTypeArgumentOption[] = []
	for (const slot of specs) {
		const key = `${slot.path}:${slot.name}:${slot.index}`
		if (seen.has(key)) continue
		seen.add(key)
		deduped.push(slot)
	}
	return deduped
}

type UseInPath = {
	declarationId: string
	targetName: string
	targetTypeId: string
	scopeId: string
	wrappedByReaders: string[]
	wrappedByConsumers: string[]
	isDirectReaderArgument: boolean
	position: Position
}

type DeclarationContext = {
	declType: {
		id: string
		name: string
		path: string
		scopeId: string
		arguments?: Array<{ typeId: string }>
	}
	subtreeScopes: Scope[]
	opaqueVars: Map<string, string>
	opaqueVarTypeIds: Set<string>
	nonConsumingReferenceKeys: Set<string>
	relatedOpaqueTypeIdsByTypeId: Map<string, Set<string>>
}

type Stage1Result = {
	invalidOpaqueArguments: OpaqueArgConstraint[]
	invalidOpaqueInferConstraints: { opaqueName: string; position: Position }[]
}

type ValidateGenericConstraintsArgs = {
	contexts: Map<string, DeclarationContext>
	genericOpaqueConstraints: Map<string, string[]>
	declarationTypeById: Map<string, { arguments?: Array<{ typeId: string }> }>
	inferExtendsByDeclarationTypeId: Map<string, Map<string, { typeId?: string }>>
	typeIdToActualDeclarationTypeId: Map<string, string>
	typeById: Map<
		string,
		{
			name: string
			path: string
			refPath: string
			refName?: string
			kind: string
			position?: Position
		}
	>
	typeNameById: Map<string, string>
	isReaderArgument: (genericTypeId: string, index: number) => boolean
	unresolvedForcedSlotOptionKeys: Set<string>
	unresolvedForcedReaderOptionKeys: Set<string>
	unresolvedForcedConsumerOptionKeys: Set<string>
}

type PropagateReaderKindsArgs = {
	contexts: Map<string, DeclarationContext>
	forcedReaderSlotKeys: Set<string>
	forcedConsumerSlotKeys: Set<string>
	typeIdToActualDeclarationTypeId: Map<string, string>
	typeById: Map<string, { name: string; path: string; refPath: string; refName?: string; kind: string }>
	typeNameById: Map<string, string>
}

type CollectPathViolationsArgs = {
	contexts: Map<string, DeclarationContext>
	isReaderArgument: (genericTypeId: string, index: number) => boolean
	scopeById: Map<string, Scope>
	typeIdToActualDeclarationTypeId: Map<string, string>
	typeById: Map<string, { name: string; path: string; refPath: string; refName?: string; kind: string }>
	typeNameById: Map<string, string>
	unresolvedForcedReaderOptionKeys: Set<string>
	unresolvedForcedConsumerOptionKeys: Set<string>
}

function slotKey(genericTypeId: string, index: number): string {
	return `${genericTypeId}:${index}`
}

function isConsumerUse(use: UseInPath): boolean {
	return !use.isDirectReaderArgument
}

function validateGenericConstraints(args: ValidateGenericConstraintsArgs): Map<string, Stage1Result> {
	const out = new Map<string, Stage1Result>()
	const toActualDeclarationTypeId = (typeId: string): string =>
		args.typeIdToActualDeclarationTypeId.get(typeId) ?? typeId
	const declarationParamPosition = (callTypeId: string, index: number): Position | undefined => {
		const declarationTypeId = toActualDeclarationTypeId(callTypeId)
		const declarationType = args.declarationTypeById.get(declarationTypeId)
		const parameterTypeId = declarationType?.arguments?.[index]?.typeId
		if (!parameterTypeId) return undefined
		return args.typeById.get(parameterTypeId)?.position
	}
	const callForcedOptionKeys = (callTypeId: string, genericName: string, index: number): string[] => {
		const callType = args.typeById.get(callTypeId)
		if (!callType) return []
		const names =
			callType.refName && callType.refName !== genericName ? [genericName, callType.refName] : [genericName]
		const path = callType.kind === "imported" ? callType.refPath : callType.path
		return names.map(name => `${path}::${name}:${index}`)
	}
	for (const [declId, ctx] of args.contexts.entries()) {
		const invalidOpaqueArguments: OpaqueArgConstraint[] = []
		const invalidOpaqueInferConstraints: { opaqueName: string; position: Position }[] = []
		for (const scope of ctx.subtreeScopes) {
			for (const call of scope.calls) {
				const genericName = call.typeId.startsWith("global:")
					? call.typeId.slice("global:".length)
					: (args.typeNameById.get(call.typeId) ?? call.typeId)
				const targetOpaqueParams = args.genericOpaqueConstraints.get(genericName) ?? []
				call.arguments.forEach((arg, idx) => {
					if (!arg.typeId || arg.typeId.startsWith("global:")) return
					if (!ctx.opaqueVarTypeIds.has(arg.typeId)) return
					if (args.isReaderArgument(toActualDeclarationTypeId(call.typeId), idx)) return
					if (call.typeId.startsWith("global:")) return
					// If declaration is out of the current parsed set, don't enforce
					// generic opaque-constraint compatibility for this call.
					if (!args.declarationTypeById.has(toActualDeclarationTypeId(call.typeId))) return
					const forcedOptionKeys = callForcedOptionKeys(call.typeId, genericName, idx)
					if (forcedOptionKeys.some(key => args.unresolvedForcedReaderOptionKeys.has(key))) return
					if (forcedOptionKeys.some(key => args.unresolvedForcedConsumerOptionKeys.has(key))) return
					if (forcedOptionKeys.some(key => args.unresolvedForcedSlotOptionKeys.has(key))) return
					const argType = args.typeById.get(arg.typeId)
					if (!argType) return
					const opaqueName = ctx.opaqueVars.get(argType.name)
					if (!opaqueName) return
					const c: OpaqueArgConstraint = {
						genericName,
						parameterName: `T${idx}`,
						opaqueName,
						argumentName: argType.name,
						position: arg.position,
						relatedPosition: declarationParamPosition(call.typeId, idx),
					}
					if (targetOpaqueParams.length) {
						if (!targetOpaqueParams.includes(opaqueName)) invalidOpaqueArguments.push(c)
					} else {
						invalidOpaqueArguments.push(c)
					}
				})
			}
			const inferEntries = args.inferExtendsByDeclarationTypeId.get(declId)
			if (
				scope.kind === "infer" &&
				scope.name &&
				inferEntries?.get(scope.name) &&
				!inferEntries.get(scope.name)?.typeId
			) {
				for (const ref of scope.references) {
					const refName = args.typeNameById.get(ref.typeId)
					if (!refName) continue
					invalidOpaqueInferConstraints.push({ opaqueName: refName, position: ref.position })
				}
			}
		}
		out.set(declId, { invalidOpaqueArguments, invalidOpaqueInferConstraints })
	}
	return out
}

function propagateReaderKinds(args: PropagateReaderKindsArgs): Set<string> {
	const discoveredReaderSlots = new Set<string>()

	const pending = new Map<string, { ctx: DeclarationContext; opaqueArgTypeId: string }>()

	for (const ctx of args.contexts.values()) {
		for (const [index, arg] of (ctx.declType.arguments ?? []).entries()) {
			if (!ctx.opaqueVarTypeIds.has(arg.typeId)) continue
			const key = slotKey(ctx.declType.id, index)
			if (args.forcedConsumerSlotKeys.has(key)) continue
			if (args.forcedReaderSlotKeys.has(key)) {
				discoveredReaderSlots.add(key)
				continue
			}
			pending.set(key, {
				ctx,
				opaqueArgTypeId: arg.typeId,
			})
		}
	}

	while (pending.size > 0) {
		let changed = false
		for (const [key, candidate] of pending.entries()) {
			const isReaderArgument = (genericTypeId: string, argIndex: number): boolean => {
				if (discoveredReaderSlots.has(slotKey(genericTypeId, argIndex))) return true
				return false
			}
			const consumes = scopeConsumesOpaqueSlot(
				candidate.ctx,
				candidate.opaqueArgTypeId,
				isReaderArgument,
				args.typeIdToActualDeclarationTypeId,
				args.typeById,
				args.typeNameById,
			)
			if (!consumes) {
				discoveredReaderSlots.add(key)
				pending.delete(key)
				changed = true
			}
		}
		if (!changed) break
	}
	return discoveredReaderSlots
}

function collectPathViolations(args: CollectPathViolationsArgs): BorrowViolation[] {
	const toActualDeclarationTypeId = (typeId: string): string =>
		args.typeIdToActualDeclarationTypeId.get(typeId) ?? typeId
	const callForcedOptionKeys = (callTypeId: string, genericName: string, index: number): string[] => {
		const callType = args.typeById.get(callTypeId)
		if (!callType) return []
		const names =
			callType.refName && callType.refName !== genericName ? [genericName, callType.refName] : [genericName]
		const path = callType.kind === "imported" ? callType.refPath : callType.path
		return names.map(name => `${path}::${name}:${index}`)
	}
	const findFirstConsumeInScopeChain = (
		firstConsumeByScopeId: Map<string, Map<string, Position>>,
		scopeId: string,
		declarationScopeId: string,
		targetTypeId: string,
		relatedOpaqueTypeIdsByTypeId: Map<string, Set<string>>,
	): { position: Position; consumedTypeId: string } | undefined => {
		const isRelated = (otherTypeId: string): boolean => {
			if (otherTypeId === targetTypeId) return true
			return relatedOpaqueTypeIdsByTypeId.get(targetTypeId)?.has(otherTypeId) ?? false
		}
		let cursor: string | null | undefined = scopeId
		while (cursor) {
			for (const [consumedTypeId, pos] of firstConsumeByScopeId.get(cursor) ?? new Map<string, Position>()) {
				if (isRelated(consumedTypeId)) return { position: pos, consumedTypeId }
			}
			if (cursor === declarationScopeId) break
			cursor = args.scopeById.get(cursor)?.parentScopeId
		}
		return undefined
	}
	const rememberFirstConsume = (
		firstConsumeByScopeId: Map<string, Map<string, Position>>,
		scopeId: string,
		targetTypeId: string,
		position: Position,
	) => {
		const inScope = firstConsumeByScopeId.get(scopeId) ?? new Map<string, Position>()
		if (!inScope.has(targetTypeId)) inScope.set(targetTypeId, position)
		firstConsumeByScopeId.set(scopeId, inScope)
	}
	const violations: BorrowViolation[] = []
	for (const ctx of args.contexts.values()) {
		const uses: UseInPath[] = []
		for (const scope of ctx.subtreeScopes) {
			for (const ref of scope.references) {
				if (!ctx.opaqueVarTypeIds.has(ref.typeId)) continue
				const refKey = `${ref.typeId}:${ref.position.start}:${ref.position.end}`
				if (ctx.nonConsumingReferenceKeys.has(refKey)) continue
				const targetType = args.typeById.get(ref.typeId)
				if (!targetType) continue
				const containingCalls = scope.calls
					.flatMap(call =>
						call.arguments.map((arg, idx) => ({
							call,
							idx,
							arg,
							contains: arg.position.start <= ref.position.start && arg.position.end >= ref.position.end,
						})),
					)
					.filter(x => x.contains)
					.sort(
						(a, b) =>
							a.arg.position.end - a.arg.position.start - (b.arg.position.end - b.arg.position.start),
					)
				const wrappedByReaders: string[] = []
				const wrappedByConsumers: string[] = []
				let isDirectReaderArgument = false
				for (const item of containingCalls) {
					const genericName = item.call.typeId.startsWith("global:")
						? item.call.typeId.slice("global:".length)
						: (args.typeNameById.get(item.call.typeId) ?? item.call.typeId)
					const forcedOptionKeys = callForcedOptionKeys(item.call.typeId, genericName, item.idx)
					const forcedConsumerByName = forcedOptionKeys.some(key =>
						args.unresolvedForcedConsumerOptionKeys.has(key),
					)
					const forcedReaderByName = forcedOptionKeys.some(key =>
						args.unresolvedForcedReaderOptionKeys.has(key),
					)
					const isReader =
						!forcedConsumerByName &&
						(forcedReaderByName ||
							args.isReaderArgument(toActualDeclarationTypeId(item.call.typeId), item.idx))
					if (isReader) {
						wrappedByReaders.push(genericName)
						if (
							item.arg.position.start === ref.position.start &&
							item.arg.position.end === ref.position.end
						) {
							isDirectReaderArgument = true
						}
					} else {
						wrappedByConsumers.push(genericName)
					}
				}
				uses.push({
					declarationId: ctx.declType.id,
					targetName: targetType.name,
					targetTypeId: ref.typeId,
					scopeId: scope.id,
					wrappedByReaders,
					wrappedByConsumers,
					isDirectReaderArgument,
					position: ref.position,
				})
			}
		}
		uses.sort((a, b) => a.position.start - b.position.start)
		const firstConsumeByScopeId = new Map<string, Map<string, Position>>()
		for (const use of uses) {
			const consumer = isConsumerUse(use)
			if (consumer && use.wrappedByReaders.length > 0 && !use.isDirectReaderArgument) {
				violations.push({
					declarationId: ctx.declType.id,
					kind: "opaque.destructuredBeforeReader",
					message: `Opaque-bound variable '${use.targetName}' is wrapped before reader call. It is opaque-bound because this declaration binds '${use.targetName}' to an opaque slot in its type signature (from parsed types), not only from CLI --opaque parameters.`,
					position: use.position,
				})
			}
			if (!consumer) continue
			const first = findFirstConsumeInScopeChain(
				firstConsumeByScopeId,
				use.scopeId,
				ctx.declType.scopeId,
				use.targetTypeId,
				ctx.relatedOpaqueTypeIdsByTypeId,
			)
			if (first) {
				const firstTypeName = args.typeById.get(first.consumedTypeId)?.name
				const currentTypeName = args.typeById.get(use.targetTypeId)?.name
				const relationSuffix =
					first.consumedTypeId !== use.targetTypeId && firstTypeName && currentTypeName
						? ` It is considered the same consume chain as '${firstTypeName}' because both are bound by the same opaque-triggering extends relation.`
						: ""
				violations.push({
					declarationId: ctx.declType.id,
					kind: "opaque.consumeMultipleInPath",
					message: `Opaque-bound variable '${use.targetName}' consumed multiple times in one path.${relationSuffix}`,
					position: use.position,
					relatedPosition: first.position,
				})
			} else {
				rememberFirstConsume(firstConsumeByScopeId, use.scopeId, use.targetTypeId, use.position)
			}
		}
	}
	return violations
}

function scopeConsumesOpaqueSlot(
	ctx: DeclarationContext,
	targetOpaqueTypeId: string,
	isReaderArgument: (genericTypeId: string, index: number) => boolean,
	typeIdToActualDeclarationTypeId: Map<string, string>,
	typeById: Map<string, { name: string }>,
	typeNameById: Map<string, string>,
): boolean {
	const toActualDeclarationTypeId = (typeId: string): string => typeIdToActualDeclarationTypeId.get(typeId) ?? typeId
	for (const scope of ctx.subtreeScopes) {
		for (const ref of scope.references) {
			if (ref.typeId !== targetOpaqueTypeId) continue
			const targetType = typeById.get(ref.typeId)
			if (!targetType) continue
			const containingCalls = scope.calls
				.flatMap(call =>
					call.arguments.map((arg, idx) => ({
						call,
						idx,
						arg,
						contains: arg.position.start <= ref.position.start && arg.position.end >= ref.position.end,
					})),
				)
				.filter(x => x.contains)
				.sort((a, b) => a.arg.position.end - a.arg.position.start - (b.arg.position.end - b.arg.position.start))
			const wrappedByReaders: string[] = []
			const wrappedByConsumers: string[] = []
			let isDirectReaderArgument = false
			for (const item of containingCalls) {
				const genericName = item.call.typeId.startsWith("global:")
					? item.call.typeId.slice("global:".length)
					: (typeNameById.get(item.call.typeId) ?? item.call.typeId)
				if (isReaderArgument(toActualDeclarationTypeId(item.call.typeId), item.idx)) {
					wrappedByReaders.push(genericName)
					if (item.arg.position.start === ref.position.start && item.arg.position.end === ref.position.end) {
						isDirectReaderArgument = true
					}
				} else {
					wrappedByConsumers.push(genericName)
				}
			}
			if (
				isConsumerUse({
					declarationId: ctx.declType.id,
					targetName: targetType.name,
					targetTypeId: ref.typeId,
					scopeId: scope.id,
					wrappedByReaders,
					wrappedByConsumers,
					isDirectReaderArgument,
					position: ref.position,
				})
			) {
				return true
			}
		}
	}
	return false
}
