import "core-js"
import type { MonadViolationsOptions, MonadViolation, NamedTypeOption } from "./monadCheckerTypes.ts"
import type { ParsedType, ParseTypesResult, Position, Scope, TypeCall } from "./parseContent.ts"
import { never } from "./utils.ts"

// monadChecker responsibility boundary:
// - evaluate borrow rules over parseTypes output
// - emit violations only (no CLI/output formatting concerns)

export function getMonadViolations(
	input: ReadonlyMap<string, ParseTypesResult>,
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

	const resolvedSimpleExtendsByParsedTypeId = new Map<string, string>()
	const constraintCallOwnerByScopeId = new Map<string, string[]>()
	for (const r of input.values()) {
		const localDeclByScope = buildDeclarationTypeByScopeId(r.types.values())
		const { resolved, owners } = buildTypeParameterConstraintMaps(r.types, r.scopes, localDeclByScope)
		for (const [k, v] of resolved) resolvedSimpleExtendsByParsedTypeId.set(k, v)
		for (const [k, v] of owners) constraintCallOwnerByScopeId.set(k, v)
		addInferSimpleExtendsMaps(r.types, r.scopes, resolvedSimpleExtendsByParsedTypeId)
	}

	const monadCompatibleTypeIds = buildMonadCompatibleTypeIds(
		types.values(),
		resolvedSimpleExtendsByParsedTypeId,
		typeIdToDeclarationId,
		monads,
	)

	promoteNonGenericMonadicDeclarations(
		monadCompatibleTypeIds,
		input,
		scopeChildren,
		declarationTypeByScopeId,
		typeIdToDeclarationId,
		types,
	)

	collectInvalidMonadicTypeParameterOrder(
		violations,
		scopes,
		constraintCallOwnerByScopeId,
		declarationTypeByScopeId,
		monadCompatibleTypeIds,
		typeIdToDeclarationId,
		types,
		resolvedSimpleExtendsByParsedTypeId,
	)

	collectInvalidMonadicInferConstraints(
		violations,
		types.values(),
		scopes,
		declarationTypeByScopeId,
		monadCompatibleTypeIds,
		typeIdToDeclarationId,
		resolvedSimpleExtendsByParsedTypeId,
	)

	collectInconsistentBranchReturns(
		violations,
		input,
		scopeChildren,
		declarationTypeByScopeId,
		typeIdToDeclarationId,
		monadCompatibleTypeIds,
		types,
	)
	collectInvalidMonadCompatibleUsages(
		violations,
		input,
		declarationTypeByScopeId,
		typeIdToDeclarationId,
		monadCompatibleTypeIds,
		monads,
	)
	collectMonadArgRequiresMonadBoundParameterViolations(
		violations,
		input,
		declarationTypeByScopeId,
		typeIdToDeclarationId,
		monadCompatibleTypeIds,
		monads,
		resolvedSimpleExtendsByParsedTypeId,
		types,
		scopes,
		constraintCallOwnerByScopeId,
	)

	return filterViolationsSkippedBodies(
		violations,
		options.skipDeclarationBodies,
		nameToType,
		typeIdToDeclarationId,
	)
}

function filterViolationsSkippedBodies(
	violations: MonadViolation[],
	skipSpecs: NamedTypeOption[] | undefined,
	nameToType: Map<string, Map<string, ParsedType>>,
	typeIdToDeclarationId: Map<string, string>,
): MonadViolation[] {
	if (!skipSpecs?.length) return violations
	const skipIds = new Set<string>()
	for (const spec of skipSpecs) {
		const t = nameToType.get(spec.path)?.get(spec.name)
		if (!t) continue
		if (t.kind !== "typeAlias" && t.kind !== "interface" && t.kind !== "class") continue
		skipIds.add(typeIdToDeclarationId.get(t.id) ?? t.id)
	}
	if (skipIds.size === 0) return violations
	return violations.filter(v => !skipIds.has(v.declarationId))
}

function collectInvalidMonadicInferConstraints(
	violations: MonadViolation[],
	types: IteratorObject<ParsedType>,
	scopes: Map<string, Scope>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
) {
	for (const inferType of types) {
		if (inferType.kind !== "infer") continue
		const extendsTypeId = resolvedSimpleExtendsByParsedTypeId.get(inferType.id)
		if (!extendsTypeId) continue
		const extendsDeclarationId = typeIdToDeclarationId.get(extendsTypeId) ?? extendsTypeId
		const isMonadCompatible =
			monadCompatibleTypeIds.has(extendsTypeId) || monadCompatibleTypeIds.has(extendsDeclarationId)
		if (!isMonadCompatible) continue
		if (inferMonadConstraintAllowedInConditionalExtendsCalls(scopes, inferType)) continue

		const declarationType = findEnclosingDeclarationType(inferType.scopeId, scopes, declarationTypeByScopeId)
		if (!declarationType) continue
		const conditionalScopeId = findNearestAncestorScopeIdOfKind(scopes, inferType.scopeId, "conditional")
		const extendsCalls = conditionalScopeId ? (scopes.get(conditionalScopeId)?.calls ?? []) : []
		violations.push({
			declarationId: declarationType.id,
			kind: "monad.invalidInferConstraint",
			message:
				"Monad-compatible infer constraints are only allowed as the 2nd element in a 2-item tuple pattern  like [..., infer <your variable> extends Monad].",
			position: inferConstraintDiagnosticPosition(extendsCalls, inferType.id, inferType.position),
		})
	}
}

const PSEUDO_TUPLE = "[tuple]"

function inferConstraintDiagnosticPosition(
	extendsRoots: TypeCall[],
	inferTypeId: string,
	fallback: Position,
): Position {
	let found: Position | undefined
	const walk = (c: TypeCall): void => {
		if (c.kind !== "call") return
		if (c.typeId === inferTypeId) {
			const inner = c.arguments[0]
			found = inner?.kind === "call" ? inner.position : c.position
		}
		for (const a of c.arguments) walk(a)
	}
	for (const r of extendsRoots) walk(r)
	return found ?? fallback
}

function typeParameterConstraintDiagnosticPosition(
	owners: string[] | undefined,
	typeParamScopeCalls: TypeCall[],
	typeParamId: string,
	fallback: Position,
): Position {
	if (!owners || owners.length !== typeParamScopeCalls.length) return fallback
	const idx = owners.indexOf(typeParamId)
	const root = idx >= 0 ? typeParamScopeCalls[idx] : undefined
	if (root?.kind === "call") return root.position
	return fallback
}

function inferMonadConstraintAllowedInConditionalExtendsCalls(
	scopes: Map<string, Scope>,
	inferType: ParsedType,
): boolean {
	const conditionalScopeId = findNearestAncestorScopeIdOfKind(scopes, inferType.scopeId, "conditional")
	if (!conditionalScopeId) return false
	const conditional = scopes.get(conditionalScopeId)
	if (!conditional) return false
	for (const root of conditional.calls) {
		if (inferIsSecondOfTwoTupleAtExtendsRoot(root, inferType.id)) return true
	}
	return false
}

/** Same rule as former `inferPlacement`: extends-type root must be a 2-tuple and this infer is its second element. */
function inferIsSecondOfTwoTupleAtExtendsRoot(root: TypeCall, inferTypeId: string): boolean {
	if (root.kind !== "call") return false
	if (root.typeId !== PSEUDO_TUPLE || root.arguments.length !== 2) return false
	const second = root.arguments[1]
	return second.kind === "call" && second.typeId === inferTypeId
}

function collectInvalidMonadicTypeParameterOrder(
	violations: MonadViolation[],
	scopes: Map<string, Scope>,
	constraintCallOwnerByScopeId: Map<string, string[]>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	types: Map<string, ParsedType>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
) {
	for (const declarationType of declarationTypeByScopeId.values()) {
		const args = declarationType.arguments ?? []
		if (args.length <= 1) continue
		const lastArgType = types.get(args[args.length - 1]!.typeId)
		const lastTypeParameterPosition = lastArgType?.position

		for (const [idx, arg] of args.entries()) {
			if (idx === args.length - 1) continue
			const argType = types.get(arg.typeId)
			if (!argType) continue
			const declarationId = typeIdToDeclarationId.get(argType.id) ?? argType.id
			const extendsTypeId = resolvedSimpleExtendsByParsedTypeId.get(argType.id)
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

			const tpCalls = scopes.get(argType.scopeId)?.calls ?? []
			const owners = constraintCallOwnerByScopeId.get(argType.scopeId)
			violations.push({
				declarationId: declarationType.id,
				kind: "monad.invalidGenericArgumentConstraint",
				message: "Monad-compatible type parameters are only allowed in the last generic parameter slot.",
				position: typeParameterConstraintDiagnosticPosition(owners, tpCalls, argType.id, argType.position),
				...(lastTypeParameterPosition ? { relatedPosition: lastTypeParameterPosition } : {}),
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
	input: ReadonlyMap<string, ParseTypesResult>,
	scopeChildren: Map<string, string[]>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
	types: Map<string, ParsedType>,
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
					classifyTerminalReturn(s, typeIdToDeclarationId, declarationCompatibleTypeIds, types),
				)
				const hasMonadReturn = branchKinds.includes("monad")
				if (!hasMonadReturn) continue

				const monadRepresentativeByIndex = terminalScopes.map((terminalScope, idx) =>
					branchKinds[idx] === "monad"
						? getMonadReturnRepresentative(
								terminalScope,
								typeIdToDeclarationId,
								declarationCompatibleTypeIds,
								types,
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
	input: ReadonlyMap<string, ParseTypesResult>,
	scopeChildren: Map<string, string[]>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
	types: Map<string, ParsedType>,
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
				classifyTerminalReturn(s, typeIdToDeclarationId, declarationCompatibleTypeIds, types),
			)
			const hasMonadReturn = branchKinds.includes("monad")
			if (!hasMonadReturn) continue

			const monadRepresentativeByIndex = terminalScopes.map((scope, idx) =>
				branchKinds[idx] === "monad"
					? getMonadReturnRepresentative(scope, typeIdToDeclarationId, declarationCompatibleTypeIds, types)
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

			const referenceScope = terminalScopes.find((_scope, idx) => {
				if (branchKinds[idx] !== "monad") return false
				return monadRepresentativeByIndex[idx] === expectedMonadRepresentative
			})

			violations.push({
				declarationId: declarationType.id,
				kind: "monad.inconsistentBranchReturn",
				message:
					"If any terminal branch returns a monad-compatible type, every terminal branch must return that same monad-compatible type or never.",
				position: invalidScope.position,
				...(referenceScope ? { relatedPosition: referenceScope.position } : {}),
			})
		}
	}
}

function getResolvedGenericDeclaration(
	calleeTypeId: string,
	types: Map<string, ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
): ParsedType | undefined {
	const canon = typeIdToDeclarationId.get(calleeTypeId) ?? calleeTypeId
	const t = types.get(canon)
	if (!t) return undefined
	if (t.kind === "typeAlias" || t.kind === "interface" || t.kind === "class") return t
	return undefined
}

function calleeTypeParamExtendsMonadCompatible(
	calleeTypeParamId: string,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
): boolean {
	const extId = resolvedSimpleExtendsByParsedTypeId.get(calleeTypeParamId)
	if (extId == null) return false
	const extDecl = typeIdToDeclarationId.get(extId) ?? extId
	return monadCompatibleTypeIds.has(extId) || monadCompatibleTypeIds.has(extDecl)
}

function monadLikeLeafReference(
	arg: TypeCall,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	monads: Set<string>,
): { typeId: string; position: Position } | undefined {
	if (arg.kind !== "call") return undefined
	if (arg.typeId.startsWith("[") || arg.arguments.length > 0) return undefined
	const declId = typeIdToDeclarationId.get(arg.typeId) ?? arg.typeId
	if (monads.has(declId)) return { typeId: arg.typeId, position: arg.position }
	if (monadCompatibleTypeIds.has(arg.typeId) || monadCompatibleTypeIds.has(declId)) {
		return { typeId: arg.typeId, position: arg.position }
	}
	return undefined
}

function calleeLastTypeParameterReferencePosition(
	calleeDecl: ParsedType,
	types: Map<string, ParsedType>,
	scopes: Map<string, Scope>,
	constraintCallOwnerByScopeId: Map<string, string[]>,
): Position | undefined {
	const args = calleeDecl.arguments
	if (!args?.length) return undefined
	const lastTp = types.get(args[args.length - 1]!.typeId)
	if (!lastTp || lastTp.kind !== "typeParameter") return undefined
	const tpCalls = scopes.get(lastTp.scopeId)?.calls ?? []
	const owners = constraintCallOwnerByScopeId.get(lastTp.scopeId)
	return typeParameterConstraintDiagnosticPosition(owners, tpCalls, lastTp.id, lastTp.position)
}

function inspectGenericInstantiationCalleeSlots(
	c: TypeCall,
	declarationScopeId: string,
	violations: MonadViolation[],
	types: Map<string, ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
	monads: Set<string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	scopes: Map<string, Scope>,
	constraintCallOwnerByScopeId: Map<string, string[]>,
): void {
	if (c.kind !== "call" || c.typeId.startsWith("[") || c.arguments.length === 0) return
	if (types.get(c.typeId)?.kind === "infer") return

	const calleeDecl = getResolvedGenericDeclaration(c.typeId, types, typeIdToDeclarationId)
	if (!calleeDecl?.arguments?.length) return
	if (calleeDecl.arguments.length !== c.arguments.length) return

	const declarationType = declarationTypeByScopeId.get(declarationScopeId)
	if (!declarationType) return

	const relatedPosition = calleeLastTypeParameterReferencePosition(
		calleeDecl,
		types,
		scopes,
		constraintCallOwnerByScopeId,
	)
	const relatedFields =
		relatedPosition != null ? { relatedPosition, relatedDeclarationId: calleeDecl.id } : {}

	for (let i = 0; i < c.arguments.length; i++) {
		const arg = c.arguments[i]!
		const leaf = monadLikeLeafReference(arg, monadCompatibleTypeIds, typeIdToDeclarationId, monads)
		if (!leaf) continue
		const calleeTpId = calleeDecl.arguments[i]!.typeId
		if (
			calleeTypeParamExtendsMonadCompatible(
				calleeTpId,
				resolvedSimpleExtendsByParsedTypeId,
				monadCompatibleTypeIds,
				typeIdToDeclarationId,
			)
		) {
			continue
		}
		violations.push({
			declarationId: declarationType.id,
			kind: "monad.monadArgRequiresMonadBoundParameter",
			message:
				"Monad-compatible types may only appear at generic parameters that declare a Monad-compatible bound (for example `A extends Monad`).",
			position: leaf.position,
			...relatedFields,
		})
	}
}

function walkGenericCalleeConformance(
	c: TypeCall,
	declarationScopeId: string,
	violations: MonadViolation[],
	types: Map<string, ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
	monads: Set<string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	scopes: Map<string, Scope>,
	constraintCallOwnerByScopeId: Map<string, string[]>,
): void {
	if (c.kind === "scope") {
		const sc = scopes.get(c.scopeId)
		if (!sc || sc.kind === "conditional") return
		for (const root of sc.calls) {
			walkGenericCalleeConformance(
				root,
				declarationScopeId,
				violations,
				types,
				typeIdToDeclarationId,
				monadCompatibleTypeIds,
				monads,
				resolvedSimpleExtendsByParsedTypeId,
				declarationTypeByScopeId,
				scopes,
				constraintCallOwnerByScopeId,
			)
		}
		return
	}

	if (c.kind !== "call") return

	if (types.get(c.typeId)?.kind === "infer") {
		for (const a of c.arguments) {
			walkGenericCalleeConformance(
				a,
				declarationScopeId,
				violations,
				types,
				typeIdToDeclarationId,
				monadCompatibleTypeIds,
				monads,
				resolvedSimpleExtendsByParsedTypeId,
				declarationTypeByScopeId,
				scopes,
				constraintCallOwnerByScopeId,
			)
		}
		return
	}

	if (c.typeId === PSEUDO_CONDITIONAL && c.arguments.length >= 3) {
		const condRef = c.arguments[0]
		if (condRef?.kind === "scope") {
			const condSc = scopes.get(condRef.scopeId)
			if (condSc?.kind === "conditional") {
				if (condSc.calls[0]) {
					walkGenericCalleeConformance(
						condSc.calls[0]!,
						declarationScopeId,
						violations,
						types,
						typeIdToDeclarationId,
						monadCompatibleTypeIds,
						monads,
						resolvedSimpleExtendsByParsedTypeId,
						declarationTypeByScopeId,
						scopes,
						constraintCallOwnerByScopeId,
					)
				}
				if (condSc.calls[1]) {
					walkGenericCalleeConformance(
						condSc.calls[1]!,
						declarationScopeId,
						violations,
						types,
						typeIdToDeclarationId,
						monadCompatibleTypeIds,
						monads,
						resolvedSimpleExtendsByParsedTypeId,
						declarationTypeByScopeId,
						scopes,
						constraintCallOwnerByScopeId,
					)
				}
			}
		}
		for (let i = 1; i < c.arguments.length; i++) {
			walkGenericCalleeConformance(
				c.arguments[i]!,
				declarationScopeId,
				violations,
				types,
				typeIdToDeclarationId,
				monadCompatibleTypeIds,
				monads,
				resolvedSimpleExtendsByParsedTypeId,
				declarationTypeByScopeId,
				scopes,
				constraintCallOwnerByScopeId,
			)
		}
		return
	}

	if (c.typeId === PSEUDO_TUPLE && c.arguments.length === 2) {
		walkGenericCalleeConformance(
			c.arguments[0]!,
			declarationScopeId,
			violations,
			types,
			typeIdToDeclarationId,
			monadCompatibleTypeIds,
			monads,
			resolvedSimpleExtendsByParsedTypeId,
			declarationTypeByScopeId,
			scopes,
			constraintCallOwnerByScopeId,
		)
		walkGenericCalleeConformance(
			c.arguments[1]!,
			declarationScopeId,
			violations,
			types,
			typeIdToDeclarationId,
			monadCompatibleTypeIds,
			monads,
			resolvedSimpleExtendsByParsedTypeId,
			declarationTypeByScopeId,
			scopes,
			constraintCallOwnerByScopeId,
		)
		return
	}

	if (c.typeId === "[array]" && c.arguments[0]) {
		walkGenericCalleeConformance(
			c.arguments[0]!,
			declarationScopeId,
			violations,
			types,
			typeIdToDeclarationId,
			monadCompatibleTypeIds,
			monads,
			resolvedSimpleExtendsByParsedTypeId,
			declarationTypeByScopeId,
			scopes,
			constraintCallOwnerByScopeId,
		)
		return
	}

	if (c.typeId === "[pair]" && c.arguments.length >= 2) {
		walkGenericCalleeConformance(
			c.arguments[0]!,
			declarationScopeId,
			violations,
			types,
			typeIdToDeclarationId,
			monadCompatibleTypeIds,
			monads,
			resolvedSimpleExtendsByParsedTypeId,
			declarationTypeByScopeId,
			scopes,
			constraintCallOwnerByScopeId,
		)
		walkGenericCalleeConformance(
			c.arguments[1]!,
			declarationScopeId,
			violations,
			types,
			typeIdToDeclarationId,
			monadCompatibleTypeIds,
			monads,
			resolvedSimpleExtendsByParsedTypeId,
			declarationTypeByScopeId,
			scopes,
			constraintCallOwnerByScopeId,
		)
		return
	}

	if (!c.typeId.startsWith("[") && c.arguments.length > 0) {
		inspectGenericInstantiationCalleeSlots(
			c,
			declarationScopeId,
			violations,
			types,
			typeIdToDeclarationId,
			monadCompatibleTypeIds,
			monads,
			resolvedSimpleExtendsByParsedTypeId,
			declarationTypeByScopeId,
			scopes,
			constraintCallOwnerByScopeId,
		)
		const n = c.arguments.length
		for (let i = 0; i < n; i++) {
			walkGenericCalleeConformance(
				c.arguments[i]!,
				declarationScopeId,
				violations,
				types,
				typeIdToDeclarationId,
				monadCompatibleTypeIds,
				monads,
				resolvedSimpleExtendsByParsedTypeId,
				declarationTypeByScopeId,
				scopes,
				constraintCallOwnerByScopeId,
			)
		}
		return
	}

	if (!c.typeId.startsWith("[") && c.arguments.length === 0) return

	for (const a of c.arguments) {
		walkGenericCalleeConformance(
			a,
			declarationScopeId,
			violations,
			types,
			typeIdToDeclarationId,
			monadCompatibleTypeIds,
			monads,
			resolvedSimpleExtendsByParsedTypeId,
			declarationTypeByScopeId,
			scopes,
			constraintCallOwnerByScopeId,
		)
	}
}

function collectMonadArgRequiresMonadBoundParameterViolations(
	violations: MonadViolation[],
	input: ReadonlyMap<string, ParseTypesResult>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
	monads: Set<string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	types: Map<string, ParsedType>,
	scopes: Map<string, Scope>,
	constraintCallOwnerByScopeId: Map<string, string[]>,
) {
	for (const parsed of input.values()) {
		const localDeclByScope = buildDeclarationTypeByScopeId(parsed.types.values())
		for (const declScope of parsed.scopes.values()) {
			if (declScope.kind !== "declaration") continue
			if (!localDeclByScope.has(declScope.id)) continue
			for (const root of declScope.calls) {
				walkGenericCalleeConformance(
					root,
					declScope.id,
					violations,
					types,
					typeIdToDeclarationId,
					monadCompatibleTypeIds,
					monads,
					resolvedSimpleExtendsByParsedTypeId,
					declarationTypeByScopeId,
					scopes,
					constraintCallOwnerByScopeId,
				)
			}
		}
	}
}

function collectInvalidMonadCompatibleUsages(
	violations: MonadViolation[],
	input: ReadonlyMap<string, ParseTypesResult>,
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
		const localDeclByScope = buildDeclarationTypeByScopeId(parsed.types.values())
		const usages = collectMonadCompatibleUsages(parsed.scopes, localDeclByScope, parsed.types)
		for (const usage of usages) {
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
					message:
						"Monad-compatible types are not allowed in conditional check/extends positions. They can only be used in extends in the 2nd element of a 2-tuple like `... extends [..., infer <your variable> extends Monad]`.",
					position: usage.position,
				})
				continue
			}
			violations.push({
				declarationId: declarationType.id,
				kind: "monad.destructuredBeforeReader",
				message:
					"Returning monad-compatible types are only allowed as the last generic argument or tuple[1] of a 2-tuple.",
				position: usage.position,
				...(usage.expectedSlotPosition ? { relatedPosition: usage.expectedSlotPosition } : {}),
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
		const calls = conditional.calls
		if (calls.length < 2) continue
		const checkRoot = calls[0]!
		const extendsRoot = calls[1]!
		const extendsIds = collectMonadRelevantTypeIds([extendsRoot])
		if (extendsIds.size === 0) continue
		const extendsIsMonadCompatible = [...extendsIds].every(id => compatible.has(id))
		if (!extendsIsMonadCompatible) continue
		for (const id of collectMonadRelevantTypeIds([checkRoot])) compatible.add(id)
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
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
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
			const extendsTypeId = resolvedSimpleExtendsByParsedTypeId.get(t.id)
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
	types: Map<string, ParsedType>,
): "monad" | "never" | "other" {
	const directTypeId = getDirectTerminalTypeId(scope, types)
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
	types: Map<string, ParsedType>,
) {
	const directTypeId = getDirectTerminalTypeId(scope, types)
	if (!directTypeId) return undefined
	const declarationId = typeIdToDeclarationId.get(directTypeId) ?? directTypeId
	if (monadCompatibleTypeIds.has(directTypeId)) return directTypeId
	if (monadCompatibleTypeIds.has(declarationId)) return declarationId
	return undefined
}

/** Type ids referenced under a `TypeCall` tree (aligned with former `Scope.references` / intrinsic `global:` ids). */
function collectMonadRelevantTypeIds(roots: TypeCall[]): Set<string> {
	const out = new Set<string>()
	const walk = (c: TypeCall): void => {
		if (c.kind !== "call") return
		if (!c.typeId.startsWith("[")) out.add(c.typeId)
		for (const a of c.arguments) walk(a)
	}
	for (const r of roots) walk(r)
	return out
}

function getDirectTerminalTypeId(scope: Scope, types: Map<string, ParsedType>): string | undefined {
	// Terminal return must be a direct type, not a wrapped/constructed expression.
	if (scope.calls.length !== 1) return undefined
	const outer = scope.calls[0]
	if (!outer || outer.kind !== "call") return undefined

	let inner: TypeCall = outer
	if (outer.typeId === PSEUDO_TUPLE && outer.arguments.length === 1) {
		const only = outer.arguments[0]
		if (!only || only.kind !== "call") return undefined
		if (types.get(only.typeId)?.kind !== "typeParameter") inner = outer
		else inner = only
	}

	if (inner.arguments.length > 0) return undefined
	const tid = !inner.typeId.startsWith("[") ? inner.typeId : undefined
	if (!tid) return undefined
	if (scope.kind === "declaration") {
		// Declaration scopes include the full `type X = ...` span, so only the end can
		// be reliably matched against the terminal type expression.
		if (outer.position.end !== scope.position.end) return undefined
		return tid
	}
	if (scope.kind === "branchTrue" || scope.kind === "branchFalse") {
		if (outer.position.start !== scope.position.start || outer.position.end !== scope.position.end) {
			return undefined
		}
		return tid
	}
	return undefined
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

function buildNameToType(types: ReadonlyMap<string, ParseTypesResult>) {
	const result = new Map(
		types.entries().map(([path, { types, scopes }]) => {
			const fileScope = scopes.values().find(s => s.kind === "file") ?? never()

			return [
				path,
				new Map(
					types
						.values()
						.filter(t => {
							if (t.scopeId === fileScope.id) return true
							if (t.kind !== "typeAlias" && t.kind !== "interface" && t.kind !== "class") return false
							const declScope = scopes.get(t.scopeId)
							return declScope?.kind === "declaration" && declScope.parentScopeId === fileScope.id
						})
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

function findNearestAncestorScopeIdOfKind(
	scopes: Map<string, Scope>,
	startScopeId: string,
	kind: Scope["kind"],
): string | undefined {
	let sid: string | null | undefined = scopes.get(startScopeId)?.parentScopeId
	while (sid) {
		const s = scopes.get(sid)
		if (!s) return undefined
		if (s.kind === kind) return s.id
		sid = s.parentScopeId
	}
	return undefined
}

/** Synthetic usage record (formerly on ParseTypesResult.usages). */
type MonadCompatibleUsage = {
	declarationScopeId: string
	typeId: string
	position: Position
	/** Where monad-compatible types are allowed: last arg of innermost generic call, else 2-tuple second slot. */
	expectedSlotPosition?: Position
	wrapped: boolean
	kind:
		| "genericArgLast"
		| "tupleSecondOfTwo"
		| "other"
		| "conditionalCheck"
		| "conditionalExtends"
		| "disallowedPosition"
}

const PSEUDO_CONDITIONAL = "[conditional]"

function simpleExtendsFromConstraintRoot(root: TypeCall): string | undefined {
	if (root.kind !== "call") return undefined
	if (root.typeId.startsWith("[")) return undefined
	if (root.arguments.length > 0) return undefined
	return root.typeId
}

function buildTypeParameterConstraintMaps(
	types: Map<string, ParsedType>,
	scopes: Map<string, Scope>,
	declarationTypeByScopeId: Map<string, ParsedType>,
) {
	const resolved = new Map<string, string>()
	const owners = new Map<string, string[]>()

	for (const scope of scopes.values()) {
		if (scope.kind !== "typeParameters") continue
		const parent = scope.parentScopeId ? scopes.get(scope.parentScopeId) : undefined
		if (!parent || parent.kind !== "declaration") continue
		const declType = declarationTypeByScopeId.get(parent.id)
		const calls = scope.calls
		if (!declType?.arguments?.length || calls.length === 0) continue

		const tpIdsInOrder = declType.arguments.map(a => a.typeId)
		const unused = new Set(tpIdsInOrder)
		const scopeOwners: string[] = []
		for (const call of calls) {
			if (call.kind !== "call") continue
			let bestId: string | undefined
			let bestEnd = -1
			for (const tpId of tpIdsInOrder) {
				if (!unused.has(tpId)) continue
				const tp = types.get(tpId)
				if (!tp || tp.kind !== "typeParameter") continue
				if (tp.position.end <= call.position.start && tp.position.end >= bestEnd) {
					bestEnd = tp.position.end
					bestId = tpId
				}
			}
			if (bestId == null) continue
			scopeOwners.push(bestId)
			unused.delete(bestId)
			const ext = simpleExtendsFromConstraintRoot(call)
			if (ext != null) resolved.set(bestId, ext)
		}
		if (scopeOwners.length === calls.length) owners.set(scope.id, scopeOwners)
	}

	return { resolved, owners }
}

function addInferSimpleExtendsMaps(
	types: Map<string, ParsedType>,
	scopes: Map<string, Scope>,
	resolved: Map<string, string>,
) {
	const inferIds = new Set([...types.values()].filter(t => t.kind === "infer").map(t => t.id))
	if (inferIds.size === 0) return

	const visit = (c: TypeCall): void => {
		if (c.kind !== "call") return
		if (inferIds.has(c.typeId) && c.arguments[0]) {
			const inner = c.arguments[0]
			const ext = inner.kind === "call" ? simpleExtendsFromConstraintRoot(inner) : undefined
			if (ext != null) resolved.set(c.typeId, ext)
		}
		for (const a of c.arguments) visit(a)
	}
	for (const scope of scopes.values()) for (const root of scope.calls) visit(root)
}

type UsageFrame =
	| { tag: "check" }
	| { tag: "checkUnarySubject" }
	| { tag: "extends" }
	| { tag: "tuple"; slot: 0 | 1; genericFramesAboveTuple: number; secondSlotPosition?: Position }
	| { tag: "typeArgs"; index: number; count: number; lastArgPosition?: Position }
	| { tag: "forbiddenSite" }

function expectedMonadUsageReferencePosition(frames: UsageFrame[]): Position | undefined {
	for (let i = frames.length - 1; i >= 0; i--) {
		const f = frames[i]!
		if (f.tag === "typeArgs" && f.lastArgPosition) return f.lastArgPosition
	}
	for (let i = frames.length - 1; i >= 0; i--) {
		const f = frames[i]!
		if (f.tag === "tuple" && f.secondSlotPosition) return f.secondSlotPosition
	}
	return undefined
}

function classifyMonadUsageLeaf(frames: UsageFrame[]): MonadCompatibleUsage["kind"] {
	if (frames.some(f => f.tag === "checkUnarySubject")) return "other"
	if (frames.some(f => f.tag === "check")) return "conditionalCheck"
	if (frames.some(f => f.tag === "extends")) return "conditionalExtends"
	if (frames.some(f => f.tag === "forbiddenSite")) return "disallowedPosition"
	const last = frames[frames.length - 1]
	if (last?.tag === "typeArgs" && last.index === last.count - 1) return "genericArgLast"
	if (last?.tag === "tuple" && last.slot === 1 && last.genericFramesAboveTuple === 0) return "tupleSecondOfTwo"
	if (frames.length === 0) return "other"
	return "disallowedPosition"
}

function walkUsageCalls(
	c: TypeCall,
	declarationScopeId: string,
	frames: UsageFrame[],
	out: MonadCompatibleUsage[],
	scopes: Map<string, Scope>,
	types: Map<string, ParsedType>,
): void {
	if (c.kind === "scope") {
		const sc = scopes.get(c.scopeId)
		if (!sc || sc.kind === "conditional") return
		for (const root of sc.calls) walkUsageCalls(root, declarationScopeId, frames, out, scopes, types)
		return
	}

	if (c.kind !== "call") return

	if (types.get(c.typeId)?.kind === "infer") {
		for (const a of c.arguments) walkUsageCalls(a, declarationScopeId, frames, out, scopes, types)
		return
	}

	if (c.typeId === PSEUDO_CONDITIONAL && c.arguments.length >= 3) {
		const condRef = c.arguments[0]
		if (condRef?.kind === "scope") {
			const condSc = scopes.get(condRef.scopeId)
			if (condSc?.kind === "conditional") {
				if (condSc.calls[0])
					walkUsageCalls(
						condSc.calls[0]!,
						declarationScopeId,
						[...frames, { tag: "check" }],
						out,
						scopes,
						types,
					)
				if (condSc.calls[1])
					walkUsageCalls(
						condSc.calls[1]!,
						declarationScopeId,
						[...frames, { tag: "extends" }],
						out,
						scopes,
						types,
					)
			}
		}
		for (let i = 1; i < c.arguments.length; i++) {
			walkUsageCalls(c.arguments[i]!, declarationScopeId, frames, out, scopes, types)
		}
		return
	}

	if (c.typeId === PSEUDO_TUPLE && c.arguments.length === 1) {
		const nextFrames = frames.some(f => f.tag === "check")
			? [...frames, { tag: "checkUnarySubject" as const }]
			: frames
		walkUsageCalls(c.arguments[0]!, declarationScopeId, nextFrames, out, scopes, types)
		return
	}

	if (c.typeId === PSEUDO_TUPLE && c.arguments.length === 2) {
		const genAbove = frames.filter(f => f.tag === "typeArgs").length
		const second = c.arguments[1]
		const secondSlotPosition = second?.kind === "call" ? second.position : undefined
		walkUsageCalls(
			c.arguments[0]!,
			declarationScopeId,
			[...frames, { tag: "tuple", slot: 0, genericFramesAboveTuple: genAbove, secondSlotPosition }],
			out,
			scopes,
			types,
		)
		walkUsageCalls(
			c.arguments[1]!,
			declarationScopeId,
			[...frames, { tag: "tuple", slot: 1, genericFramesAboveTuple: genAbove, secondSlotPosition }],
			out,
			scopes,
			types,
		)
		return
	}

	if (c.typeId === "[array]" && c.arguments[0]) {
		walkUsageCalls(c.arguments[0]!, declarationScopeId, [...frames, { tag: "forbiddenSite" }], out, scopes, types)
		return
	}

	if (c.typeId === "[pair]" && c.arguments.length >= 2) {
		walkUsageCalls(c.arguments[0]!, declarationScopeId, frames, out, scopes, types)
		walkUsageCalls(c.arguments[1]!, declarationScopeId, [...frames, { tag: "forbiddenSite" }], out, scopes, types)
		return
	}

	if (!c.typeId.startsWith("[") && c.arguments.length > 0) {
		const n = c.arguments.length
		const lastArg = c.arguments[n - 1]!
		const lastArgPosition = lastArg.kind === "call" ? lastArg.position : undefined
		for (let i = 0; i < n; i++) {
			walkUsageCalls(
				c.arguments[i]!,
				declarationScopeId,
				[...frames, { tag: "typeArgs", index: i, count: n, lastArgPosition }],
				out,
				scopes,
				types,
			)
		}
		return
	}

	if (!c.typeId.startsWith("[") && c.arguments.length === 0) {
		const refPos = expectedMonadUsageReferencePosition(frames)
		out.push({
			declarationScopeId,
			typeId: c.typeId,
			position: c.position,
			...(refPos ? { expectedSlotPosition: refPos } : {}),
			wrapped: false,
			kind: classifyMonadUsageLeaf(frames),
		})
		return
	}

	for (const a of c.arguments) walkUsageCalls(a, declarationScopeId, frames, out, scopes, types)
}

function collectMonadCompatibleUsages(
	scopes: Map<string, Scope>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	types: Map<string, ParsedType>,
): MonadCompatibleUsage[] {
	const out: MonadCompatibleUsage[] = []
	for (const declScope of scopes.values()) {
		if (declScope.kind !== "declaration") continue
		if (!declarationTypeByScopeId.has(declScope.id)) continue
		for (const root of declScope.calls) walkUsageCalls(root, declScope.id, [], out, scopes, types)
	}
	return out
}
