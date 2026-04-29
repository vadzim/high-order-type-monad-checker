export function walk(items, mapper) {
    const visited = new Set();
    return (function* walkInner(itemsInner) {
        for (const item of itemsInner) {
            if (visited.has(item))
                continue;
            visited.add(item);
            yield item;
            yield* walkInner(mapper(item));
        }
    })(items);
}
