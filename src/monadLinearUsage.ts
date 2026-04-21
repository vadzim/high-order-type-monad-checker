import type { MonadViolation } from "./monadCheckerTypes.ts"
import type { ParsedType, ParseTypesResult, Position, Scope, ScopeRef, TypeCall } from "./parseContent.ts"

export function collectLinearMonadReuseViolations(
	violations: MonadViolation[],
	input: ReadonlyMap<string, ParseTypesResult>,
	monads: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	types: Map<string, ParsedType>,
	libertyMonadDeclarationIds: Set<string>,
) {
	for (const parsed of input.values()) {
		const localDeclByScope = buildDeclarationTypeByScopeId(parsed.types.values())
		for (const declScope of parsed.scopes.values()) {
			if (declScope.kind !== "declaration") continue
			const declaration = localDeclByScope.get(declScope.id)
			if (!declaration) continue
			if (libertyMonadDeclarationIds.has(declaration.id)) continue
			const consumedByScope = new Map<string, Map<string, Position>>()
			for (const root of declScope.calls) {
				walkLinearMonadUsage(
					root,
					declScope.id,
					declaration.id,
					consumedByScope,
					parsed.scopes,
					types,
					monads,
					monadCompatibleTypeIds,
					typeIdToDeclarationId,
					violations,
				)
			}
		}
	}
}

function walkLinearMonadUsage(
	c: TypeCall | ScopeRef,
	currentScopeId: string,
	declarationId: string,
	consumedByScope: Map<string, Map<string, Position>>,
	scopes: Map<string, Scope>,
	types: Map<string, ParsedType>,
	monads: Set<string>,
	monadCompatibleTypeIds: Set<string>,
	typeIdToDeclarationId: Map<string, string>,
	violations: MonadViolation[],
) {
	if (c.kind === "scope") {
		const scoped = scopes.get(c.scopeId)
		if (!scoped) return
		if (scoped.kind === "conditional") {
			const check = scoped.calls[0]
			const ext = scoped.calls[1]
			if (check) {
				walkLinearMonadUsage(
					check,
					scoped.id,
					declarationId,
					consumedByScope,
					scopes,
					types,
					monads,
					monadCompatibleTypeIds,
					typeIdToDeclarationId,
					violations,
				)
			}
			if (ext) {
				walkLinearMonadUsage(
					ext,
					scoped.id,
					declarationId,
					consumedByScope,
					scopes,
					types,
					monads,
					monadCompatibleTypeIds,
					typeIdToDeclarationId,
					violations,
				)
			}
			return
		}
		const branchState = cloneConsumedState(consumedByScope)
		for (const root of scoped.calls) {
			walkLinearMonadUsage(
				root,
				scoped.id,
				declarationId,
				branchState,
				scopes,
				types,
				monads,
				monadCompatibleTypeIds,
				typeIdToDeclarationId,
				violations,
			)
		}
		return
	}

	if (c.kind !== "call") return
	const parsedType = types.get(c.typeId)
	if (parsedType?.kind === "infer") {
		for (const a of c.arguments) {
			walkLinearMonadUsage(
				a,
				currentScopeId,
				declarationId,
				consumedByScope,
				scopes,
				types,
				monads,
				monadCompatibleTypeIds,
				typeIdToDeclarationId,
				violations,
			)
		}
		return
	}

	if (!c.typeId.startsWith("[") && c.arguments.length === 0) {
		const declarationTypeId = typeIdToDeclarationId.get(c.typeId) ?? c.typeId
		const isMonadLike =
			monads.has(declarationTypeId) ||
			monadCompatibleTypeIds.has(c.typeId) ||
			monadCompatibleTypeIds.has(declarationTypeId)
		const isVariableLike = parsedType?.kind === "typeParameter"
		if (isMonadLike && isVariableLike) {
			const first = findConsumedInScopeChain(consumedByScope, currentScopeId, c.typeId, scopes)
			if (first) {
				violations.push({
					declarationId,
					kind: "monad.consumeMultipleInPath",
					message:
						"Monadic or monad-like type parameters are linear: after the first use they cannot be used again in the same scope or descendant scopes.",
					position: c.position,
					relatedPosition: first,
				})
			} else {
				const local = consumedByScope.get(currentScopeId) ?? new Map<string, Position>()
				local.set(c.typeId, c.position)
				consumedByScope.set(currentScopeId, local)
			}
		}
		return
	}

	for (const a of c.arguments) {
		walkLinearMonadUsage(
			a,
			currentScopeId,
			declarationId,
			consumedByScope,
			scopes,
			types,
			monads,
			monadCompatibleTypeIds,
			typeIdToDeclarationId,
			violations,
		)
	}
}

function findConsumedInScopeChain(
	consumedByScope: Map<string, Map<string, Position>>,
	scopeId: string,
	typeId: string,
	scopes: Map<string, Scope>,
): Position | undefined {
	let cursor: string | null | undefined = scopeId
	while (cursor) {
		const local = consumedByScope.get(cursor)
		const pos = local?.get(typeId)
		if (pos) return pos
		cursor = scopes.get(cursor)?.parentScopeId
	}
	return undefined
}

function cloneConsumedState(state: Map<string, Map<string, Position>>): Map<string, Map<string, Position>> {
	return new Map([...state.entries()].map(([scopeId, used]) => [scopeId, new Map(used)]))
}

function buildDeclarationTypeByScopeId(types: IteratorObject<ParsedType>) {
	return new Map(
		types
			.filter(t => t.kind === "typeAlias" || t.kind === "interface" || t.kind === "class")
			.map(t => [t.scopeId, t] as const),
	)
}
