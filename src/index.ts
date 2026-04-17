export { getBorrowViolations as getOpaqueViolations } from "./borrowChecker.ts"
export { resolveForcedTypeArguments } from "./borrowChecker.ts"
export type {
	BorrowViolation as OpaqueViolation,
	BorrowViolationsOptions as OpaqueViolationsOptions,
	ViolationKind,
} from "./types.ts"
