import { Position } from "./parseTypes.ts"

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

export type MonadViolation = {
	declarationId: string
	kind: ViolationKind
	message: string
	position: Position
	relatedPosition?: Position
}

export type NamedTypeOption = {
	path: string
	name: string
}

export type ForcedTypeArgumentOption = NamedTypeOption & {
	index: number
}

export type MonadViolationsOptions = {
	forcedReaders?: ForcedTypeArgumentOption[]
	forcedConsumers?: ForcedTypeArgumentOption[]
	monadTypes: NamedTypeOption[]
}
