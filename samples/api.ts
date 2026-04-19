export interface Monad {
	readonly __monadBrand: unique symbol
}

/**
 * Internal companion declaration paired via CLI `--monad ... Monad:MonadPrivate`.
 * Body is not diagnosed; for other types the checker treats calls to this producer like `[result, Monad]`.
 */
export type MonadPrivate<A extends Monad> = [1, A]
