import { Position } from "./parseTypes.ts"

export type OpaqueArgConstraint = {
	genericName: string
	parameterName: string
	opaqueName: string
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
	| "opaque.consumeMultipleInPath"
	| "opaque.usedInCondition"
	| "opaque.invalidGenericArgumentConstraint"
	| "opaque.invalidInferConstraint"
	| "opaque.destructuredBeforeReader"

export type BorrowViolation = {
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

export type BorrowViolationsOptions = {
	forcedReaders?: ForcedTypeArgumentOption[]
	forcedConsumers?: ForcedTypeArgumentOption[]
	opaqueTypes?: NamedTypeOption[]
}
