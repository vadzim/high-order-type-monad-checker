import type { MonadViolation } from "../src/monadChecker.ts"
import { formatSourceSnippetFromOffsets, type FormatSourceSnippetOptions } from "./format-source-snippet.ts"

export function formatGraphViolation(
	violation: MonadViolation,
	files: ReadonlyMap<string, string>,
	options: FormatSourceSnippetOptions = {},
): string | null {
	const source = files.get(violation.path)
	if (!source) return null

	const position = normalizePosition(violation.position, source)
	let result = formatSourceSnippetFromOffsets(
		violation.path,
		`[${violation.kind}] ${violation.message}`,
		source,
		position,
		options,
	)

	const relatedItems: {
		message?: string
		position: { start: number; end: number }
		path: string
	}[] = violation.related ? [...violation.related] : []

	if (relatedItems.length > 0) {
		const relatedChunks: string[] = []
		for (const related of relatedItems) {
			const relatedSource = files.get(related.path)
			if (!relatedSource) continue
			const relatedPosition = normalizePosition(related.position, relatedSource)
			const relatedMessage = related.message ?? "Related context:"
			const relatedSnippet = formatSourceSnippetFromOffsets(
				related.path,
				relatedMessage,
				relatedSource,
				relatedPosition,
				options,
			)
			relatedChunks.push(indentSnippet(relatedSnippet, "    "))
		}
		if (relatedChunks.length > 0) {
			result += "\n\n"
			result += "    Related:\n"
			result += relatedChunks.join("\n\n")
		}
	}

	return result
}

function normalizePosition(pos: { start: number; end: number }, source: string): { start: number; end: number } {
	const safeStart = source.length > 0 ? Math.max(0, Math.min(pos.start, source.length - 1)) : 0
	return { start: safeStart, end: Math.max(safeStart + 1, pos.end) }
}

function indentSnippet(snippet: string, prefix: string): string {
	return snippet
		.split("\n")
		.map(line => `${prefix}${line}`)
		.join("\n")
}
