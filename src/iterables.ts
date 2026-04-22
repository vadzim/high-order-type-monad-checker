export function walk<T>(items: Iterable<T>, mapper: (item: T) => Iterable<T>): Generator<T> {
	const visited = new Set<T>()

	return (function* walkInner(itemsInner: Iterable<T>): Generator<T> {
		for (const item of itemsInner) {
			if (visited.has(item)) continue
			visited.add(item)
			yield item
			yield* walkInner(mapper(item))
		}
	})(items)
}
