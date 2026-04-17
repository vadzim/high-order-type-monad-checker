import path from "node:path"
import ts from "typescript"

// parseTypes responsibility boundary:
// - build a syntax-derived graph (types/scopes/references/calls)
// - do not perform any analysis, stay policy-neutral (no reader/consumer/monad rule decisions)

export function parseTypes(filePath: string, content: string, options: ParseTypesOptions = {}): ParseTypesResult {
	const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
	const types = new Map<string, ParsedType>()
	const scopes = new Map<string, Scope>()
	const usages: TypeUsage[] = []
	const bindingsByScopeId = new Map<string, Map<string, string>>()
	const pendingInferBindingsByConditionalScopeId = new Map<string, Array<{ name: string; typeId: string }>>()
	let nextType = 0
	let nextScope = 0
	const pendingExtendsByTypeId = new Map<string, string>()

	const scopeStack: string[] = []

	const mkTypeId = () => `${options.idPrefix ?? "id"}-t-${nextType++}`
	const mkScopeId = () => `${options.idPrefix ?? "id"}-s-${nextScope++}`

	const rootScopeId = mkScopeId()
	scopes.set(rootScopeId, {
		id: rootScopeId,
		path: filePath,
		kind: "file",
		parentScopeId: null,
		position: toPos(sourceFile, 0, content.length),
		references: [],
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
			position: toPos(sourceFile, node.getStart(sourceFile), node.getEnd()),
			references: [],
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
			position: toPos(sourceFile, start, node.getEnd()),
			...cfg,
		}
		if (!base.refPath) base.refPath = filePath
		types.set(base.id, base)
		return base
	}

	const addScopeReference = (scopeId: string, typeId: string, node: ts.Node) => {
		const scope = scopes.get(scopeId)
		if (!scope) return
		const pos = toPos(sourceFile, node.getStart(sourceFile), node.getEnd())
		scope.references.push({ typeId, position: pos })
	}

	const addReferenceFromTypeNode = (node: ts.TypeNode) => {
		if (ts.isTypeReferenceNode(node)) {
			const typeName = node.typeName.getText(sourceFile)
			const typeId = resolveTypeIdByName(typeName, currentScope())
			if (!typeId) return
			addScopeReference(currentScope(), typeId, node.typeName)
			return
		}
		const intrinsic = intrinsicTypeName(node)
		if (!intrinsic) return
		addScopeReference(currentScope(), `global:${intrinsic}`, node)
	}

	const addCallFromTypeNode = (node: ts.TypeNode) => {
		if (!ts.isTypeReferenceNode(node)) return
		const scope = scopes.get(currentScope())
		if (!scope) return
		const callTypeName = node.typeName.getText(sourceFile)
		const callTypeId = resolveTypeIdByName(callTypeName, currentScope())
		if (!callTypeId) return
		const args = node.typeArguments ?? []
		scope.calls.push({
			typeId: callTypeId,
			arguments: args.map(arg => {
				if (ts.isTypeReferenceNode(arg)) {
					const argTypeName = arg.typeName.getText(sourceFile)
					const argTypeId = resolveTypeIdByName(argTypeName, currentScope())
					return {
						typeId: argTypeId ?? "",
						position: toPos(sourceFile, arg.getStart(sourceFile), arg.getEnd()),
					}
				}
				const intrinsic = intrinsicTypeName(arg)
				if (intrinsic) {
					return {
						typeId: `global:${intrinsic}`,
						position: toPos(sourceFile, arg.getStart(sourceFile), arg.getEnd()),
					}
				}
				return {
					typeId: "",
					position: toPos(sourceFile, arg.getStart(sourceFile), arg.getEnd()),
				}
			}),
		})
	}
	const collectTypeRefs = (node: ts.TypeNode) => {
		const walk = (part: ts.TypeNode) => {
			if (ts.isTypeReferenceNode(part)) {
				addCallFromTypeNode(part)
				addReferenceFromTypeNode(part)
			}
			ts.forEachChild(part, child => {
				if (ts.isTypeNode(child)) walk(child)
			})
		}
		walk(node)
	}

	const collectExtendsName = (constraint?: ts.TypeNode): string | undefined => {
		if (!constraint) return undefined
		const intrinsic = intrinsicTypeName(constraint)
		if (intrinsic) return intrinsic
		if (!ts.isTypeReferenceNode(constraint)) return undefined
		if (!ts.isIdentifier(constraint.typeName)) return undefined
		if ((constraint.typeArguments?.length ?? 0) > 0) return undefined
		return constraint.typeName.text
	}

	const collectTypeParams = (
		node: { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> },
		bindingScopeId: string,
	): { name: string; extendsTypeName?: string; typeId: string }[] => {
		const out: { name: string; extendsTypeName?: string; typeId: string }[] = []
		const tps = node.typeParameters ?? []
		for (const tp of tps) {
			if (tp.constraint && ts.isTypeReferenceNode(tp.constraint) && tp.constraint.typeName.getText(sourceFile)) {
				const constraintTypeName = tp.constraint.typeName.getText(sourceFile)
				const extendsName = collectExtendsName(tp.constraint)
				const parsedType = registerParsedType(tp.name.text, "typeParameter", tp.name, {
					extends: extendsName ? undefined : {},
					constraintPosition: tp.constraint
						? toPos(sourceFile, tp.constraint.getStart(sourceFile), tp.constraint.getEnd())
						: undefined,
				})
				bindTypeName(bindingScopeId, tp.name.text, parsedType.id)
				if (extendsName) pendingExtendsByTypeId.set(parsedType.id, extendsName)
				out.push({ name: tp.name.text, extendsTypeName: constraintTypeName, typeId: parsedType.id })
				collectTypeRefs(tp.constraint)
			} else {
				const extendsName = collectExtendsName(tp.constraint)
				const parsedType = registerParsedType(tp.name.text, "typeParameter", tp.name, {
					extends: tp.constraint && !extendsName ? {} : undefined,
					constraintPosition: tp.constraint
						? toPos(sourceFile, tp.constraint.getStart(sourceFile), tp.constraint.getEnd())
						: undefined,
				})
				bindTypeName(bindingScopeId, tp.name.text, parsedType.id)
				if (extendsName) pendingExtendsByTypeId.set(parsedType.id, extendsName)
				out.push({ name: tp.name.text, typeId: parsedType.id })
				if (tp.constraint) collectTypeRefs(tp.constraint)
			}
		}
		return out
	}

	const collectTypeStructure = (node: ts.TypeNode) => {
		const walk = (part: ts.TypeNode) => {
			addReferenceFromTypeNode(part)
			if (ts.isConditionalTypeNode(part)) {
				const conditionalScopeId = pushScope("conditional", part)
				const conditionalScope = scopeById(conditionalScopeId)
				if (conditionalScope) {
					conditionalScope.conditionalCheckPosition = toPos(
						sourceFile,
						part.checkType.getStart(sourceFile),
						part.checkType.getEnd(),
					)
					conditionalScope.conditionalExtendsPosition = toPos(
						sourceFile,
						part.extendsType.getStart(sourceFile),
						part.extendsType.getEnd(),
					)
				}
				walk(part.checkType)
				walk(part.extendsType)
				const branchTrueScopeId = pushScope("branchTrue", part.trueType)
				for (const inferBinding of pendingInferBindingsByConditionalScopeId.get(conditionalScopeId) ?? []) {
					bindTypeName(branchTrueScopeId, inferBinding.name, inferBinding.typeId)
				}
				walk(part.trueType)
				popScope()
				pushScope("branchFalse", part.falseType)
				walk(part.falseType)
				popScope()
				popScope()
				return
			}
			if (ts.isInferTypeNode(part)) {
				const inferName = part.typeParameter.name.text
				pushScope("infer", part, inferName)
				const extendsName = collectExtendsName(part.typeParameter.constraint)
				const inferType = registerParsedType(inferName, "infer", part.typeParameter.name, {
					extends: part.typeParameter.constraint && !extendsName ? {} : undefined,
					constraintPosition: part.typeParameter.constraint
						? toPos(
								sourceFile,
								part.typeParameter.constraint.getStart(sourceFile),
								part.typeParameter.constraint.getEnd(),
							)
						: undefined,
					inferPlacement: classifyInferPlacement(part),
				})
				const conditionalScope = findNearestScopeByKind(currentScope(), "conditional")
				if (conditionalScope) {
					const inferBindings = pendingInferBindingsByConditionalScopeId.get(conditionalScope.id) ?? []
					inferBindings.push({ name: inferName, typeId: inferType.id })
					pendingInferBindingsByConditionalScopeId.set(conditionalScope.id, inferBindings)
				}
				if (extendsName) pendingExtendsByTypeId.set(inferType.id, extendsName)
				if (part.typeParameter.constraint) collectTypeRefs(part.typeParameter.constraint)
				popScope()
				return
			}
			if (ts.isTypeReferenceNode(part)) {
				addCallFromTypeNode(part)
			}
			const visitNestedTypeNodes = (current: ts.Node) => {
				ts.forEachChild(current, child => {
					if (ts.isTypeNode(child)) {
						walk(child)
						return
					}
					visitNestedTypeNodes(child)
				})
			}
			visitNestedTypeNodes(part)
		}
		walk(node)
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
			collectTypeUsages(stmt.type, declScopeId)
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
	for (const [typeId, extendsName] of pendingExtendsByTypeId) {
		const parsedType = types.get(typeId)
		if (!parsedType) continue
		const resolvedTypeId = resolveTypeIdByName(extendsName, parsedType.scopeId)
		if (!resolvedTypeId) continue
		parsedType.extends = {
			...(parsedType.extends ?? {}),
			typeId: resolvedTypeId,
		}
	}

	return { types, scopes, usages }

	function collectTypeUsages(node: ts.TypeNode, declarationScopeId: string) {
		type UsageCtx = { kind: TypeUsageKind; wrapped: boolean }
		const walk = (part: ts.TypeNode, ctx: UsageCtx) => {
			if (ts.isTypeReferenceNode(part)) {
				const typeName = part.typeName.getText(sourceFile)
				const typeId = resolveTypeIdByName(typeName, currentScope())
				usages.push({
					typeId,
					position: toPos(sourceFile, part.typeName.getStart(sourceFile), part.typeName.getEnd()),
					declarationScopeId,
					kind: ctx.kind,
					wrapped: ctx.wrapped,
				})
				const args = part.typeArguments ?? []
				for (const [idx, arg] of args.entries()) {
					walk(arg, {
						kind: idx === args.length - 1 ? "genericArgLast" : "genericArgNonLast",
						wrapped: ctx.wrapped,
					})
				}
				return
			}
			if (ts.isConditionalTypeNode(part)) {
				walk(part.checkType, { kind: "conditionalCheck", wrapped: ctx.wrapped })
				walk(part.extendsType, { kind: "conditionalExtends", wrapped: ctx.wrapped })
				walk(part.trueType, { kind: "other", wrapped: ctx.wrapped })
				walk(part.falseType, { kind: "other", wrapped: ctx.wrapped })
				return
			}
			if (ts.isTupleTypeNode(part)) {
				for (const [idx, el] of part.elements.entries()) {
					walk(el, {
						kind: part.elements.length === 2 && idx === 1 ? "tupleSecondOfTwo" : "tupleOther",
						wrapped: ctx.wrapped || ctx.kind === "genericArgLast" || ctx.kind === "genericArgNonLast",
					})
				}
				return
			}
			const visitNestedTypeNodes = (current: ts.Node) => {
				ts.forEachChild(current, child => {
					if (ts.isTypeNode(child)) {
						walk(child, { kind: "other", wrapped: true })
						return
					}
					visitNestedTypeNodes(child)
				})
			}
			visitNestedTypeNodes(part)
		}
		walk(node, { kind: "other", wrapped: false })
	}
}

export type ParseTypesOptions = {
	idPrefix?: string
}

export type ParseTypesResult = {
	types: Map<string, ParsedType>
	scopes: Map<string, Scope>
	usages: TypeUsage[]
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
	extends?: { typeId?: string }
	constraintPosition?: Position
	inferPlacement?: InferPlacement
	arguments?: Array<{ typeId: string }>
}

export type ParsedTypeKind = "typeAlias" | "interface" | "class" | "imported" | "typeParameter" | "infer"
export type InferPlacement = "asMonadState" | "other"

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
	conditionalCheckPosition?: Position
	conditionalExtendsPosition?: Position
	references: TypeReference[]
	calls: TypeCall[]
}

export type TypeReference = {
	typeId: string
	position: Position
}

export type TypeCall = {
	typeId: string
	arguments: TypeReference[]
}

export type TypeUsageKind =
	| "conditionalCheck"
	| "conditionalExtends"
	| "genericArgLast"
	| "genericArgNonLast"
	| "tupleSecondOfTwo"
	| "tupleOther"
	| "other"

export type TypeUsage = {
	typeId: string
	position: Position
	declarationScopeId: string
	kind: TypeUsageKind
	wrapped: boolean
}

function toPos(sourceFile: ts.SourceFile, start: number, end: number): Position {
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

function classifyInferPlacement(node: ts.InferTypeNode): InferPlacement {
	const tuple = ts.isTupleTypeNode(node.parent) ? node.parent : undefined
	if (!tuple) return "other"
	if (tuple.elements.length !== 2) return "other"
	if (tuple.elements[1] !== node) return "other"
	if (!tuple.parent || !ts.isConditionalTypeNode(tuple.parent)) return "other"
	if (tuple.parent.extendsType !== tuple) return "other"
	return "asMonadState"
}
