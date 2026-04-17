import "core-js"
import type { MonadViolationsOptions, MonadViolation, NamedTypeOption } from "./types.ts"
import type { ParsedType, Scope } from "./parseTypes.ts"
import type { ParseTypesResult } from "./parseTypes.ts"
import { never } from "./utils.ts"

// monadChecker responsibility boundary:
// - resolve forced reader/consumer options into concrete slots
// - evaluate borrow rules over parseTypes output
// - emit violations only (no CLI/output formatting concerns)

export function getMonadViolations(
	input: Map<string, ParseTypesResult>,
	options: MonadViolationsOptions,
): MonadViolation[] {
	// please preserve this function body plai - only initializers and calls to other functions
	if (options.monadTypes.length === 0) {
		throw new Error("No monad types provided")
	}

	const nameToType = buildNameToType(input)

	const types = new Map([
		...input.values().flatMap(({ types }) => types.entries()),
		...nameToType
			.values()
			.flatMap(t => t.values())
			.map(t => [t.id, t] as const),
	])
	const scopes = new Map([...input.values().flatMap(({ scopes }) => scopes.entries())])

	const typeIdToDeclarationId = buildTypeIdToDeclarationId(nameToType, types.values())

	const monads = new Set<string>()

	addInitialMonads(monads, options.monadTypes.values(), nameToType, typeIdToDeclarationId)

	const violations: MonadViolation[] = []

	const scopeChildren = buildScopeChildren(scopes)

	const declarationTypeByScopeId = buildDeclarationTypeByScopeId(types.values())

	const monadCompatibleTypeIds = buildMonadCompatibleTypeIds(types.values(), typeIdToDeclarationId, monads)

	promoteNonGenericMonadicDeclarations(
		monadCompatibleTypeIds,
		input,
		scopeChildren,
		declarationTypeByScopeId,
		typeIdToDeclarationId,
	)

	collectInvalidMonadicTypeParameterOrder(
		violations,
		declarationTypeByScopeId,
		monadCompatibleTypeIds,
		typeIdToDeclarationId,
		types,
	)

	collectInvalidMonadicInferConstraints(
		violations,
		types.values(),
		scopes,
		declarationTypeByScopeId,
		monadCompatibleTypeIds,
		typeIdToDeclarationId,
	)

	collectInconsistentBranchReturns(
		violations,
		input,
		scopeChildren,
		declarationTypeByScopeId,
		typeIdToDeclarationId,
		monadCompatibleTypeIds,
	)
	collectInvalidMonadCompatibleUsages(
		violations,
		input,
		declarationTypeByScopeId,
		typeIdToDeclarationId,
		monadCompatibleTypeIds,
		monads,
	)

	return violations
}

function collectInvalidMonadicInferConstraints(
	violations: MonadViolation[],
	types: IteratorObject<ParsedType>,
	scopes: Map<string, Scope>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
) {
	for (const inferType of types) {
		if (inferType.kind !== "infer") continue
		const extendsTypeId = inferType.extends?.typeId
		if (!extendsTypeId) continue
		const extendsDeclarationId = typeIdToDeclarationId.get(extendsTypeId) ?? extendsTypeId
		const isMonadCompatible =
			monadCompatibleTypeIds.has(extendsTypeId) || monadCompatibleTypeIds.has(extendsDeclarationId)
		if (!isMonadCompatible) continue
		if (inferType.inferPlacement === "asMonadState") continue

		const declarationType = findEnclosingDeclarationType(inferType.scopeId, scopes, declarationTypeByScopeId)
		if (!declarationType) continue
		violations.push({
			declarationId: declarationType.id,
			kind: "monad.invalidInferConstraint",
			message:
				"Monad-compatible infer constraints are only allowed as the 2nd element in a 2-item tuple pattern.",
			position: inferType.constraintPosition ?? inferType.position,
		})
	}
}

function collectInvalidMonadicTypeParameterOrder(
	violations: MonadViolation[],
	declarationTypeByScopeId: Map<string, ParsedType>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	types: Map<string, ParsedType>,
) {
	for (const declarationType of declarationTypeByScopeId.values()) {
		const args = declarationType.arguments ?? []
		if (args.length <= 1) continue
		for (const [idx, arg] of args.entries()) {
			if (idx === args.length - 1) continue
			const argType = types.get(arg.typeId)
			if (!argType) continue
			const declarationId = typeIdToDeclarationId.get(argType.id) ?? argType.id
			const extendsTypeId = argType.extends?.typeId
			const extendsDeclarationId = extendsTypeId
				? (typeIdToDeclarationId.get(extendsTypeId) ?? extendsTypeId)
				: undefined
			const isMonadCompatible =
				monadCompatibleTypeIds.has(argType.id) ||
				monadCompatibleTypeIds.has(declarationId) ||
				(extendsTypeId != null &&
					(monadCompatibleTypeIds.has(extendsTypeId) ||
						(extendsDeclarationId != null && monadCompatibleTypeIds.has(extendsDeclarationId))))
			if (!isMonadCompatible) continue

			violations.push({
				declarationId: declarationType.id,
				kind: "monad.invalidGenericArgumentConstraint",
				message: "Monad-compatible type parameters are only allowed in the last generic parameter slot.",
				position: argType.constraintPosition ?? argType.position,
			})
		}
	}
}

function findEnclosingDeclarationType(
	scopeId: string,
	scopes: Map<string, Scope>,
	declarationTypeByScopeId: Map<string, ParsedType>,
): ParsedType | undefined {
	let cursor: string | null | undefined = scopeId
	while (cursor) {
		const scope = scopes.get(cursor)
		if (!scope) return undefined
		if (scope.kind === "declaration") return declarationTypeByScopeId.get(scope.id)
		cursor = scope.parentScopeId
	}
	return undefined
}

function promoteNonGenericMonadicDeclarations(
	monadCompatibleTypeIds: Set<string>,
	input: Map<string, ParseTypesResult>,
	scopeChildren: Map<string, string[]>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
) {
	let changed = true
	while (changed) {
		changed = false
		for (const { scopes } of input.values()) {
			for (const scope of scopes.values()) {
				if (scope.kind !== "declaration") continue
				const declarationType = declarationTypeByScopeId.get(scope.id)
				if (!declarationType) continue
				if ((declarationType.arguments?.length ?? 0) > 0) continue
				if (monadCompatibleTypeIds.has(declarationType.id)) continue

				const declarationCompatibleTypeIds = extendCompatibleTypeIdsFromConditionals(
					scope.id,
					scopes,
					scopeChildren,
					monadCompatibleTypeIds,
				)
				const terminalScopes = getTerminalReturnScopes(scope.id, scopes, scopeChildren)
				const branchKinds = terminalScopes.map(s =>
					classifyTerminalReturn(s, typeIdToDeclarationId, declarationCompatibleTypeIds),
				)
				const hasMonadReturn = branchKinds.includes("monad")
				if (!hasMonadReturn) continue

				const monadRepresentativeByIndex = terminalScopes.map((terminalScope, idx) =>
					branchKinds[idx] === "monad"
						? getMonadReturnRepresentative(
								terminalScope,
								typeIdToDeclarationId,
								declarationCompatibleTypeIds,
							)
						: undefined,
				)
				const expectedMonadRepresentative = monadRepresentativeByIndex.find(rep => rep != null)
				if (!expectedMonadRepresentative) continue

				const hasInvalidTerminal = terminalScopes.some((_, idx) => {
					const branchKind = branchKinds[idx]
					if (branchKind === "never") return false
					if (branchKind !== "monad") return true
					const representative = monadRepresentativeByIndex[idx]
					return representative == null || representative !== expectedMonadRepresentative
				})
				if (hasInvalidTerminal) continue

				monadCompatibleTypeIds.add(declarationType.id)
				changed = true
			}
		}
	}
}

function collectInconsistentBranchReturns(
	violations: MonadViolation[],
	input: Map<string, ParseTypesResult>,
	scopeChildren: Map<string, string[]>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
) {
	for (const { scopes } of input.values()) {
		for (const scope of scopes.values()) {
			if (scope.kind !== "declaration") continue
			const declarationType = declarationTypeByScopeId.get(scope.id)
			if (!declarationType) continue

			const declarationCompatibleTypeIds = extendCompatibleTypeIdsFromConditionals(
				scope.id,
				scopes,
				scopeChildren,
				monadCompatibleTypeIds,
			)
			const terminalScopes = getTerminalReturnScopes(scope.id, scopes, scopeChildren)
			const branchKinds = terminalScopes.map(s =>
				classifyTerminalReturn(s, typeIdToDeclarationId, declarationCompatibleTypeIds),
			)
			const hasMonadReturn = branchKinds.includes("monad")
			if (!hasMonadReturn) continue

			const monadRepresentativeByIndex = terminalScopes.map((scope, idx) =>
				branchKinds[idx] === "monad"
					? getMonadReturnRepresentative(scope, typeIdToDeclarationId, declarationCompatibleTypeIds)
					: undefined,
			)
			const expectedMonadRepresentative = monadRepresentativeByIndex.find(rep => rep != null)
			if (!expectedMonadRepresentative) continue

			const invalidScope = terminalScopes.find((scope, idx) => {
				const branchKind = branchKinds[idx]
				if (branchKind === "never") return false
				if (branchKind !== "monad") return true
				const representative = monadRepresentativeByIndex[idx]
				return representative == null || representative !== expectedMonadRepresentative
			})
			if (!invalidScope) continue

			violations.push({
				declarationId: declarationType.id,
				kind: "monad.inconsistentBranchReturn",
				message:
					"If any terminal branch returns a monad-compatible type, every terminal branch must return that same monad-compatible type or never.",
				position: invalidScope.position,
			})
		}
	}
}

function collectInvalidMonadCompatibleUsages(
	violations: MonadViolation[],
	input: Map<string, ParseTypesResult>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
	baseMonadCompatibleTypeIds: Set<string>,
	monads: Set<string>,
) {
	const baseCompatibleDeclarationIds = new Set(
		[...baseMonadCompatibleTypeIds].map(typeId => typeIdToDeclarationId.get(typeId) ?? typeId),
	)
	for (const parsed of input.values()) {
		const parsedScopeChildren = buildScopeChildren(parsed.scopes)
		for (const usage of parsed.usages) {
			const declarationType = declarationTypeByScopeId.get(usage.declarationScopeId)
			if (!declarationType) continue
			const declarationId = typeIdToDeclarationId.get(usage.typeId) ?? usage.typeId
			const declarationCompatibleTypeIds = extendCompatibleTypeIdsFromConditionals(
				usage.declarationScopeId,
				parsed.scopes,
				parsedScopeChildren,
				baseMonadCompatibleTypeIds,
			)
			if (monads.has(declarationId)) continue
			const isBaseMonadCompatible =
				baseMonadCompatibleTypeIds.has(usage.typeId) || baseCompatibleDeclarationIds.has(declarationId)
			if (!isBaseMonadCompatible) continue
			const isConditionallyCompatibleOnly =
				declarationCompatibleTypeIds.has(usage.typeId) || declarationCompatibleTypeIds.has(declarationId)
			if (!isConditionallyCompatibleOnly) continue
			if (
				!usage.wrapped &&
				(usage.kind === "genericArgLast" || usage.kind === "tupleSecondOfTwo" || usage.kind === "other")
			) {
				continue
			}
			if (usage.kind === "conditionalCheck" || usage.kind === "conditionalExtends") {
				violations.push({
					declarationId: declarationType.id,
					kind: "monad.usedInCondition",
					message: "Monad-compatible types are not allowed in conditional check/extends positions.",
					position: usage.position,
				})
				continue
			}
			violations.push({
				declarationId: declarationType.id,
				kind: "monad.destructuredBeforeReader",
				message:
					"Monad-compatible types are only allowed as the last generic argument or tuple[1] of a 2-tuple.",
				position: usage.position,
			})
		}
	}
}

function extendCompatibleTypeIdsFromConditionals(
	declarationScopeId: string,
	scopes: Map<string, Scope>,
	scopeChildren: Map<string, string[]>,
	baseCompatibleTypeIds: Set<string>,
) {
	const compatible = new Set(baseCompatibleTypeIds)
	const descendants: string[] = []
	const stack = [...(scopeChildren.get(declarationScopeId) ?? [])]
	while (stack.length > 0) {
		const nextId = stack.pop()!
		descendants.push(nextId)
		stack.push(...(scopeChildren.get(nextId) ?? []))
	}

	for (const scopeId of descendants) {
		const conditional = scopes.get(scopeId)
		if (!conditional || conditional.kind !== "conditional") continue
		const checkPos = conditional.conditionalCheckPosition
		const extendsPos = conditional.conditionalExtendsPosition
		if (!checkPos || !extendsPos) continue

		const checkRefs = conditional.references.filter(
			r => r.position.start >= checkPos.start && r.position.end <= checkPos.end,
		)
		const extendsRefs = conditional.references.filter(
			r => r.position.start >= extendsPos.start && r.position.end <= extendsPos.end,
		)
		if (extendsRefs.length === 0) continue
		const extendsIsMonadCompatible = extendsRefs.every(ref => compatible.has(ref.typeId))
		if (!extendsIsMonadCompatible) continue

		for (const ref of checkRefs) {
			compatible.add(ref.typeId)
		}
	}

	return compatible
}

function buildScopeChildren(scopes: Map<string, Scope>) {
	const result = Map.groupBy(
		scopes.keys().filter(s => scopes.get(s)?.parentScopeId),
		s => scopes.get(s)?.parentScopeId ?? never(),
	)
	return result
}

function buildDeclarationTypeByScopeId(types: IteratorObject<ParsedType>) {
	return new Map(
		types
			.filter(t => t.kind === "typeAlias" || t.kind === "interface" || t.kind === "class")
			.map(t => [t.scopeId, t] as const),
	)
}

function buildMonadCompatibleTypeIds(
	types: IteratorObject<ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
	monads: Set<string>,
) {
	const allTypes = [...types]
	const compatible = new Set(
		allTypes
			.filter(t => {
				const declarationId = typeIdToDeclarationId.get(t.id)
				return declarationId != null && monads.has(declarationId)
			})
			.map(t => t.id),
	)

	let changed = true
	while (changed) {
		changed = false
		for (const t of allTypes) {
			const extendsTypeId = t.extends?.typeId
			if (!extendsTypeId || compatible.has(t.id)) continue
			if (!compatible.has(extendsTypeId)) continue
			compatible.add(t.id)
			changed = true
		}
	}

	return compatible
}

function getTerminalReturnScopes(
	declarationScopeId: string,
	scopes: Map<string, Scope>,
	scopeChildren: Map<string, string[]>,
) {
	const descendants: string[] = []
	const stack = [...(scopeChildren.get(declarationScopeId) ?? [])]
	while (stack.length > 0) {
		const nextId = stack.pop()!
		descendants.push(nextId)
		stack.push(...(scopeChildren.get(nextId) ?? []))
	}

	const branchScopes = descendants
		.map(id => scopes.get(id))
		.filter((s): s is Scope => s != null && (s.kind === "branchTrue" || s.kind === "branchFalse"))

	if (branchScopes.length === 0) {
		const declarationScope = scopes.get(declarationScopeId)
		return declarationScope ? [declarationScope] : []
	}

	return branchScopes.filter(scope => {
		const stack = [...(scopeChildren.get(scope.id) ?? [])]
		while (stack.length > 0) {
			const nextId = stack.pop()!
			const next = scopes.get(nextId)
			if (!next) continue
			if (next.kind === "branchTrue" || next.kind === "branchFalse") return false
			stack.push(...(scopeChildren.get(nextId) ?? []))
		}
		return true
	})
}

function classifyTerminalReturn(
	scope: Scope,
	typeIdToDeclarationId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
): "monad" | "never" | "other" {
	const directTypeId = getDirectTerminalTypeId(scope)
	if (!directTypeId) return "other"
	if (directTypeId === "global:never") return "never"

	const declarationId = typeIdToDeclarationId.get(directTypeId) ?? directTypeId
	if (monadCompatibleTypeIds.has(directTypeId) || monadCompatibleTypeIds.has(declarationId)) return "monad"
	return "other"
}

function getMonadReturnRepresentative(
	scope: Scope,
	typeIdToDeclarationId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
) {
	const directTypeId = getDirectTerminalTypeId(scope)
	if (!directTypeId) return undefined
	const declarationId = typeIdToDeclarationId.get(directTypeId) ?? directTypeId
	if (monadCompatibleTypeIds.has(directTypeId)) return directTypeId
	if (monadCompatibleTypeIds.has(declarationId)) return declarationId
	return undefined
}

function getDirectTerminalTypeId(scope: Scope): string | undefined {
	// Terminal return must be a direct type, not a wrapped/constructed expression.
	if (scope.references.length !== 1) return undefined
	const [onlyRef] = scope.references
	if (!onlyRef) return undefined
	if (scope.kind === "declaration") {
		// Declaration scopes include the full `type X = ...` span, so only the end can
		// be reliably matched against the terminal type expression.
		if (onlyRef.position.end !== scope.position.end) return undefined
		return onlyRef.typeId
	}
	if (onlyRef.position.start !== scope.position.start || onlyRef.position.end !== scope.position.end) {
		return undefined
	}
	return onlyRef.typeId
}

function addInitialMonads(
	monads: Set<string>,
	monadTypes: IteratorObject<NamedTypeOption>,
	nameToType: Map<string, Map<string, ParsedType>>,
	typeIdToDeclarationId: Map<string, string>,
) {
	monadTypes
		.map(t => nameToType.get(t.path)?.get(t.name)?.id)
		.filter(t => t != null)
		.map(t => typeIdToDeclarationId.get(t))
		.filter(t => t != null)
		.forEach(t => monads.add(t))
}

function buildNameToType(types: Map<string, ParseTypesResult>) {
	const result = new Map(
		types.entries().map(([path, { types, scopes }]) => {
			const fileScope = scopes.values().find(s => s.kind === "file") ?? never()

			return [
				path,
				new Map(
					types
						.values()
						.filter(t => t.scopeId === fileScope.id)
						.map(t => [t.name, t]),
				),
			]
		}),
	)

	for (const t of types
		.values()
		.flatMap(t => t.types.values())
		.filter(t => t.kind === "imported")) {
		result
			.getOrInsertComputed(t.refPath, () => new Map())
			.getOrInsertComputed(t.refName, () => ({
				id: "stub-" + t.id,
				path: t.refPath,
				name: t.refName,
				refPath: t.refPath,
				refName: t.refName,
				scopeId: "stub-external",
				kind: "typeAlias",
				position: { start: 0, end: 0 },
			}))
	}

	return result
}

function buildTypeIdToDeclarationId(
	nameToType: Map<string, Map<string, ParsedType>>,
	types: IteratorObject<ParsedType>,
) {
	const result = new Map(
		types.map(t => {
			let ref = t
			while (ref.kind === "imported") {
				const next = nameToType.get(ref.refPath)?.get(ref.refName)
				if (!next) break
				ref = next
			}
			return [t.id, ref.id]
		}),
	)

	return result
}
