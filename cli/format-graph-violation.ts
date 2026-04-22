import type { MonadViolation } from "../src/monadChecker2.ts"
import { formatSourceSnippetFromOffsets, type FormatSourceSnippetOptions } from "./format-source-snippet.ts"

export function formatGraphViolation(
	violation: MonadViolation,
	files: ReadonlyMap<string, string>,
	options: FormatSourceSnippetOptions = {},
): string | null {
	const source = files.get(violation.path)
	if (!source) return null

	const position = normalizePosition(violation.position, source)
	let result = formatSourceSnippetFromOffsets(violation.path, violation.message, source, position, options)

	if (violation.relatedPosition && violation.relatedPath) {
		const relatedSource = files.get(violation.relatedPath)
		if (relatedSource) {
			const relatedPosition = normalizePosition(violation.relatedPosition, relatedSource)
			const relatedMessage = violation.relatedMessage ?? "Related context:"
			const relatedSnippet = formatSourceSnippetFromOffsets(
				violation.relatedPath,
				relatedMessage,
				relatedSource,
				relatedPosition,
				options,
			)
			result += "\n\n"
			result += indentSnippet(relatedSnippet, "    ")
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
