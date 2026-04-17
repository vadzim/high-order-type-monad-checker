import type { ParseTypesResult } from "../src/parseContent.ts"

export function buildDeclarationPathById(parsed: ReadonlyMap<string, ParseTypesResult>) {
	return new Map(
		[...parsed.values()].flatMap(({ types }) => [...types.values()].map(type => [type.id, type.path] as const)),
	)
}
