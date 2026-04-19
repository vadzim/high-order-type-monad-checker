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
	| "monad.invalidProducerReturn"
	| "monad.invalidProducerInvocation"
	| "monad.invalidMonadUsage"
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

/** Public monad brand plus a paired “private” declaration that may use the monad parameter freely. */
export type MonadTypePairOption = {
	path: string
	/** Exported / public monad identity (Monad-compatible root). */
	name: string
	/**
	 * Companion declaration in the same file: no diagnostics are attributed to its body.
	 * For producer / caller checks it is treated like a type that returns `[result, Monad]`.
	 */
	privateName: string
}

export type MonadViolationsOptions = {
	monadTypes: MonadTypePairOption[]
}
