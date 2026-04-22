import ts from "typescript"
import { dirname, join } from "node:path"

export type CGPosition = { start: number; end: number }

export type CGScopeKind =
	| "global"
	| "file"
	| "declaration"
	| "typeParameters"
	| "conditional"
	| "branchTrue"
	| "branchFalse"
	| "infer"

export type CGParsedTypeKind = "typeAlias" | "interface" | "class" | "typeParameter" | "infer"
type CGDeclaredTypeKind = Extract<CGParsedTypeKind, "typeAlias" | "interface" | "class">
type CGDeclaredTypeNode = ts.TypeAliasDeclaration | ts.InterfaceDeclaration | ts.ClassDeclaration
type CGDeclaredTypeParseContext = {
	ownerType: CGType
	activeScope: CGScope
	typeParameterScope: CGScope | null
}

export type CGTypeArgument = {
	variable: CGTypeRef
	extends: CGCall | null
	default: CGCall | null
}

export type CGType = {
	name: string
	position: CGPosition
	arguments: CGTypeArgument[]
	declaration: CGCall | null
	body: CGCall | null
	scope: CGScope
	kind: CGParsedTypeKind
	called: Set<CGCall>
	returnedBy: Set<CGTypeRef>
	returns: Set<CGTypeRef>
	refs: Set<CGTypeRef> // all the refs in which ref is equal to this type
}

export type CGTypeRef = {
	ref: CGType
	name: string
	position: CGPosition
	scope: CGScope
}

export type CGScope = {
	kind: CGScopeKind
	path: string
	position: CGPosition
	types: Set<CGTypeRef>
	calls: Set<CGCall>
	parent: CGScope | null
}

export type CGCall = {
	parent: CGCall | null
	type: CGTypeRef
	scope: CGScope
	arguments: CGCall[]
	position: CGPosition
}

export type ContentGraph = {
	refs: Set<CGTypeRef>
	types: Set<CGType>
	scopes: Set<CGScope>
	calls: Set<CGCall>
}

export function buildContentGraph(filePath: string, content: string): ContentGraph {
	return new ContentGraphBuilder(filePath, content).getContentGraph()
}

class ContentGraphBuilder {
	private readonly filePath: string
	private readonly sourceFile: ts.SourceFile
	private readonly graph: ContentGraph
	private readonly globalScope: CGScope
	private readonly fileScope: CGScope
	private readonly externalTypes: Map<string, CGType>

	constructor(filePath: string, content: string) {
		this.filePath = filePath
		this.sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
		this.graph = { types: new Set(), scopes: new Set(), refs: new Set(), calls: new Set() }
		this.globalScope = this.createScope("global", "<global>", this.sourceFile, null, true)
		this.fileScope = this.createScope("file", this.filePath, this.sourceFile, this.globalScope)
		this.externalTypes = new Map()
	}

	// Entry point
	getContentGraph(): ContentGraph {
		for (const statement of this.sourceFile.statements) {
			if (ts.isImportDeclaration(statement)) this.addImportTypes(statement)
		}
		this.predeclareTopLevelTypes()
		for (const statement of this.sourceFile.statements) {
			if (ts.isTypeAliasDeclaration(statement)) this.parseTypeAlias(statement)
			if (ts.isInterfaceDeclaration(statement)) this.parseInterface(statement)
			if (ts.isClassDeclaration(statement) && statement.name) this.parseClass(statement)
		}
		for (const type of this.graph.types) {
			const declRef = [...type.scope.types].find(r => r.ref === type && r.name === type.name)
			if (!declRef) continue
			for (const returnedRef of type.returns) returnedRef.ref.returnedBy.add(declRef)
		}
		this.rebuildCallIndexes()
		return this.graph
	}

	// Graph construction primitives
	private predeclareTopLevelTypes(): void {
		for (const statement of this.sourceFile.statements) {
			if (ts.isTypeAliasDeclaration(statement))
				this.ensureLocalDeclaredType(statement.name.text, statement.name, this.fileScope, "typeAlias")
			if (ts.isInterfaceDeclaration(statement))
				this.ensureLocalDeclaredType(statement.name.text, statement.name, this.fileScope, "interface")
			if (ts.isClassDeclaration(statement) && statement.name)
				this.ensureLocalDeclaredType(statement.name.text, statement.name, this.fileScope, "class")
		}
	}

	private createPosition(node: ts.Node): CGPosition {
		return { start: node.getStart(this.sourceFile), end: node.getEnd() }
	}

	private createPositionByToken(node: ts.Node, token: string): CGPosition {
		if (!token) return this.createPosition(node)
		const start = node.getStart(this.sourceFile)
		const end = node.getEnd()
		const nodeText = this.sourceFile.text.slice(start, end)
		const tokenOffset = nodeText.indexOf(token)
		if (tokenOffset < 0) return this.createPosition(node)
		return { start: start + tokenOffset, end: start + tokenOffset + token.length }
	}

	private createScope(
		kind: CGScopeKind,
		path: string,
		node: ts.Node,
		parent: CGScope | null,
		zeroPosition = false,
	): CGScope {
		const scope: CGScope = {
			kind,
			path,
			position: zeroPosition ? { start: 0, end: 0 } : { start: node.getStart(), end: node.getEnd() },
			types: new Set(),
			calls: new Set(),
			parent,
		}
		this.graph.scopes.add(scope)
		return scope
	}

	private createType(name: string, node: ts.Node, scope: CGScope, kind: CGParsedTypeKind): CGType {
		const isSyntheticScope = scope.kind === "global" || (scope.kind === "file" && scope.parent === null)
		const type: CGType = {
			name,
			position: isSyntheticScope ? { start: 0, end: 0 } : this.createPosition(node),
			arguments: [],
			declaration: null,
			body: null,
			scope,
			kind,
			called: new Set(),
			returnedBy: new Set(),
			returns: new Set(),
			refs: new Set(),
		}
		this.graph.types.add(type)
		const selfRef = this.createTypeRef(type, name, node, scope, true)
		scope.types.add(selfRef)
		if (!(scope.kind === "file" && scope.parent === null)) this.graph.refs.add(selfRef)
		return type
	}

	private createTypeRef(
		ref: CGType,
		name: string,
		node: ts.Node,
		scope: CGScope,
		isDeclarationRef = false,
	): CGTypeRef {
		const isSyntheticDeclarationScope = scope.kind === "global" || (scope.kind === "file" && scope.parent === null)
		const isSyntheticTarget =
			ref.scope.kind === "global" || (ref.scope.kind === "file" && ref.scope.parent === null)
		const position = isDeclarationRef
			? isSyntheticDeclarationScope
				? { start: 0, end: 0 }
				: this.createPosition(node)
			: isSyntheticTarget
				? { start: 0, end: 0 }
				: this.createPosition(node)
		const typeRef = { ref, name, position, scope }
		// `refs` mirrors declaration refs stored in graph.refs.
		const shouldTrackDeclarationRef = isDeclarationRef && !(scope.kind === "file" && scope.parent === null)
		if (shouldTrackDeclarationRef) ref.refs.add(typeRef)
		return typeRef
	}

	private addImportTypes(statement: ts.ImportDeclaration): void {
		if (!statement.importClause || !ts.isStringLiteral(statement.moduleSpecifier)) return
		const importPath = join(dirname(this.filePath), statement.moduleSpecifier.text)
		const addImportedBinding = (importedName: string, localName: string, node: ts.Node): void => {
			const key = `${importPath}::${importedName}`
			let importedType = this.externalTypes.get(key)
			if (!importedType) {
				const importScope = this.createScope("file", importPath, node, null, true)
				importedType = this.createType(importedName, node, importScope, "typeAlias")
				this.externalTypes.set(key, importedType)
			}
			const localRef = this.createTypeRef(importedType, localName, node, this.fileScope, true)
			this.fileScope.types.add(localRef)
			this.graph.refs.add(localRef)
		}
		if (statement.importClause.name)
			addImportedBinding(
				statement.importClause.name.text,
				statement.importClause.name.text,
				statement.importClause.name,
			)
		if (statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
			for (const element of statement.importClause.namedBindings.elements) {
				const importedName = element.propertyName?.text ?? element.name.text
				addImportedBinding(importedName, element.name.text, element.name)
			}
		}
	}

	// Top-level declaration parsing
	private parseTypeAlias(decl: ts.TypeAliasDeclaration): void {
		this.parseDeclaredType(decl, "typeAlias", ({ activeScope, ownerType }) =>
			this.collectTypeRoots([decl.type], activeScope, this.fileScope, ownerType, true),
		)
	}

	private parseInterface(decl: ts.InterfaceDeclaration): void {
		this.parseDeclaredType(decl, "interface", ({ activeScope, ownerType }) => {
			const heritageRoots = this.collectHeritageRoots(
				(decl.heritageClauses ?? []).flatMap(heritage => heritage.types),
				activeScope,
				this.fileScope,
				ownerType,
				true,
			)
			const memberRoots = this.collectTypeRoots(
				decl.members.flatMap(member =>
					(ts.isPropertySignature(member) || ts.isMethodSignature(member)) && member.type
						? [member.type]
						: [],
				),
				activeScope,
				this.fileScope,
				ownerType,
				false,
			)
			return [...heritageRoots, ...memberRoots]
		})
	}

	private parseClass(decl: ts.ClassDeclaration): void {
		if (!decl.name) return
		this.parseDeclaredType(decl, "class", ({ activeScope, ownerType }) => {
			const heritageRoots = this.collectHeritageRoots(
				(decl.heritageClauses ?? []).flatMap(heritage => heritage.types),
				activeScope,
				this.fileScope,
				ownerType,
				true,
			)
			const memberRoots = this.collectTypeRoots(
				decl.members.flatMap(member => {
					if (ts.isPropertyDeclaration(member) && member.type) return [member.type]
					if (ts.isMethodDeclaration(member) && member.type) return [member.type]
					return []
				}),
				activeScope,
				this.fileScope,
				ownerType,
				false,
			)
			return [...heritageRoots, ...memberRoots]
		})
	}

	private parseDeclaredType(
		decl: CGDeclaredTypeNode,
		kind: CGDeclaredTypeKind,
		collectDeclarationBodyRoots: (context: CGDeclaredTypeParseContext) => CGCall[],
	): void {
		const nameNode = decl.name
		if (!nameNode) return
		const type = this.ensureLocalDeclaredType(nameNode.text, nameNode, this.fileScope, kind)
		const typeParameterScope = this.createTypeParameterScope(decl.typeParameters, type.scope)
		type.arguments = this.collectTypeParameters(decl.typeParameters, typeParameterScope)
		const activeScope = typeParameterScope ?? type.scope
		const bodyRoots = collectDeclarationBodyRoots({ ownerType: type, activeScope, typeParameterScope })
		type.body = bodyRoots.at(-1) ?? null
		this.addDeclarationRootCall(decl, type.scope, type, bodyRoots)
	}

	private ensureLocalDeclaredType(name: string, node: ts.Node, scope: CGScope, kind: CGParsedTypeKind): CGType {
		const existing = [...scope.types].find(r => r.name === name && r.scope === scope)?.ref
		if (existing) return existing
		return this.createType(name, node, scope, kind)
	}

	private createTypeParameterScope(
		typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
		parent: CGScope,
	): CGScope | null {
		if (!typeParameters?.length) return null
		return this.createScope("typeParameters", parent.path, typeParameters[0], parent)
	}

	private collectTypeParameters(
		typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
		scope: CGScope | null,
	): CGTypeArgument[] {
		if (!typeParameters || !scope) return []
		const refs: CGTypeArgument[] = []
		for (const typeParam of typeParameters) {
			const type = this.createType(typeParam.name.text, typeParam.name, scope, "typeParameter")
			const ref = [...scope.types].find(r => r.ref === type && r.name === type.name)
			if (!ref) continue
			const globalScope = this.getGlobalScope(scope)
			const explicitDefaultCall = this.collectTypeParameterDefaultCall(typeParam, scope, globalScope, type)
			const declarationBodyCall = explicitDefaultCall ?? this.createUnknownCall(typeParam, scope, globalScope)
			const declarationCall = this.addTypeDeclarationCall(
				type,
				ref,
				declarationBodyCall,
				scope,
				typeParam,
				[],
				"infer",
			)
			const extendsCall = this.createExtendsConstraintCall(
				declarationCall,
				typeParam.constraint,
				scope,
				scope.parent ?? scope,
				globalScope,
				type,
				typeParam,
			)
			refs.push({ variable: ref, extends: extendsCall.arguments[1] ?? null, default: declarationBodyCall })
		}
		return refs
	}

	// Type parameter metadata
	private collectTypeParameterDefaultCall(
		typeParam: ts.TypeParameterDeclaration,
		scope: CGScope,
		globalScope: CGScope,
		ownerType: CGType,
	): CGCall | null {
		if (!typeParam.default) return null
		const before = this.graph.calls.size
		this.walkTypeNode(typeParam.default, scope, scope.parent ?? scope, globalScope, ownerType, false)
		return this.callsAddedSince(before, scope).at(-1) ?? null
	}

	private createExtendsConstraintCall(
		leftCall: CGCall | null,
		constraint: ts.TypeNode | undefined,
		scope: CGScope,
		declarationScope: CGScope,
		globalScope: CGScope,
		ownerType: CGType,
		anchorNode: ts.Node,
	): CGCall {
		const rightCall =
			constraint === undefined
				? this.createUnknownCall(anchorNode, scope, globalScope)
				: this.walkTypeNode(constraint, scope, declarationScope, globalScope, ownerType, false)
		const extendsRef = this.getOrCreatePseudoTypeRef("<extends>", anchorNode, scope)
		return this.addCall(
			extendsRef,
			scope,
			[leftCall, rightCall].filter((c): c is CGCall => c !== null),
			anchorNode,
			"extends",
		)
	}

	private resolveTypeReference(name: string, scope: CGScope): CGTypeRef | null {
		let current: CGScope | null = scope
		while (current) {
			const found = [...current.types].find(r => r.name === name)
			if (found) return found
			current = current.parent
		}
		return null
	}

	private getRootScope(scope: CGScope): CGScope {
		let current: CGScope = scope
		while (current.parent) current = current.parent
		return current
	}

	private getGlobalScope(scope: CGScope): CGScope {
		const root = this.getRootScope(scope)
		return root.kind === "global" ? root : scope
	}

	private getOrCreatePseudoTypeRef(name: string, node: ts.Node, scope: CGScope): CGTypeRef {
		const rootScope = this.getRootScope(scope)
		let pseudoRef = this.resolveTypeReference(name, rootScope)
		if (!pseudoRef) {
			this.createType(name, node, rootScope, "typeAlias")
			pseudoRef = this.resolveTypeReference(name, rootScope)
		}
		if (!pseudoRef) throw new Error(`Failed to create pseudo type ref for ${name}`)
		if (name === "<extends>" && pseudoRef.ref.arguments.length === 0) {
			const left = this.createType("left", node, rootScope, "typeParameter")
			const right = this.createType("right", node, rootScope, "typeParameter")
			const leftRef = [...rootScope.types].find(r => r.ref === left && r.name === "left")
			const rightRef = [...rootScope.types].find(r => r.ref === right && r.name === "right")
			if (!leftRef || !rightRef) throw new Error("Failed to create <extends> pseudo arguments")
			pseudoRef.ref.arguments = [
				{ variable: leftRef, extends: null, default: null },
				{ variable: rightRef, extends: null, default: null },
			]
		}
		return pseudoRef
	}

	private getOrCreateGlobalTypeRef(name: string, node: ts.Node, globalScope: CGScope): CGTypeRef {
		const existing = this.resolveTypeReference(name, globalScope)
		if (existing) return existing
		this.createType(name, node, globalScope, "typeAlias")
		const globalRef = this.resolveTypeReference(name, globalScope)
		if (!globalRef) throw new Error(`Failed to create global type ref for ${name}`)
		return globalRef
	}

	private createUnknownCall(node: ts.Node, scope: CGScope, globalScope: CGScope): CGCall {
		return this.addCall(this.getOrCreateGlobalTypeRef("unknown", node, globalScope), scope, [], node, "unknown")
	}

	private addCall(
		typeRef: CGTypeRef,
		scope: CGScope,
		argumentsCalls: CGCall[],
		positionNode: ts.Node,
		positionToken?: string,
	): CGCall {
		const call: CGCall = {
			parent: null,
			type: typeRef,
			scope,
			arguments: argumentsCalls,
			position: positionToken
				? this.createPositionByToken(positionNode, positionToken)
				: this.createPosition(positionNode),
		}
		for (const arg of argumentsCalls) arg.parent = call
		this.graph.calls.add(call)
		return call
	}

	private intrinsicPseudoName(node: ts.TypeNode): string | null {
		switch (node.kind) {
			case ts.SyntaxKind.StringKeyword:
				return "string"
			case ts.SyntaxKind.NumberKeyword:
				return "number"
			case ts.SyntaxKind.BooleanKeyword:
				return "boolean"
			case ts.SyntaxKind.SymbolKeyword:
				return "symbol"
			case ts.SyntaxKind.BigIntKeyword:
				return "bigint"
			case ts.SyntaxKind.ObjectKeyword:
				return "object"
			case ts.SyntaxKind.UndefinedKeyword:
				return "undefined"
			case ts.SyntaxKind.UnknownKeyword:
				return "unknown"
			case ts.SyntaxKind.AnyKeyword:
				return "any"
			case ts.SyntaxKind.NeverKeyword:
				return "never"
			case ts.SyntaxKind.VoidKeyword:
				return "void"
			default:
				return null
		}
	}

	private literalPseudoName(node: ts.TypeNode): string | null {
		if (ts.isLiteralTypeNode(node)) return `<${node.literal.getText(this.sourceFile)}>`
		return null
	}

	private callsAddedSince(sizeBefore: number, scope: CGScope): CGCall[] {
		return [...this.graph.calls].slice(sizeBefore).filter(call => call.scope === scope)
	}

	private addSyntaxPseudoCall(
		name: string,
		node: ts.TypeNode,
		scope: CGScope,
		ownerType: CGType,
		isReturn: boolean,
		argumentsCalls: CGCall[],
		positionToken?: string,
	): CGCall {
		const ref = this.getOrCreatePseudoTypeRef(name, node, scope)
		if (isReturn) ownerType.returns.add(ref)
		return this.addCall(ref, scope, argumentsCalls, node, positionToken)
	}

	private addTypeDeclarationCall(
		ownerType: CGType,
		declarationRef: CGTypeRef,
		bodyCall: CGCall,
		scope: CGScope,
		node: ts.Node,
		extraArguments: CGCall[] = [],
		positionToken?: string,
	): CGCall {
		const declarationVariableCall = this.addCall(declarationRef, scope, [], node)
		ownerType.declaration = declarationVariableCall
		ownerType.body = bodyCall
		const declarationTypeRef = this.getOrCreatePseudoTypeRef("<typeDeclaration>", node, scope)
		return this.addCall(
			declarationTypeRef,
			scope,
			[declarationVariableCall, bodyCall, ...extraArguments],
			node,
			positionToken,
		)
	}

	private addDeclarationRootCall(
		declNode: ts.Node,
		declScope: CGScope,
		ownerType: CGType,
		bodyRoots: CGCall[],
	): CGCall | null {
		if (bodyRoots.length === 0) return null
		if (ownerType.kind === "typeAlias") {
			const declarationRef = this.findDeclarationRef(ownerType)
			if (!declarationRef) throw new Error(`Failed to find declaration ref for ${ownerType.name}`)
			return this.addTypeDeclarationCall(
				ownerType,
				declarationRef,
				bodyRoots.at(-1)!,
				declScope,
				declNode,
				ownerType.arguments
					.map(argument => argument.variable.ref.declaration?.parent?.parent)
					.filter((call): call is CGCall => call?.type.name === "<extends>"),
			)
		}
		return this.addSyntaxPseudoCall(
			"<declaration>",
			declNode as ts.TypeNode,
			declScope,
			ownerType,
			false,
			bodyRoots,
		)
	}

	private findDeclarationRef(type: CGType): CGTypeRef | null {
		return [...type.scope.types].find(ref => ref.ref === type && ref.name === type.name) ?? null
	}

	private collectTypeRoots(
		nodes: readonly ts.TypeNode[],
		scope: CGScope,
		declarationScope: CGScope,
		ownerType: CGType,
		isReturn: boolean,
	): CGCall[] {
		const roots: CGCall[] = []
		for (const node of nodes) {
			const root = this.walkTypeNode(node, scope, declarationScope, this.globalScope, ownerType, isReturn)
			if (root) roots.push(root)
		}
		return roots
	}

	private collectHeritageRoots(
		nodes: readonly ts.ExpressionWithTypeArguments[],
		scope: CGScope,
		declarationScope: CGScope,
		ownerType: CGType,
		isReturn: boolean,
	): CGCall[] {
		const roots: CGCall[] = []
		for (const node of nodes) {
			const root = this.walkHeritageTypeNode(node, scope, declarationScope, this.globalScope, ownerType, isReturn)
			if (root) roots.push(root)
		}
		return roots
	}

	private resolveNamedTypeReference(
		name: string,
		nameNode: ts.Node,
		scope: CGScope,
		globalScope: CGScope,
	): CGTypeRef {
		return this.resolveTypeReference(name, scope) ?? this.getOrCreateGlobalTypeRef(name, nameNode, globalScope)
	}

	private walkTypeReferenceNode(
		node: ts.TypeReferenceNode,
		scope: CGScope,
		declarationScope: CGScope,
		globalScope: CGScope,
		ownerType: CGType,
		isReturn: boolean,
	): CGCall | null {
		const nameNode = node.typeName
		if (!ts.isIdentifier(nameNode)) return null
		const ref = this.resolveNamedTypeReference(nameNode.text, nameNode, scope, globalScope)
		if (isReturn) ownerType.returns.add(ref)
		const argCalls: CGCall[] = []
		for (const arg of node.typeArguments ?? []) {
			const root = this.walkTypeNode(arg, scope, declarationScope, globalScope, ownerType, false)
			if (root) argCalls.push(root)
		}
		return this.addCall(ref, scope, argCalls, nameNode)
	}

	private walkHeritageTypeNode(
		node: ts.ExpressionWithTypeArguments,
		scope: CGScope,
		declarationScope: CGScope,
		globalScope: CGScope,
		ownerType: CGType,
		isReturn: boolean,
	): CGCall | null {
		const expr = node.expression
		if (!ts.isIdentifier(expr)) return null
		const ref = this.resolveNamedTypeReference(expr.text, expr, scope, globalScope)
		if (isReturn) ownerType.returns.add(ref)
		const argCalls: CGCall[] = []
		for (const arg of node.typeArguments ?? []) {
			const root = this.walkTypeNode(arg, scope, declarationScope, globalScope, ownerType, false)
			if (root) argCalls.push(root)
		}
		return this.addCall(ref, scope, argCalls, expr)
	}

	private walkTypeLiteralNode(
		node: ts.TypeLiteralNode,
		scope: CGScope,
		declarationScope: CGScope,
		globalScope: CGScope,
		ownerType: CGType,
		isReturn: boolean,
	): CGCall {
		const pairRoots: CGCall[] = []
		for (const member of node.members) {
			if (
				(ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
				member.type &&
				member.name &&
				(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
			) {
				const memberName = ts.isIdentifier(member.name) ? member.name.text : member.name.text
				const keyRef = this.getOrCreatePseudoTypeRef(`<${JSON.stringify(memberName)}>`, member.name, scope)
				const keyCall = this.addCall(keyRef, scope, [], member.name)
				const valueRoot = this.walkTypeNode(member.type, scope, declarationScope, globalScope, ownerType, false)
				pairRoots.push(
					this.addSyntaxPseudoCall(
						"<pair>",
						member.type,
						scope,
						ownerType,
						false,
						[keyCall, ...(valueRoot ? [valueRoot] : [])],
						":",
					),
				)
				continue
			}
			if (ts.isCallSignatureDeclaration(member) && member.type) {
				const root = this.walkTypeNode(member.type, scope, declarationScope, globalScope, ownerType, false)
				if (root) pairRoots.push(root)
			}
		}
		return this.addSyntaxPseudoCall("<object>", node, scope, ownerType, isReturn, pairRoots, "{")
	}

	private walkConditionalTypeNode(
		node: ts.ConditionalTypeNode,
		scope: CGScope,
		globalScope: CGScope,
		ownerType: CGType,
		isReturn: boolean,
	): CGCall {
		const conditionalScope = this.createScope("conditional", scope.path, node, scope)
		const checkRoot = this.walkTypeNode(
			node.checkType,
			conditionalScope,
			conditionalScope,
			globalScope,
			ownerType,
			false,
		)
		const extendsTypeRoot = this.walkTypeNode(
			node.extendsType,
			conditionalScope,
			conditionalScope,
			globalScope,
			ownerType,
			false,
		)
		const extendsRef = this.getOrCreatePseudoTypeRef("<extends>", node, conditionalScope)
		const extendsCall = this.addCall(
			extendsRef,
			conditionalScope,
			[checkRoot, extendsTypeRoot].filter((call): call is CGCall => call !== null),
			node,
			"extends",
		)
		const trueScope = this.createScope("branchTrue", conditionalScope.path, node.trueType, conditionalScope)
		const trueRoot = this.collectScopedRoot(node.trueType, trueScope, globalScope, ownerType, true)
		const falseScope = this.createScope("branchFalse", scope.path, node.falseType, scope)
		const falseRoot = this.collectScopedRoot(node.falseType, falseScope, globalScope, ownerType, true)
		const conditionalRef = this.getOrCreatePseudoTypeRef("<conditional>", node, scope)
		if (isReturn) ownerType.returns.add(conditionalRef)
		return this.addCall(
			conditionalRef,
			scope,
			[extendsCall, trueRoot, falseRoot].filter((call): call is CGCall => call !== null),
			node,
			"extends",
		)
	}

	private collectScopedRoot(
		node: ts.TypeNode,
		scope: CGScope,
		globalScope: CGScope,
		ownerType: CGType,
		isReturn: boolean,
	): CGCall | null {
		const callsBefore = this.graph.calls.size
		this.walkTypeNode(node, scope, scope, globalScope, ownerType, isReturn)
		return this.callsAddedSince(callsBefore, scope).at(-1) ?? null
	}

	private walkInferTypeNode(
		node: ts.InferTypeNode,
		declarationScope: CGScope,
		globalScope: CGScope,
		ownerType: CGType,
	): CGCall {
		this.ensureLocalDeclaredType(node.typeParameter.name.text, node.typeParameter.name, declarationScope, "infer")
		const inferredRef = this.resolveTypeReference(node.typeParameter.name.text, declarationScope)
		const inferCall = inferredRef
			? this.addTypeDeclarationCall(
					inferredRef.ref,
					inferredRef,
					this.createUnknownCall(node, declarationScope, globalScope),
					declarationScope,
					node,
					[],
					"infer",
				)
			: null
		return this.createExtendsConstraintCall(
			inferCall,
			node.typeParameter.constraint,
			declarationScope,
			declarationScope,
			globalScope,
			ownerType,
			node,
		)
	}

	private walkTypeNode(
		node: ts.TypeNode,
		scope: CGScope,
		declarationScope: CGScope,
		globalScope: CGScope,
		ownerType: CGType,
		isReturn: boolean,
	): CGCall | null {
		if (ts.isTypeReferenceNode(node))
			return this.walkTypeReferenceNode(node, scope, declarationScope, globalScope, ownerType, isReturn)

		const intrinsicName = this.intrinsicPseudoName(node)
		if (intrinsicName) {
			const ref = this.getOrCreateGlobalTypeRef(intrinsicName, node, globalScope)
			if (isReturn) ownerType.returns.add(ref)
			return this.addCall(ref, scope, [], node, intrinsicName)
		}
		const literalName = this.literalPseudoName(node)
		if (literalName) {
			const ref = this.getOrCreateGlobalTypeRef(literalName, node, globalScope)
			if (isReturn) ownerType.returns.add(ref)
			const literalToken = ts.isLiteralTypeNode(node) ? node.literal.getText(this.sourceFile) : undefined
			return this.addCall(ref, scope, [], node, literalToken)
		}
		if (ts.isTupleTypeNode(node)) {
			const tupleRef = this.getOrCreatePseudoTypeRef("<tuple>", node, scope)
			if (isReturn) ownerType.returns.add(tupleRef)
			const roots: CGCall[] = []
			for (const element of node.elements)
				if (ts.isTypeNode(element)) {
					const root = this.walkTypeNode(element, scope, declarationScope, globalScope, ownerType, false)
					if (root) roots.push(root)
				}
			return this.addCall(tupleRef, scope, roots, node, "[")
		}
		if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
			const roots: CGCall[] = []
			for (const part of node.types) {
				const root = this.walkTypeNode(part, scope, declarationScope, globalScope, ownerType, isReturn)
				if (root) roots.push(root)
			}
			return this.addSyntaxPseudoCall(
				ts.isUnionTypeNode(node) ? "<union>" : "<intersection>",
				node,
				scope,
				ownerType,
				isReturn,
				roots,
				ts.isUnionTypeNode(node) ? "|" : "&",
			)
		}
		if (ts.isArrayTypeNode(node)) {
			const root = this.walkTypeNode(node.elementType, scope, declarationScope, globalScope, ownerType, isReturn)
			return this.addSyntaxPseudoCall("<array>", node, scope, ownerType, isReturn, root ? [root] : [], "[")
		}
		if (ts.isParenthesizedTypeNode(node)) {
			const root = this.walkTypeNode(node.type, scope, declarationScope, globalScope, ownerType, isReturn)
			return this.addSyntaxPseudoCall(
				"<parenthesized>",
				node,
				scope,
				ownerType,
				isReturn,
				root ? [root] : [],
				"(",
			)
		}
		if (ts.isTypeOperatorNode(node)) {
			const roots: CGCall[] = []
			ts.forEachChild(node, child => {
				if (ts.isTypeNode(child)) {
					const root = this.walkTypeNode(child, scope, declarationScope, globalScope, ownerType, false)
					if (root) roots.push(root)
				}
			})
			const operatorToken = ts.tokenToString(node.operator) ?? "typeof"
			return this.addSyntaxPseudoCall("<typeOperator>", node, scope, ownerType, isReturn, roots, operatorToken)
		}
		if (ts.isIndexedAccessTypeNode(node)) {
			const roots: CGCall[] = []
			const objectRoot = this.walkTypeNode(
				node.objectType,
				scope,
				declarationScope,
				globalScope,
				ownerType,
				false,
			)
			if (objectRoot) roots.push(objectRoot)
			const indexRoot = this.walkTypeNode(node.indexType, scope, declarationScope, globalScope, ownerType, false)
			if (indexRoot) roots.push(indexRoot)
			return this.addSyntaxPseudoCall("<indexedAccess>", node, scope, ownerType, isReturn, roots, "[")
		}
		if (ts.isTypeLiteralNode(node))
			return this.walkTypeLiteralNode(node, scope, declarationScope, globalScope, ownerType, isReturn)
		if (ts.isConditionalTypeNode(node))
			return this.walkConditionalTypeNode(node, scope, globalScope, ownerType, isReturn)
		if (ts.isInferTypeNode(node)) return this.walkInferTypeNode(node, declarationScope, globalScope, ownerType)

		const fallbackArgs: CGCall[] = []
		ts.forEachChild(node, child => {
			if (ts.isTypeNode(child)) {
				const root = this.walkTypeNode(child, scope, declarationScope, globalScope, ownerType, false)
				if (root) fallbackArgs.push(root)
			}
		})
		if (fallbackArgs.length > 0)
			return this.addSyntaxPseudoCall("<syntax>", node, scope, ownerType, isReturn, fallbackArgs)
		return null
	}

	// Index maintenance
	private rebuildCallIndexes(): void {
		for (const scope of this.graph.scopes) scope.calls.clear()
		for (const type of this.graph.types) type.called.clear()
		for (const call of this.graph.calls) {
			call.scope.calls.add(call)
			call.type.ref.called.add(call)
		}
	}
}
