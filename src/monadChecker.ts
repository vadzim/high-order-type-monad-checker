import "core-js"
import type { MonadViolationsOptions, MonadViolation, MonadTypeOption } from "./monadCheckerTypes.ts"
import type { ParsedType, ParseTypesResult, Position, Scope, ScopeRef, TypeCall } from "./parseContent.ts"
import { collectLinearMonadReuseViolations } from "./monadLinearUsage.ts"
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
	const allParsedTypes = [...types.values()]

	const scopes = new Map([...input.values().flatMap(({ scopes }) => scopes.entries())])

	const typeIdToDeclarationId = buildTypeIdToDeclarationId(nameToType, types.values())

	const monads = new Set<string>()

	const libertyMonadDeclarationIds = buildLibertyMonadDeclarationIds(
		options.monadTypes,
		nameToType,
		typeIdToDeclarationId,
	)

	addInitialMonads(monads, options.monadTypes, nameToType, typeIdToDeclarationId)

	const violations: MonadViolation[] = []

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

	const scopeChildren = buildScopeChildren(scopes)
	promoteMonadLikeValueAliases(
		monadCompatibleTypeIds,
		types,
		scopes,
		scopeChildren,
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
	collectInvalidImplicitMonadReturns(
		violations,
		input,
		scopeChildren,
		declarationTypeByScopeId,
		typeIdToDeclarationId,
		monadCompatibleTypeIds,
		types,
		resolvedSimpleExtendsByParsedTypeId,
	)

	const monadProducerDeclarationIds = collectMonadProducerDeclarations(
		violations,
		input,
		monadCompatibleTypeIds,
		typeIdToDeclarationId,
		resolvedSimpleExtendsByParsedTypeId,
		types,
		monads,
		libertyMonadDeclarationIds,
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
		libertyMonadDeclarationIds,
	)

	collectInvalidMonadicInferConstraints(
		violations,
		allParsedTypes,
		scopes,
		declarationTypeByScopeId,
		monads,
		monadCompatibleTypeIds,
		typeIdToDeclarationId,
		resolvedSimpleExtendsByParsedTypeId,
		libertyMonadDeclarationIds,
	)

	collectInvalidProducerInvocations(
		violations,
		input,
		monadProducerDeclarationIds,
		typeIdToDeclarationId,
		types,
		monads,
		monadCompatibleTypeIds,
		resolvedSimpleExtendsByParsedTypeId,
		libertyMonadDeclarationIds,
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
		libertyMonadDeclarationIds,
	)
	collectInvalidMonadUsages(
		violations,
		input,
		monads,
		monadCompatibleTypeIds,
		typeIdToDeclarationId,
		resolvedSimpleExtendsByParsedTypeId,
		types,
		libertyMonadDeclarationIds,
	)
	collectLinearMonadReuseViolations(
		violations,
		input,
		monads,
		monadCompatibleTypeIds,
		typeIdToDeclarationId,
		types,
		libertyMonadDeclarationIds,
	)

	return violations.filter(v => !libertyMonadDeclarationIds.has(v.declarationId))
}

function collectInvalidMonadicInferConstraints(
	violations: MonadViolation[],
	types: ParsedType[],
	scopes: Map<string, Scope>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	monads: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	libertyMonadDeclarationIds: Set<string>,
) {
	for (const inferType of types) {
		if (inferType.kind !== "infer") continue
		const extendsTypeId = resolvedSimpleExtendsByParsedTypeId.get(inferType.id)
		if (!extendsTypeId) continue
		if (!typeIdRefersToMonadLike(extendsTypeId, monadCompatibleTypeIds, typeIdToDeclarationId, monads)) continue
		if (
			inferMonadConstraintAllowedInConditionalExtendsCalls(
				scopes,
				inferType,
				monads,
				monadCompatibleTypeIds,
				resolvedSimpleExtendsByParsedTypeId,
				typeIdToDeclarationId,
				types,
			)
		) {
			continue
		}

		const declarationType = findEnclosingDeclarationType(inferType.scopeId, scopes, declarationTypeByScopeId)
		if (!declarationType) continue
		if (libertyMonadDeclarationIds.has(declarationType.id)) continue
		const conditionalScopeId = findNearestAncestorScopeIdOfKind(scopes, inferType.scopeId, "conditional")
		const extendsCalls = conditionalScopeId ? (scopes.get(conditionalScopeId)?.calls ?? []) : []
		violations.push({
			declarationId: declarationType.id,
			kind: "monad.invalidInferConstraint",
			message:
				"A monad-compatible `infer` is only allowed as the entire `extends` target (`Check extends infer Rest extends <monad-like> ? …`, e.g. narrowing to a stream type), or as the first element of a 2-tuple in that position (`[infer Rest extends <monad-like>, infer _]`). The `<monad-like>` type is your `--monad` public type or one promoted as compatible (such as by extending it).",
			position: inferConstraintDiagnosticPosition(extendsCalls, inferType.id, inferType.position),
		})
	}
}

function unwrapReadonlyTupleRoot(call: TypeCall): TypeCall {
	let current: TypeCall = call
	while (
		current.kind === "call" &&
		current.typeId === "[readonly]" &&
		current.arguments.length === 1 &&
		current.arguments[0]?.kind === "call"
	) {
		current = current.arguments[0]
	}
	return current
}

function inferConstraintDiagnosticPosition(
	extendsRoots: TypeCall[],
	inferTypeId: string,
	fallback: Position,
): Position {
	let found: Position | undefined
	const walk = (c: TypeCall | ScopeRef): void => {
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
	monads: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	typeIdToDeclarationId: Map<string, string>,
	types: ParsedType[],
): boolean {
	const conditionalScopeId = findNearestAncestorScopeIdOfKind(scopes, inferType.scopeId, "conditional")
	if (!conditionalScopeId) return false
	const conditional = scopes.get(conditionalScopeId)
	if (!conditional) return false
	const typeById = new Map(types.map(t => [t.id, t] as const))
	const extendsRoot = conditional.calls.length >= 2 ? conditional.calls[1] : undefined
	if (!extendsRoot || extendsRoot.kind !== "call") return false

	if (
		inferIsFirstOfTwoTupleAtExtendsRoot(
			extendsRoot,
			inferType.id,
			monads,
			monadCompatibleTypeIds,
			resolvedSimpleExtendsByParsedTypeId,
			typeIdToDeclarationId,
			typeById,
		)
	) {
		return true
	}
	// `Check extends infer U extends <monad-like> ? …` (e.g. jsql `EmptyTokenList`)
	if (extendsRoot.typeId === inferType.id) {
		const it = typeById.get(inferType.id)
		if (!it || it.kind !== "infer") return false
		const ext = resolvedSimpleExtendsByParsedTypeId.get(inferType.id)
		return ext != null && typeIdRefersToMonadLike(ext, monadCompatibleTypeIds, typeIdToDeclarationId, monads)
	}
	return false
}

/** Same rule as former `inferPlacement`: extends-type root must be a 2-tuple and this infer is its first element. */
function inferIsFirstOfTwoTupleAtExtendsRoot(
	root: TypeCall,
	inferTypeId: string,
	monads: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	typeIdToDeclarationId: Map<string, string>,
	types: Map<string, ParsedType>,
): boolean {
	if (root.kind !== "call") return false
	const normalizedRoot = unwrapReadonlyTupleRoot(root)
	if (normalizedRoot.kind !== "call") return false
	if (normalizedRoot.typeId !== "[tuple]" || normalizedRoot.arguments.length !== 2) return false
	const first = normalizedRoot.arguments[0]
	if (!first || first.kind !== "call" || first.typeId !== inferTypeId) return false
	const inferType = types.get(inferTypeId)
	if (!inferType || inferType.kind !== "infer") return false
	const extendsTypeId = resolvedSimpleExtendsByParsedTypeId.get(inferType.id)
	if (!extendsTypeId) return false
	return typeIdRefersToMonadLike(extendsTypeId, monadCompatibleTypeIds, typeIdToDeclarationId, monads)
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
	libertyMonadDeclarationIds: Set<string>,
) {
	for (const declarationType of declarationTypeByScopeId.values()) {
		if (libertyMonadDeclarationIds.has(declarationType.id)) continue
		const args = declarationType.arguments ?? []
		if (args.length <= 1) continue
		const firstArgType = types.get(args[0]!.typeId)
		const firstTypeParameterPosition = firstArgType?.position

		for (const [idx, arg] of args.entries()) {
			if (idx === 0) continue
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
				message: "Only monad-compatible type parameters may appear in the first generic parameter slot.",
				position: typeParameterConstraintDiagnosticPosition(owners, tpCalls, argType.id, argType.position),
				...(firstTypeParameterPosition ? { relatedPosition: firstTypeParameterPosition } : {}),
			})
		}
	}
}

function collectMonadProducerDeclarations(
	violations: MonadViolation[],
	input: ReadonlyMap<string, ParseTypesResult>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	types: Map<string, ParsedType>,
	monads: Set<string>,
	libertyMonadDeclarationIds: Set<string>,
): Set<string> {
	const declarationById = new Map(
		[...types.values()]
			.filter(t => t.kind === "typeAlias" || t.kind === "interface" || t.kind === "class")
			.map(t => [t.id, t] as const),
	)
	const producerCandidates = new Set<string>()
	for (const declaration of declarationById.values()) {
		if (
			declarationAcceptsMonadParam(
				declaration,
				resolvedSimpleExtendsByParsedTypeId,
				monadCompatibleTypeIds,
				typeIdToDeclarationId,
			)
		) {
			producerCandidates.add(declaration.id)
		}
	}

	const validProducers = new Set(producerCandidates)
	let changed = true
	while (changed) {
		changed = false
		for (const declarationId of [...validProducers]) {
			if (libertyMonadDeclarationIds.has(declarationId)) continue
			const declaration = declarationById.get(declarationId)
			if (!declaration) continue
			const parsed = input.get(declaration.path)
			if (!parsed) continue
			const scopeChildren = buildScopeChildren(parsed.scopes)
			const terminalScopes = getTerminalReturnScopes(declaration.scopeId, parsed.scopes, scopeChildren)
			const allValid = terminalScopes.every(scope =>
				isValidProducerTerminalReturn(
					scope,
					validProducers,
					monadCompatibleTypeIds,
					typeIdToDeclarationId,
					libertyMonadDeclarationIds,
					monads,
					types,
					resolvedSimpleExtendsByParsedTypeId,
				),
			)
			if (allValid) continue
			validProducers.delete(declarationId)
			changed = true
		}
	}

	for (const declarationId of producerCandidates) {
		if (libertyMonadDeclarationIds.has(declarationId)) continue
		if (validProducers.has(declarationId)) continue
		const declaration = declarationById.get(declarationId)
		if (!declaration) continue
		const parsed = input.get(declaration.path)
		if (!parsed) continue
		const scopeChildren = buildScopeChildren(parsed.scopes)
		const terminalScopes = getTerminalReturnScopes(declaration.scopeId, parsed.scopes, scopeChildren)
		for (const scope of terminalScopes) {
			if (
				isValidProducerTerminalReturn(
					scope,
					validProducers,
					monadCompatibleTypeIds,
					typeIdToDeclarationId,
					libertyMonadDeclarationIds,
					monads,
					types,
					resolvedSimpleExtendsByParsedTypeId,
				)
			) {
				continue
			}
			violations.push({
				declarationId: declaration.id,
				kind: "monad.invalidProducerReturn",
				message:
					"Types that accept monad-compatible parameters must return either a 2-item tuple whose first element is monad-like (for example `[Stream, result]` or `infer Rest extends <monad-like>` in that slot), or a direct call to another producer type that satisfies the same contract.",
				position: scope.position,
			})
		}
	}

	return validProducers
}

function declarationAcceptsMonadParam(
	declaration: ParsedType,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
): boolean {
	const args = declaration.arguments ?? []
	if (args.length === 0) return false
	const extendsTypeId = resolvedSimpleExtendsByParsedTypeId.get(args[0]!.typeId)
	if (!extendsTypeId) return false
	const extendsDeclarationId = typeIdToDeclarationId.get(extendsTypeId) ?? extendsTypeId
	return monadCompatibleTypeIds.has(extendsTypeId) || monadCompatibleTypeIds.has(extendsDeclarationId)
}

function getTerminalReturnCall(scope: Scope): TypeCall | undefined {
	if (scope.calls.length !== 1) return undefined
	const root = scope.calls[0]
	if (!root || root.kind !== "call") return undefined
	if (scope.kind === "declaration") {
		return root
	}
	if (scope.kind === "branchTrue" || scope.kind === "branchFalse") {
		return root
	}
	return undefined
}

function isValidProducerTerminalReturn(
	scope: Scope,
	validProducers: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	libertyMonadDeclarationIds: Set<string>,
	monads: Set<string>,
	types: Map<string, ParsedType>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
): boolean {
	const root = getTerminalReturnCall(scope)
	if (!root || root.kind !== "call") return false
	if (root.typeId === "global:never" && root.arguments.length === 0) return true
	if (
		isTupleProducerReturn(
			root,
			monadCompatibleTypeIds,
			typeIdToDeclarationId,
			monads,
			types,
			resolvedSimpleExtendsByParsedTypeId,
		)
	) {
		return true
	}
	if (root.typeId.startsWith("[") || root.arguments.length === 0) return false
	const calleeDeclarationId = typeIdToDeclarationId.get(root.typeId) ?? root.typeId
	// CLI-configured private producer: assumed to satisfy the same contract as `[<monad-like>, result]`.
	if (libertyMonadDeclarationIds.has(calleeDeclarationId)) return true
	return validProducers.has(calleeDeclarationId)
}

function isTupleProducerReturn(
	call: TypeCall,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	monads: Set<string>,
	types: Map<string, ParsedType>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
): boolean {
	if (call.kind !== "call") return false
	const normalizedCall = unwrapReadonlyTupleRoot(call)
	if (normalizedCall.kind !== "call") return false
	if (normalizedCall.typeId !== "[tuple]" || normalizedCall.arguments.length !== 2) return false
	const first = normalizedCall.arguments[0]
	if (!first || first.kind !== "call" || first.typeId.startsWith("[") || first.arguments.length > 0) return false
	const firstType = types.get(first.typeId)
	if (firstType?.kind === "infer") {
		const extendsTypeId = resolvedSimpleExtendsByParsedTypeId.get(first.typeId)
		if (!extendsTypeId) return false
		return typeIdRefersToMonadLike(extendsTypeId, monadCompatibleTypeIds, typeIdToDeclarationId, monads)
	}
	return typeIdRefersToMonadLike(first.typeId, monadCompatibleTypeIds, typeIdToDeclarationId, monads)
}

function collectInvalidProducerInvocations(
	violations: MonadViolation[],
	input: ReadonlyMap<string, ParseTypesResult>,
	monadProducerDeclarationIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	types: Map<string, ParsedType>,
	monads: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	libertyMonadDeclarationIds: Set<string>,
) {
	for (const parsed of input.values()) {
		const localDeclByScope = buildDeclarationTypeByScopeId(parsed.types.values())
		for (const declarationScope of parsed.scopes.values()) {
			if (declarationScope.kind !== "declaration") continue
			const declarationType = localDeclByScope.get(declarationScope.id)
			if (!declarationType) continue
			if (libertyMonadDeclarationIds.has(declarationType.id)) continue
			for (const root of declarationScope.calls) {
				walkProducerInvocations(
					root,
					declarationType.id,
					true,
					parsed.scopes,
					types,
					violations,
					monadProducerDeclarationIds,
					typeIdToDeclarationId,
					monads,
					monadCompatibleTypeIds,
					resolvedSimpleExtendsByParsedTypeId,
				)
			}
		}
	}
}

function walkProducerInvocations(
	call: TypeCall | ScopeRef,
	declarationId: string,
	allowRootProducerCall: boolean,
	scopes: Map<string, Scope>,
	types: Map<string, ParsedType>,
	violations: MonadViolation[],
	monadProducerDeclarationIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	monads: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
) {
	if (call.kind === "scope") {
		const scope = scopes.get(call.scopeId)
		if (!scope) return
		if (scope.kind === "conditional") {
			const checkRoot = scope.calls[0]
			const extendsRoot = scope.calls[1]
			const allowCheck =
				checkRoot != null &&
				extendsRoot != null &&
				isValidProducerConditionalPattern(
					checkRoot,
					extendsRoot,
					monads,
					monadCompatibleTypeIds,
					resolvedSimpleExtendsByParsedTypeId,
					typeIdToDeclarationId,
					types,
				)
			if (checkRoot) {
				walkProducerInvocations(
					checkRoot,
					declarationId,
					allowCheck,
					scopes,
					types,
					violations,
					monadProducerDeclarationIds,
					typeIdToDeclarationId,
					monads,
					monadCompatibleTypeIds,
					resolvedSimpleExtendsByParsedTypeId,
				)
			}
			if (extendsRoot) {
				walkProducerInvocations(
					extendsRoot,
					declarationId,
					false,
					scopes,
					types,
					violations,
					monadProducerDeclarationIds,
					typeIdToDeclarationId,
					monads,
					monadCompatibleTypeIds,
					resolvedSimpleExtendsByParsedTypeId,
				)
			}
			return
		}
		const allowScopeRoot =
			scope.kind === "declaration" || scope.kind === "branchTrue" || scope.kind === "branchFalse"
		for (const root of scope.calls) {
			walkProducerInvocations(
				root,
				declarationId,
				allowScopeRoot,
				scopes,
				types,
				violations,
				monadProducerDeclarationIds,
				typeIdToDeclarationId,
				monads,
				monadCompatibleTypeIds,
				resolvedSimpleExtendsByParsedTypeId,
			)
		}
		return
	}
	if (call.kind !== "call") return
	const calleeDeclarationId = typeIdToDeclarationId.get(call.typeId) ?? call.typeId
	if (
		!call.typeId.startsWith("[") &&
		call.arguments.length > 0 &&
		monadProducerDeclarationIds.has(calleeDeclarationId)
	) {
		if (!allowRootProducerCall) {
			violations.push({
				declarationId,
				kind: "monad.invalidProducerInvocation",
				message:
					"Producer types (declarations whose first generic parameter is monad-compatible) may only be invoked as a direct terminal return value, or as the immediate `extends` check type in the form `Producer<…> extends [infer … extends <monad-like>, infer …]` (do not wrap the producer in a tuple such as `[Producer<…>] extends …`). Do not nest the producer in other expressions.",
				position: call.position,
			})
		}
	}
	for (const arg of call.arguments) {
		walkProducerInvocations(
			arg,
			declarationId,
			false,
			scopes,
			types,
			violations,
			monadProducerDeclarationIds,
			typeIdToDeclarationId,
			monads,
			monadCompatibleTypeIds,
			resolvedSimpleExtendsByParsedTypeId,
		)
	}
}

function isValidProducerConditionalPattern(
	checkRoot: TypeCall,
	extendsRoot: TypeCall,
	monads: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	typeIdToDeclarationId: Map<string, string>,
	types: Map<string, ParsedType>,
): boolean {
	if (checkRoot.kind !== "call" || checkRoot.typeId.startsWith("[") || checkRoot.arguments.length === 0) {
		return false
	}
	if (extendsRoot.kind !== "call") return false
	const normalizedExtends = unwrapReadonlyTupleRoot(extendsRoot)
	if (
		normalizedExtends.kind !== "call" ||
		normalizedExtends.typeId !== "[tuple]" ||
		normalizedExtends.arguments.length !== 2
	) {
		return false
	}
	const first = normalizedExtends.arguments[0]
	if (!first || first.kind !== "call") return false
	const inferType = types.get(first.typeId)
	if (!inferType || inferType.kind !== "infer") return false
	const extendsTypeId = resolvedSimpleExtendsByParsedTypeId.get(inferType.id)
	if (!extendsTypeId) return false
	return typeIdRefersToMonadLike(extendsTypeId, monadCompatibleTypeIds, typeIdToDeclarationId, monads)
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

function collectInvalidImplicitMonadReturns(
	violations: MonadViolation[],
	input: ReadonlyMap<string, ParseTypesResult>,
	scopeChildren: Map<string, string[]>,
	declarationTypeByScopeId: Map<string, ParsedType>,
	typeIdToDeclarationId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
	types: Map<string, ParsedType>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
) {
	for (const { scopes } of input.values()) {
		for (const scope of scopes.values()) {
			if (scope.kind !== "declaration") continue
			const declarationType = declarationTypeByScopeId.get(scope.id)
			if (!declarationType) continue
			if (
				declarationAcceptsMonadParam(
					declarationType,
					resolvedSimpleExtendsByParsedTypeId,
					monadCompatibleTypeIds,
					typeIdToDeclarationId,
				)
			) {
				continue
			}

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

			const invalidScope = terminalScopes.find((terminalScope, idx) => {
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
					"If a declaration without monad-compatible input returns a monad-compatible type in any terminal branch, all terminal branches must return that same monad-compatible type or never.",
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

/** CLI monad roots plus anything promoted as monad-compatible (e.g. `extends TokensList`). */
function typeIdRefersToMonadLike(
	typeId: string,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	monads: Set<string>,
): boolean {
	const declId = typeIdToDeclarationId.get(typeId) ?? typeId
	return monads.has(declId) || monadCompatibleTypeIds.has(typeId) || monadCompatibleTypeIds.has(declId)
}

function monadLikeLeafReference(
	arg: TypeCall | ScopeRef,
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

function calleeFirstTypeParameterReferencePosition(
	calleeDecl: ParsedType,
	types: Map<string, ParsedType>,
	scopes: Map<string, Scope>,
	constraintCallOwnerByScopeId: Map<string, string[]>,
): Position | undefined {
	const args = calleeDecl.arguments
	if (!args?.length) return undefined
	const firstTp = types.get(args[0]!.typeId)
	if (!firstTp || firstTp.kind !== "typeParameter") return undefined
	const tpCalls = scopes.get(firstTp.scopeId)?.calls ?? []
	const owners = constraintCallOwnerByScopeId.get(firstTp.scopeId)
	return typeParameterConstraintDiagnosticPosition(owners, tpCalls, firstTp.id, firstTp.position)
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
	libertyMonadDeclarationIds: Set<string>,
): void {
	if (c.kind !== "call" || c.typeId.startsWith("[") || c.arguments.length === 0) return
	if (types.get(c.typeId)?.kind === "infer") return

	const calleeDecl = getResolvedGenericDeclaration(c.typeId, types, typeIdToDeclarationId)
	if (!calleeDecl?.arguments?.length) return
	if (calleeDecl.arguments.length !== c.arguments.length) return

	const declarationType = declarationTypeByScopeId.get(declarationScopeId)
	if (!declarationType) return
	if (libertyMonadDeclarationIds.has(declarationType.id)) return

	const relatedPosition = calleeFirstTypeParameterReferencePosition(
		calleeDecl,
		types,
		scopes,
		constraintCallOwnerByScopeId,
	)
	const relatedFields = relatedPosition != null ? { relatedPosition, relatedDeclarationId: calleeDecl.id } : {}

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
				"Monadic or monad-like values may only be passed to type parameters whose constraint is monad-compatible (for example `Tokens extends Stream` when `Stream` is your `--monad` public type or inherits monad compatibility from it).",
			position: leaf.position,
			...relatedFields,
		})
	}
}

function walkGenericCalleeConformance(
	c: TypeCall | ScopeRef,
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
	libertyMonadDeclarationIds: Set<string>,
): void {
	const owningDeclaration = declarationTypeByScopeId.get(declarationScopeId)
	if (owningDeclaration && libertyMonadDeclarationIds.has(owningDeclaration.id)) return

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
				libertyMonadDeclarationIds,
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
				libertyMonadDeclarationIds,
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
						libertyMonadDeclarationIds,
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
						libertyMonadDeclarationIds,
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
				libertyMonadDeclarationIds,
			)
		}
		return
	}

	const normalizedTuple = unwrapReadonlyTupleRoot(c)
	if (
		normalizedTuple.kind === "call" &&
		normalizedTuple.typeId === "[tuple]" &&
		normalizedTuple.arguments.length === 2
	) {
		walkGenericCalleeConformance(
			normalizedTuple.arguments[0]!,
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
			libertyMonadDeclarationIds,
		)
		walkGenericCalleeConformance(
			normalizedTuple.arguments[1]!,
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
			libertyMonadDeclarationIds,
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
			libertyMonadDeclarationIds,
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
			libertyMonadDeclarationIds,
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
			libertyMonadDeclarationIds,
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
			libertyMonadDeclarationIds,
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
				libertyMonadDeclarationIds,
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
			libertyMonadDeclarationIds,
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
	libertyMonadDeclarationIds: Set<string>,
) {
	for (const parsed of input.values()) {
		const localDeclByScope = buildDeclarationTypeByScopeId(parsed.types.values())
		for (const declScope of parsed.scopes.values()) {
			if (declScope.kind !== "declaration") continue
			const declarationType = localDeclByScope.get(declScope.id)
			if (!declarationType) continue
			if (libertyMonadDeclarationIds.has(declarationType.id)) continue
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
					libertyMonadDeclarationIds,
				)
			}
		}
	}
}

type MonadUsageContext = {
	declarationId: string
	declarationAcceptsMonad: boolean
	atTerminalRoot: boolean
	allowTupleFirstReturn: boolean
	allowGenericFirstArg: boolean
	allowGenericFirstArgMonadBound: boolean
}

function collectInvalidMonadUsages(
	violations: MonadViolation[],
	input: ReadonlyMap<string, ParseTypesResult>,
	monads: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	types: Map<string, ParsedType>,
	libertyMonadDeclarationIds: Set<string>,
) {
	for (const parsed of input.values()) {
		const scopeChildren = buildScopeChildren(parsed.scopes)
		const localDeclByScope = buildDeclarationTypeByScopeId(parsed.types.values())
		for (const declScope of parsed.scopes.values()) {
			if (declScope.kind !== "declaration") continue
			const declaration = localDeclByScope.get(declScope.id)
			if (!declaration) continue
			if (libertyMonadDeclarationIds.has(declaration.id)) continue
			const declarationAcceptsMonad = declarationAcceptsMonadParam(
				declaration,
				resolvedSimpleExtendsByParsedTypeId,
				monadCompatibleTypeIds,
				typeIdToDeclarationId,
			)
			const terminalScopeIds = new Set(
				getTerminalReturnScopes(declScope.id, parsed.scopes, scopeChildren).map(s => s.id),
			)
			for (const root of declScope.calls) {
				walkMonadUsageConstraints(
					root,
					{
						declarationId: declaration.id,
						declarationAcceptsMonad,
						atTerminalRoot: terminalScopeIds.has(declScope.id),
						allowTupleFirstReturn: false,
						allowGenericFirstArg: false,
						allowGenericFirstArgMonadBound: false,
					},
					parsed.scopes,
					types,
					monads,
					monadCompatibleTypeIds,
					typeIdToDeclarationId,
					resolvedSimpleExtendsByParsedTypeId,
					violations,
					terminalScopeIds,
				)
			}
		}
	}
}

function walkMonadUsageConstraints(
	c: TypeCall | ScopeRef,
	context: MonadUsageContext,
	scopes: Map<string, Scope>,
	types: Map<string, ParsedType>,
	monads: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	violations: MonadViolation[],
	terminalScopeIds: Set<string>,
): void {
	if (c.kind === "scope") {
		const scoped = scopes.get(c.scopeId)
		if (!scoped) return
		const atTerminalRoot =
			scoped.kind === "declaration" || scoped.kind === "branchTrue" || scoped.kind === "branchFalse"
				? terminalScopeIds.has(scoped.id)
				: false
		for (const root of scoped.calls) {
			walkMonadUsageConstraints(
				root,
				{
					...context,
					atTerminalRoot,
					allowTupleFirstReturn: false,
					allowGenericFirstArg: false,
					allowGenericFirstArgMonadBound: false,
				},
				scopes,
				types,
				monads,
				monadCompatibleTypeIds,
				typeIdToDeclarationId,
				resolvedSimpleExtendsByParsedTypeId,
				violations,
				terminalScopeIds,
			)
		}
		return
	}

	if (c.kind !== "call") return
	if (types.get(c.typeId)?.kind === "infer") {
		// `infer X extends Foo` — `Foo` is a bound, not monadic value flow; skip (e.g. `extends Monad`).
		return
	}

	if (!c.typeId.startsWith("[") && c.arguments.length === 0) {
		const declarationId = typeIdToDeclarationId.get(c.typeId) ?? c.typeId
		const isMonadLeaf =
			monads.has(declarationId) ||
			monadCompatibleTypeIds.has(c.typeId) ||
			monadCompatibleTypeIds.has(declarationId)
		if (!isMonadLeaf) return
		const allowedAsGenericFirst = context.allowGenericFirstArg && context.allowGenericFirstArgMonadBound
		const allowedAsTupleFirstReturn = context.allowTupleFirstReturn
		const allowedAsConstructorSingleReturn = context.atTerminalRoot && !context.declarationAcceptsMonad
		if (allowedAsGenericFirst || allowedAsTupleFirstReturn || allowedAsConstructorSingleReturn) return
		violations.push({
			declarationId: context.declarationId,
			kind: "monad.invalidMonadUsage",
			message:
				"Monadic or monad-like types may only be used as: the first generic argument of a callee whose first parameter has a monad-compatible bound; the first element of a returned two-tuple from a producer; or the sole direct return from a declaration that does not take monad-compatible input.",
			position: c.position,
		})
		return
	}

	const normalizedTuple = unwrapReadonlyTupleRoot(c)
	if (
		normalizedTuple.kind === "call" &&
		normalizedTuple.typeId === "[tuple]" &&
		normalizedTuple.arguments.length === 2
	) {
		const [a0, a1] = normalizedTuple.arguments
		if (a0) {
			walkMonadUsageConstraints(
				a0,
				{
					...context,
					atTerminalRoot: false,
					allowTupleFirstReturn: context.atTerminalRoot && context.declarationAcceptsMonad,
				},
				scopes,
				types,
				monads,
				monadCompatibleTypeIds,
				typeIdToDeclarationId,
				resolvedSimpleExtendsByParsedTypeId,
				violations,
				terminalScopeIds,
			)
		}
		if (a1) {
			walkMonadUsageConstraints(
				a1,
				{ ...context, atTerminalRoot: false, allowTupleFirstReturn: false },
				scopes,
				types,
				monads,
				monadCompatibleTypeIds,
				typeIdToDeclarationId,
				resolvedSimpleExtendsByParsedTypeId,
				violations,
				terminalScopeIds,
			)
		}
		return
	}

	if (!c.typeId.startsWith("[") && c.arguments.length > 0) {
		const callee = getResolvedGenericDeclaration(c.typeId, types, typeIdToDeclarationId)
		const firstIndex = 0
		let firstParamMonadBound = false
		if (callee?.arguments?.length === c.arguments.length && callee.arguments[firstIndex]) {
			firstParamMonadBound = calleeTypeParamExtendsMonadCompatible(
				callee.arguments[firstIndex]!.typeId,
				resolvedSimpleExtendsByParsedTypeId,
				monadCompatibleTypeIds,
				typeIdToDeclarationId,
			)
		}
		for (let i = 0; i < c.arguments.length; i++) {
			walkMonadUsageConstraints(
				c.arguments[i]!,
				{
					...context,
					atTerminalRoot: false,
					allowTupleFirstReturn: false,
					allowGenericFirstArg: i === firstIndex,
					allowGenericFirstArgMonadBound: i === firstIndex && firstParamMonadBound,
				},
				scopes,
				types,
				monads,
				monadCompatibleTypeIds,
				typeIdToDeclarationId,
				resolvedSimpleExtendsByParsedTypeId,
				violations,
				terminalScopeIds,
			)
		}
		return
	}

	for (const a of c.arguments) {
		walkMonadUsageConstraints(
			a,
			{ ...context, atTerminalRoot: false, allowTupleFirstReturn: false },
			scopes,
			types,
			monads,
			monadCompatibleTypeIds,
			typeIdToDeclarationId,
			resolvedSimpleExtendsByParsedTypeId,
			violations,
			terminalScopeIds,
		)
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
	const walk = (c: TypeCall | ScopeRef): void => {
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
	if (outer.typeId === "[tuple]" && outer.arguments.length === 1) {
		const only = outer.arguments[0]
		if (!only || only.kind !== "call") return undefined
		if (types.get(only.typeId)?.kind !== "typeParameter") inner = outer
		else inner = only
	}

	if (inner.arguments.length > 0) return undefined
	const tid = !inner.typeId.startsWith("[") ? inner.typeId : undefined
	if (!tid) return undefined
	if (scope.kind === "declaration") {
		// Declaration scopes span the full `type X = …;` statement; the type expression
		// node often ends before the final `;`, so require containment rather than an
		// exact end match (same for leading `export` / trivia on the statement).
		if (outer.position.start < scope.position.start || outer.position.end > scope.position.end) {
			return undefined
		}
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

/**
 * Promote type aliases whose definition reduces only to `never` or to a monad-like value
 * (including `… extends infer R extends <monad-like> ? R : never`), e.g. `EmptyTokenList` in jsql.
 */
function promoteMonadLikeValueAliases(
	monadCompatibleTypeIds: Set<string>,
	types: Map<string, ParsedType>,
	scopes: Map<string, Scope>,
	scopeChildren: Map<string, string[]>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	typeIdToDeclarationId: Map<string, string>,
	monads: Set<string>,
) {
	let changed = true
	while (changed) {
		changed = false
		for (const t of types.values()) {
			if (t.kind !== "typeAlias") continue
			if (monadCompatibleTypeIds.has(t.id)) continue
			if (
				typeAliasBodyYieldsMonadLikeValue(
					t,
					types,
					scopes,
					scopeChildren,
					resolvedSimpleExtendsByParsedTypeId,
					monadCompatibleTypeIds,
					typeIdToDeclarationId,
					monads,
					new Set(),
				)
			) {
				monadCompatibleTypeIds.add(t.id)
				changed = true
			}
		}
	}
}

function typeAliasBodyYieldsMonadLikeValue(
	alias: ParsedType,
	types: Map<string, ParsedType>,
	scopes: Map<string, Scope>,
	scopeChildren: Map<string, string[]>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	monads: Set<string>,
	visitingAliasIds: Set<string>,
): boolean {
	const declScope = scopes.get(alias.scopeId)
	if (!declScope || declScope.kind !== "declaration") return false
	const terminalScopes = getTerminalReturnScopes(alias.scopeId, scopes, scopeChildren)
	if (terminalScopes.length === 0) return false
	return terminalScopes.every(terminalScope =>
		terminalReturnIsMonadLikeOrNever(
			terminalScope,
			types,
			scopes,
			scopeChildren,
			resolvedSimpleExtendsByParsedTypeId,
			monadCompatibleTypeIds,
			typeIdToDeclarationId,
			monads,
			visitingAliasIds,
		),
	)
}

function terminalReturnIsMonadLikeOrNever(
	terminalScope: Scope,
	types: Map<string, ParsedType>,
	scopes: Map<string, Scope>,
	scopeChildren: Map<string, string[]>,
	resolvedSimpleExtendsByParsedTypeId: Map<string, string>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	monads: Set<string>,
	visitingAliasIds: Set<string>,
): boolean {
	const tid = getDirectTerminalTypeId(terminalScope, types)
	if (tid === undefined) return false
	if (tid === "global:never") return true
	if (typeIdRefersToMonadLike(tid, monadCompatibleTypeIds, typeIdToDeclarationId, monads)) return true
	const p = types.get(tid)
	if (p?.kind === "infer") {
		const ext = resolvedSimpleExtendsByParsedTypeId.get(tid)
		return ext != null && typeIdRefersToMonadLike(ext, monadCompatibleTypeIds, typeIdToDeclarationId, monads)
	}
	if (p?.kind === "typeAlias") {
		if (visitingAliasIds.has(p.id)) return false
		visitingAliasIds.add(p.id)
		const nested = typeAliasBodyYieldsMonadLikeValue(
			p,
			types,
			scopes,
			scopeChildren,
			resolvedSimpleExtendsByParsedTypeId,
			monadCompatibleTypeIds,
			typeIdToDeclarationId,
			monads,
			visitingAliasIds,
		)
		visitingAliasIds.delete(p.id)
		return nested
	}
	return false
}

function buildLibertyMonadDeclarationIds(
	specs: readonly MonadTypeOption[],
	nameToType: Map<string, Map<string, ParsedType>>,
	typeIdToDeclarationId: Map<string, string>,
): Set<string> {
	const out = new Set<string>()
	for (const spec of specs) {
		const publicType = nameToType.get(spec.path)?.get(spec.name)
		if (!publicType) {
			throw new Error(`Monad public type not found: ${spec.path} ${spec.name}`)
		}
		if (publicType.kind !== "typeAlias" && publicType.kind !== "interface" && publicType.kind !== "class") {
			throw new Error(`Monad public type is not a declaration: ${spec.path} ${spec.name}`)
		}

		const privateType = nameToType.get(spec.path)?.get(spec.consumerName)
		if (!privateType) {
			throw new Error(`Monad private type not found: ${spec.path} ${spec.consumerName}`)
		}
		if (privateType.kind !== "typeAlias" && privateType.kind !== "interface" && privateType.kind !== "class") {
			throw new Error(`Monad private type is not a declaration: ${spec.path} ${spec.consumerName}`)
		}

		out.add(typeIdToDeclarationId.get(privateType.id) ?? privateType.id)
	}
	return out
}

function addInitialMonads(
	monads: Set<string>,
	monadTypes: readonly MonadTypeOption[],
	nameToType: Map<string, Map<string, ParsedType>>,
	typeIdToDeclarationId: Map<string, string>,
) {
	for (const spec of monadTypes) {
		const publicType = nameToType.get(spec.path)?.get(spec.name)
		const privateType = nameToType.get(spec.path)?.get(spec.consumerName)
		if (!publicType || !privateType) continue

		for (const t of [publicType, privateType]) {
			const declId = typeIdToDeclarationId.get(t.id) ?? t.id
			monads.add(declId)
		}
	}
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

	const visit = (c: TypeCall | ScopeRef): void => {
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
