import type { Position } from "./parseContent.ts"

export type MonadArgConstraint = {
	genericName: string
	parameterName: string
	monadName: string
	argumentName: string
	position: Position
	relatedPosition?: Position
}

export type TypeUsage = {
	declarationId: string
	targetName: string
	role: "condition" | "branch" | "inferConstraint"
	pathKey: string
	wrappedByReaders: string[]
	wrappedByConsumers: string[]
	isDirectReaderArgument: boolean
	position: Position
}

export type ViolationKind =
	| "monad.consumeMultipleInPath"
	| "monad.usedInCondition"
	| "monad.invalidGenericArgumentConstraint"
	| "monad.invalidInferConstraint"
	| "monad.destructuredBeforeReader"
	| "monad.inconsistentBranchReturn"
	| "monad.monadArgRequiresMonadBoundParameter"

export type MonadViolation = {
	declarationId: string
	kind: ViolationKind
	message: string
	position: Position
	relatedPosition?: Position
	/** When set with `relatedPosition`, positions are resolved in this type's source file (e.g. imported callee). */
	relatedDeclarationId?: string
}

export type NamedTypeOption = {
	path: string
	name: string
}

export type MonadViolationsOptions = {
	monadTypes: NamedTypeOption[]
	/**
	 * Named declarations (file path + type name, same resolution as `--monad`) for which
	 * no violations are reported on code inside that declaration's body.
	 */
	skipDeclarationBodies?: NamedTypeOption[]
}
