import path from "node:path"
import ts from "typescript"

// parseTypes responsibility boundary:
// - build a syntax-derived graph (types/scopes/calls)
// - do not perform any analysis, stay policy-neutral (no reader/consumer/monad rule decisions)

export function parseFilesContent(
	files: Map<string, string>,
	options: ParseTypesOptions = {},
): Map<string, ParseTypesResult> {
	const parsed = new Map(
		files
			.entries()
			.map(([path, content], index) => [
				path,
				parseTypes(path, content, { idPrefix: `${options.idPrefix ?? ""}f-${index}:` }),
			]),
	)

	return parsed
}

export function parseTypes(filePath: string, content: string, options: ParseTypesOptions = {}): ParseTypesResult {
	const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	const types = new Map<string, ParsedType>()
	const scopes = new Map<string, Scope>()
	const bindingsByScopeId = new Map<string, Map<string, string>>()
	const pendingInferBindingsByConditionalScopeId = new Map<string, Array<{ name: string; typeId: string }>>()
	let nextType = 0
	let nextScope = 0
	const conditionalBranchScopes = new WeakMap<
		ts.ConditionalTypeNode,
		{ conditional: string; trueBranch: string; falseBranch: string }
	>()
	const inferAstToTypeId = new WeakMap<ts.InferTypeNode, string>()

	const mkTypeCall = (typeId: string, position: Position, args: TypeCall[] = []): TypeCall => ({
		kind: "call",
		typeId,
		position,
		arguments: args,
	})
	const mkScopeRef = (scopeId: string): TypeCall => ({ kind: "scope", scopeId })

	const scopeStack: string[] = []

	const mkTypeId = () => `${options.idPrefix ?? "id"}-t-${nextType++}`
	const mkScopeId = () => `${options.idPrefix ?? "id"}-s-${nextScope++}`

	const rootScopeId = mkScopeId()
	scopes.set(rootScopeId, {
		id: rootScopeId,
		path: filePath,
		kind: "file",
		parentScopeId: null,
		position: toPos(0, content.length),
		calls: [],
	})
	bindingsByScopeId.set(rootScopeId, new Map())
	scopeStack.push(rootScopeId)

	const currentScope = () => scopeStack[scopeStack.length - 1]!
	const scopeById = (id: string): Scope | undefined => scopes.get(id)
	const bindTypeName = (scopeId: string, name: string, typeId: string) => {
		const scopeBindings = bindingsByScopeId.get(scopeId) ?? new Map<string, string>()
		scopeBindings.set(name, typeId)
		bindingsByScopeId.set(scopeId, scopeBindings)
	}
	const resolveTypeIdByName = (name: string, scopeId: string): string => {
		let cursor: string | null | undefined = scopeId
		while (cursor) {
			const local = bindingsByScopeId.get(cursor)?.get(name)
			if (local) return local
			cursor = scopeById(cursor)?.parentScopeId
		}
		return `global:${name}`
	}
	const findNearestScopeByKind = (scopeId: string, kind: Scope["kind"]): Scope | undefined => {
		let cursor: string | null | undefined = scopeId
		while (cursor) {
			const scope = scopeById(cursor)
			if (!scope) break
			if (scope.kind === kind) return scope
			cursor = scope.parentScopeId
		}
		return undefined
	}

	const pushScope = (kind: Scope["kind"], node: ts.Node, name?: string): string => {
		const id = mkScopeId()
		scopes.set(id, {
			id,
			path: filePath,
			kind,
			parentScopeId: currentScope(),
			name,
			position: toPos(node.getStart(sourceFile), node.getEnd()),
			calls: [],
		})
		bindingsByScopeId.set(id, new Map())
		scopeStack.push(id)
		return id
	}

	const popScope = () => {
		scopeStack.pop()
	}

	const registerParsedType = (
		name: string,
		kind: ParsedType["kind"],
		node: ts.Node,
		cfg: Omit<Partial<ParsedType>, "id" | "name" | "path" | "scopeId" | "kind" | "position"> = {},
	): ParsedType => {
		const start = node.getStart(sourceFile)
		const base: ParsedType = {
			id: mkTypeId(),
			name,
			path: filePath,
			refPath: filePath,
			refName: name,
			scopeId: currentScope(),
			kind,
			position: toPos(start, node.getEnd()),
			...cfg,
		}
		if (!base.refPath) base.refPath = filePath
		types.set(base.id, base)
		return base
	}

	const propertyNameToPseudoCall = (name: ts.PropertyName): TypeCall => {
		const pos = toPos(name.getStart(sourceFile), name.getEnd())
		if (ts.isIdentifier(name)) return mkTypeCall(`[${JSON.stringify(name.text)}]`, pos)
		if (ts.isStringLiteralLike(name)) return mkTypeCall(`[${JSON.stringify(name.text)}]`, pos)
		if (ts.isNumericLiteral(name)) return mkTypeCall(`[${name.text}]`, pos)
		if (ts.isBigIntLiteral(name)) return mkTypeCall(`[${name.text}]`, pos)
		return mkTypeCall(P.unknown, pos)
	}

	const templateTextPseudo = (text: string, pos: Position): TypeCall =>
		mkTypeCall(`[${JSON.stringify(text)}]`, pos, [])

	const literalTypeToPseudoCall = (node: ts.LiteralTypeNode): TypeCall => {
		const pos = toPos(node.getStart(sourceFile), node.getEnd())
		const lit = node.literal
		if (lit.kind === ts.SyntaxKind.NullKeyword) return mkTypeCall("[null]", pos)
		if (lit.kind === ts.SyntaxKind.TrueKeyword) return mkTypeCall("[true]", pos)
		if (lit.kind === ts.SyntaxKind.FalseKeyword) return mkTypeCall("[false]", pos)
		if (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit))
			return mkTypeCall(`[${JSON.stringify(lit.text)}]`, pos)
		if (ts.isNumericLiteral(lit)) return mkTypeCall(`[${lit.text}]`, pos)
		if (ts.isBigIntLiteral(lit)) return mkTypeCall(`[${lit.text}]`, pos)
		if (
			ts.isPrefixUnaryExpression(lit) &&
			lit.operator === ts.SyntaxKind.MinusToken &&
			ts.isNumericLiteral(lit.operand)
		) {
			return mkTypeCall(`[-${lit.operand.text}]`, pos)
		}
		return mkTypeCall(P.unknown, pos)
	}

	const intrinsicPseudoTypeId = (node: ts.TypeNode): string | undefined => {
		const n = intrinsicTypeName(node)
		return n ? `global:${n}` : undefined
	}

	function buildTypeCall(node: ts.TypeNode): TypeCall {
		const fullSpan = () => toPos(node.getStart(sourceFile), node.getEnd())

		if (ts.isParenthesizedTypeNode(node)) return buildTypeCall(node.type)

		if (ts.isTypeReferenceNode(node)) {
			const name = node.typeName.getText(sourceFile)
			const typeId = resolveTypeIdByName(name, currentScope())
			const args = (node.typeArguments ?? []).map(buildTypeCall)
			return mkTypeCall(typeId, fullSpan(), args)
		}

		if (ts.isArrayTypeNode(node)) {
			return mkTypeCall(P.array, fullSpan(), [buildTypeCall(node.elementType)])
		}

		if (ts.isTupleTypeNode(node)) {
			const args = node.elements.map(el => {
				if (ts.isNamedTupleMember(el)) {
					const pairArgs: TypeCall[] = [propertyNameToPseudoCall(el.name)]
					if (el.type) pairArgs.push(buildTypeCall(el.type))
					return mkTypeCall(P.pair, toPos(el.getStart(sourceFile), el.getEnd()), pairArgs)
				}
				if (ts.isRestTypeNode(el)) return buildTypeCall(el)
				return buildTypeCall(el as ts.TypeNode)
			})
			return mkTypeCall(P.tuple, fullSpan(), args)
		}

		if (ts.isRestTypeNode(node)) {
			return mkTypeCall(P.rest, fullSpan(), [buildTypeCall(node.type)])
		}

		if (ts.isOptionalTypeNode(node)) {
			return mkTypeCall(P.optional, fullSpan(), [buildTypeCall(node.type)])
		}

		if (ts.isUnionTypeNode(node)) {
			return mkTypeCall(P.union, fullSpan(), node.types.map(buildTypeCall))
		}

		if (ts.isIntersectionTypeNode(node)) {
			return mkTypeCall(P.intersection, fullSpan(), node.types.map(buildTypeCall))
		}

		if (ts.isConditionalTypeNode(node)) {
			const ids = conditionalBranchScopes.get(node)
			if (!ids) {
				return mkTypeCall(P.conditional, fullSpan(), [])
			}
			return mkTypeCall(P.conditional, fullSpan(), [
				mkScopeRef(ids.conditional),
				mkScopeRef(ids.trueBranch),
				mkScopeRef(ids.falseBranch),
			])
		}

		if (ts.isInferTypeNode(node)) {
			const inner: TypeCall[] = []
			if (node.typeParameter.constraint) inner.push(buildTypeCall(node.typeParameter.constraint))
			const inferId = inferAstToTypeId.get(node)
			return mkTypeCall(inferId ?? P.infer, fullSpan(), inner)
		}

		if (ts.isTypeLiteralNode(node)) {
			const args: TypeCall[] = []
			for (const m of node.members) {
				if (ts.isPropertySignature(m) && m.type && m.name) {
					args.push(
						mkTypeCall(P.pair, toPos(m.getStart(sourceFile), m.getEnd()), [
							propertyNameToPseudoCall(m.name),
							buildTypeCall(m.type),
						]),
					)
				} else if (ts.isMethodSignature(m) && m.type) {
					const ma: TypeCall[] = []
					for (const p of m.parameters) {
						if (p.type) ma.push(buildTypeCall(p.type))
					}
					ma.push(buildTypeCall(m.type))
					args.push(mkTypeCall(P.function, toPos(m.getStart(sourceFile), m.getEnd()), ma))
				} else if ((ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m)) && m.type) {
					const ma: TypeCall[] = []
					for (const p of m.parameters) {
						if (p.type) ma.push(buildTypeCall(p.type))
					}
					ma.push(buildTypeCall(m.type))
					const pseudo = ts.isConstructSignatureDeclaration(m) ? P.constructor : P.function
					args.push(mkTypeCall(pseudo, toPos(m.getStart(sourceFile), m.getEnd()), ma))
				} else if (ts.isIndexSignatureDeclaration(m) && m.type) {
					const ma: TypeCall[] = []
					for (const el of m.parameters) {
						if (el.type) ma.push(buildTypeCall(el.type))
					}
					ma.push(buildTypeCall(m.type))
					args.push(mkTypeCall(P.pair, toPos(m.getStart(sourceFile), m.getEnd()), ma))
				}
			}
			return mkTypeCall(P.object, fullSpan(), args)
		}

		if (ts.isIndexedAccessTypeNode(node)) {
			return mkTypeCall(P.indexedAccess, fullSpan(), [
				buildTypeCall(node.objectType),
				buildTypeCall(node.indexType),
			])
		}

		if (ts.isMappedTypeNode(node)) {
			const args: TypeCall[] = []
			if (node.typeParameter.constraint) args.push(buildTypeCall(node.typeParameter.constraint))
			if (node.nameType) args.push(buildTypeCall(node.nameType))
			if (node.type) args.push(buildTypeCall(node.type))
			return mkTypeCall(P.mapped, fullSpan(), args)
		}

		if (ts.isTypeOperatorNode(node)) {
			const op = node.operator
			let pseudo: string = P.unknown
			if (op === ts.SyntaxKind.ReadonlyKeyword) pseudo = P.readonly
			else if (op === ts.SyntaxKind.KeyOfKeyword) pseudo = P.keyof
			else if (op === ts.SyntaxKind.UniqueKeyword) pseudo = P.unique
			return mkTypeCall(pseudo, fullSpan(), [buildTypeCall(node.type)])
		}

		if (ts.isLiteralTypeNode(node)) {
			return literalTypeToPseudoCall(node)
		}

		if (ts.isTemplateLiteralTypeNode(node)) {
			const args: TypeCall[] = []
			args.push(templateTextPseudo(node.head.text, toPos(node.head.getStart(sourceFile), node.head.getEnd())))
			for (const span of node.templateSpans) {
				args.push(buildTypeCall(span.type))
				args.push(
					templateTextPseudo(
						span.literal.text,
						toPos(span.literal.getStart(sourceFile), span.literal.getEnd()),
					),
				)
			}
			return mkTypeCall(P.template, fullSpan(), args)
		}

		if (ts.isThisTypeNode(node)) {
			return mkTypeCall(P.this, fullSpan(), [])
		}

		if (ts.isTypeQueryNode(node)) {
			const namePos = toPos(node.exprName.getStart(sourceFile), node.exprName.getEnd())
			const text = node.exprName.getText(sourceFile)
			return mkTypeCall(P.query, fullSpan(), [mkTypeCall(`[${JSON.stringify(text)}]`, namePos, [])])
		}

		if (ts.isImportTypeNode(node)) {
			const args: TypeCall[] = []
			if (node.typeArguments?.length) args.push(...node.typeArguments.map(buildTypeCall))
			return mkTypeCall(P.import, fullSpan(), args)
		}

		if (ts.isFunctionTypeNode(node)) {
			const args: TypeCall[] = []
			for (const p of node.parameters) {
				if (p.type) args.push(buildTypeCall(p.type))
			}
			args.push(buildTypeCall(node.type))
			return mkTypeCall(P.function, fullSpan(), args)
		}

		if (ts.isConstructorTypeNode(node)) {
			const args: TypeCall[] = []
			for (const p of node.parameters) {
				if (p.type) args.push(buildTypeCall(p.type))
			}
			if (node.type) args.push(buildTypeCall(node.type))
			return mkTypeCall(P.constructor, fullSpan(), args)
		}

		const kw = intrinsicPseudoTypeId(node)
		if (kw) {
			return mkTypeCall(kw, fullSpan(), [])
		}

		return mkTypeCall(P.unknown, fullSpan(), [])
	}

	const walkScopes = (part: ts.TypeNode) => {
		if (ts.isConditionalTypeNode(part)) {
			const conditionalScopeId = pushScope("conditional", part)
			walkScopes(part.checkType)
			walkScopes(part.extendsType)
			const condScope = scopes.get(conditionalScopeId)
			if (condScope) {
				condScope.calls.push(buildTypeCall(part.checkType))
				condScope.calls.push(buildTypeCall(part.extendsType))
			}
			const branchTrueScopeId = pushScope("branchTrue", part.trueType)
			const trueScope = scopes.get(branchTrueScopeId)
			if (trueScope) trueScope.calls.push(buildTypeCall(part.trueType))
			for (const inferBinding of pendingInferBindingsByConditionalScopeId.get(conditionalScopeId) ?? []) {
				bindTypeName(branchTrueScopeId, inferBinding.name, inferBinding.typeId)
			}
			walkScopes(part.trueType)
			popScope()
			const branchFalseScopeId = pushScope("branchFalse", part.falseType)
			const falseScope = scopes.get(branchFalseScopeId)
			if (falseScope) falseScope.calls.push(buildTypeCall(part.falseType))
			conditionalBranchScopes.set(part, {
				conditional: conditionalScopeId,
				trueBranch: branchTrueScopeId,
				falseBranch: branchFalseScopeId,
			})
			walkScopes(part.falseType)
			popScope()
			popScope()
			return
		}
		if (ts.isInferTypeNode(part)) {
			const inferName = part.typeParameter.name.text
			pushScope("infer", part, inferName)
			const inferType = registerParsedType(inferName, "infer", part.typeParameter.name, {})
			inferAstToTypeId.set(part, inferType.id)
			const conditionalScope = findNearestScopeByKind(currentScope(), "conditional")
			if (conditionalScope) {
				const inferBindings = pendingInferBindingsByConditionalScopeId.get(conditionalScope.id) ?? []
				inferBindings.push({ name: inferName, typeId: inferType.id })
				pendingInferBindingsByConditionalScopeId.set(conditionalScope.id, inferBindings)
			}
			if (part.typeParameter.constraint) walkScopes(part.typeParameter.constraint)
			popScope()
			return
		}
		if (ts.isParenthesizedTypeNode(part)) {
			walkScopes(part.type)
			return
		}
		if (ts.isTypeReferenceNode(part)) {
			for (const arg of part.typeArguments ?? []) walkScopes(arg)
			return
		}
		if (ts.isArrayTypeNode(part)) {
			walkScopes(part.elementType)
			return
		}
		if (ts.isUnionTypeNode(part) || ts.isIntersectionTypeNode(part)) {
			for (const t of part.types) walkScopes(t)
			return
		}
		if (ts.isTupleTypeNode(part)) {
			for (const el of part.elements) {
				if (ts.isNamedTupleMember(el)) {
					if (el.type) walkScopes(el.type)
				} else if (ts.isRestTypeNode(el)) {
					walkScopes(el.type)
				} else {
					walkScopes(el as ts.TypeNode)
				}
			}
			return
		}
		if (ts.isRestTypeNode(part) || ts.isOptionalTypeNode(part)) {
			walkScopes(part.type)
			return
		}
		if (ts.isIndexedAccessTypeNode(part)) {
			walkScopes(part.objectType)
			walkScopes(part.indexType)
			return
		}
		if (ts.isMappedTypeNode(part)) {
			if (part.typeParameter.constraint) walkScopes(part.typeParameter.constraint)
			if (part.nameType) walkScopes(part.nameType)
			if (part.type) walkScopes(part.type)
			return
		}
		if (ts.isTypeOperatorNode(part)) {
			walkScopes(part.type)
			return
		}
		if (ts.isTypeLiteralNode(part)) {
			for (const m of part.members) walkScopesInMember(m)
			return
		}
		if (ts.isFunctionTypeNode(part) || ts.isConstructorTypeNode(part)) {
			for (const p of part.parameters) {
				if (p.type) walkScopes(p.type)
			}
			if (ts.isFunctionTypeNode(part)) walkScopes(part.type)
			else if (part.type) walkScopes(part.type)
			return
		}
		if (ts.isImportTypeNode(part)) {
			if (part.typeArguments) for (const a of part.typeArguments) walkScopes(a)
			return
		}
		const visitNestedTypeNodes = (current: ts.Node) => {
			ts.forEachChild(current, child => {
				if (ts.isTypeNode(child)) walkScopes(child)
				else visitNestedTypeNodes(child)
			})
		}
		visitNestedTypeNodes(part)
	}

	function walkScopesInMember(m: ts.TypeElement) {
		if (ts.isPropertySignature(m) && m.type) walkScopes(m.type)
		else if (ts.isMethodSignature(m)) {
			if (m.type) walkScopes(m.type)
			for (const p of m.parameters) {
				if (p.type) walkScopes(p.type)
			}
		} else if (ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m)) {
			for (const p of m.parameters) {
				if (p.type) walkScopes(p.type)
			}
			if (m.type) walkScopes(m.type)
		} else if (ts.isIndexSignatureDeclaration(m)) {
			for (const el of m.parameters) {
				if (el.type) walkScopes(el.type)
			}
			if (m.type) walkScopes(m.type)
		}
	}

	const emitCalls = (part: ts.TypeNode) => {
		const scope = scopes.get(currentScope())
		if (!scope) return
		if (ts.isParenthesizedTypeNode(part)) {
			emitCalls(part.type)
			return
		}
		if (ts.isUnionTypeNode(part) || ts.isIntersectionTypeNode(part)) {
			scope.calls.push(buildTypeCall(part))
			return
		}
		scope.calls.push(buildTypeCall(part))
	}

	const pushConstraintRootCall = (scopeId: string, c: TypeCall) => {
		const scope = scopes.get(scopeId)
		if (!scope) return
		scope.calls.push(c)
	}

	/** Walk constraint subtree, then emit one constraint root into the type-parameters scope. */
	const collectTypeRefsForTypeParamConstraint = (part: ts.TypeNode) => {
		walkScopes(part)
		const scopeId = currentScope()
		const pushRoot = (c: TypeCall) => {
			pushConstraintRootCall(scopeId, c)
		}
		if (ts.isParenthesizedTypeNode(part)) {
			collectTypeRefsForTypeParamConstraint(part.type)
			return
		}
		if (ts.isUnionTypeNode(part) || ts.isIntersectionTypeNode(part)) {
			pushRoot(buildTypeCall(part))
			return
		}
		pushRoot(buildTypeCall(part))
	}

	const collectTypeRefs = (node: ts.TypeNode) => {
		walkScopes(node)
		emitCalls(node)
	}

	const collectTypeParams = (
		node: { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> },
		bindingScopeId: string,
	): { name: string; extendsTypeName?: string; typeId: string }[] => {
		const out: { name: string; extendsTypeName?: string; typeId: string }[] = []
		const tps = node.typeParameters ?? []
		for (const tp of tps) {
			const parsedType = registerParsedType(tp.name.text, "typeParameter", tp.name, {})
			bindTypeName(bindingScopeId, tp.name.text, parsedType.id)
			if (tp.constraint && ts.isTypeReferenceNode(tp.constraint) && tp.constraint.typeName.getText(sourceFile)) {
				out.push({
					name: tp.name.text,
					extendsTypeName: tp.constraint.typeName.getText(sourceFile),
					typeId: parsedType.id,
				})
			} else {
				out.push({ name: tp.name.text, typeId: parsedType.id })
			}
			if (tp.constraint) collectTypeRefsForTypeParamConstraint(tp.constraint)
		}
		return out
	}

	const collectTypeStructure = (node: ts.TypeNode) => {
		walkScopes(node)
		emitCalls(node)
	}

	for (const stmt of sourceFile.statements) {
		if (ts.isImportDeclaration(stmt) && stmt.importClause) {
			const moduleText = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : ""
			const importClause = stmt.importClause
			const bind = importClause.namedBindings
			if (bind && ts.isNamedImports(bind)) {
				for (const el of bind.elements) {
					const localName = el.name.text
					const exportedName = el.propertyName?.text ?? localName
					const parsedType = registerParsedType(localName, "imported", el.name, {
						refPath: normalizeImportRef(filePath, moduleText),
						refName: exportedName,
					})
					bindTypeName(rootScopeId, localName, parsedType.id)
				}
			}
			continue
		}

		if (ts.isTypeAliasDeclaration(stmt)) {
			const declScopeId = pushScope("declaration", stmt, stmt.name.text)
			const declType = registerParsedType(stmt.name.text, "typeAlias", stmt.name, {})
			bindTypeName(rootScopeId, stmt.name.text, declType.id)
			pushScope("typeParameters", stmt, `${stmt.name.text}.typeParameters`)
			const typeParameters = collectTypeParams(stmt, declScopeId)
			popScope()
			declType.arguments = typeParameters.map(tp => ({ typeId: tp.typeId }))
			collectTypeStructure(stmt.type)
			popScope()
			continue
		}

		if (ts.isInterfaceDeclaration(stmt)) {
			const parsedType = registerParsedType(stmt.name.text, "interface", stmt.name, {})
			bindTypeName(rootScopeId, stmt.name.text, parsedType.id)
			const declScopeId = pushScope("declaration", stmt, stmt.name.text)
			if (stmt.typeParameters?.length) {
				pushScope("typeParameters", stmt, `${stmt.name.text}.typeParameters`)
				const typeParameters = collectTypeParams(stmt, declScopeId)
				parsedType.arguments = typeParameters.map(tp => ({ typeId: tp.typeId }))
				popScope()
			}
			popScope()
			continue
		}

		if (ts.isClassDeclaration(stmt) && stmt.name) {
			const parsedType = registerParsedType(stmt.name.text, "class", stmt.name, {})
			bindTypeName(rootScopeId, stmt.name.text, parsedType.id)
			const declScopeId = pushScope("declaration", stmt, stmt.name.text)
			if (stmt.typeParameters?.length) {
				pushScope("typeParameters", stmt, `${stmt.name.text}.typeParameters`)
				const typeParameters = collectTypeParams(stmt, declScopeId)
				parsedType.arguments = typeParameters.map(tp => ({ typeId: tp.typeId }))
				popScope()
			}
			popScope()
		}
	}
	return { types, scopes }
}

export type ParseTypesOptions = {
	idPrefix?: string
}

export type ParseTypesResult = {
	types: Map<string, ParsedType>
	scopes: Map<string, Scope>
}

export type ParsedType = {
	id: string
	name: string
	path: string
	refPath: string
	refName: string
	scopeId: string
	kind: ParsedTypeKind
	position: Position
	arguments?: { typeId: string }[]
}

export type ParsedTypeKind = "typeAlias" | "interface" | "class" | "imported" | "typeParameter" | "infer"

export type Position = {
	start: number
	end: number
}

export type Scope = {
	id: string
	path: string
	kind: "file" | "declaration" | "typeParameters" | "conditional" | "infer" | "branchTrue" | "branchFalse"
	parentScopeId: string | null
	name?: string
	position: Position
	/** Per-scope type call roots; conditional scopes use `[checkType, extendsType]`. */
	calls: TypeCall[]
}

/**
 * One node in the per-scope type call forest.
 * - `kind: "call"`: resolved reference (`ParsedType.id`) or bracket pseudo (`[array]`, …).
 *   `infer` nodes use the corresponding `ParsedType` id as `typeId` (constraint in `arguments`).
 *   `[conditional]` uses three `kind: "scope"` arguments: conditional scope, branchTrue, branchFalse.
 * - `kind: "scope"`: pointer to an existing `Scope.id` (no nested `arguments`).
 */
export type TypeCall =
	| {
			kind: "call"
			typeId: string
			position: Position
			arguments: TypeCall[]
	  }
	| {
			kind: "scope"
			scopeId: string
	  }

function toPos(start: number, end: number): Position {
	return { start, end }
}

function normalizeImportRef(filePath: string, importText: string): string {
	const resolved = path.normalize(path.join(path.dirname(filePath), importText))
	return resolved
}

function intrinsicTypeName(node: ts.TypeNode): string | undefined {
	if (node.kind === ts.SyntaxKind.StringKeyword) return "string"
	if (node.kind === ts.SyntaxKind.NumberKeyword) return "number"
	if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean"
	if (node.kind === ts.SyntaxKind.BigIntKeyword) return "bigint"
	if (node.kind === ts.SyntaxKind.SymbolKeyword) return "symbol"
	if (node.kind === ts.SyntaxKind.VoidKeyword) return "void"
	if (node.kind === ts.SyntaxKind.UndefinedKeyword) return "undefined"
	if (node.kind === ts.SyntaxKind.NullKeyword) return "null"
	if (node.kind === ts.SyntaxKind.NeverKeyword) return "never"
	if (node.kind === ts.SyntaxKind.UnknownKeyword) return "unknown"
	if (node.kind === ts.SyntaxKind.AnyKeyword) return "any"
	if (node.kind === ts.SyntaxKind.ObjectKeyword) return "object"
	return undefined
}

/** Bracket pseudo-type ids for syntax-only type shapes (not resolved declarations). */
const P = {
	array: "[array]",
	rest: "[rest]",
	tuple: "[tuple]",
	pair: "[pair]",
	object: "[object]",
	template: "[template]",
	extends: "[extends]",
	infer: "[infer]",
	conditional: "[conditional]",
	union: "[union]",
	intersection: "[intersection]",
	optional: "[optional]",
	readonly: "[readonly]",
	keyof: "[keyof]",
	unique: "[unique]",
	indexedAccess: "[indexedAccess]",
	mapped: "[mapped]",
	this: "[this]",
	query: "[query]",
	import: "[import]",
	function: "[function]",
	constructor: "[constructor]",
	unknown: "[unknown]",
} as const
