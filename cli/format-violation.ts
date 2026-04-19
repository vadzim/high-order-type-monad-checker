import type { MonadViolation } from "../src/monadCheckerTypes.ts"
import type { ParseTypesResult } from "../src/parseContent.ts"
import type { ParseFilesResult } from "./read-types-from-files.ts"
import { formatSourceSnippetFromOffsets, type FormatSourceSnippetOptions } from "./format-source-snippet.ts"

export function formatViolation(
	violation: MonadViolation,
	{ files, parsed }: ParseFilesResult,
	options: FormatSourceSnippetOptions = {},
): string | null {
	const declarationPathById = declarationPathByIdMap.getOrInsertComputed(parsed, () =>
		buildDeclarationPathById(parsed),
	)

	const filePath = declarationPathById.get(violation.declarationId)
	if (!filePath) return null

	const source = files.get(filePath)
	if (!source) return null

	const position = normalizePosition(violation.position, source)

	const message = violation.message

	const relatedLabel =
		violation.kind === "monad.invalidGenericArgumentConstraint"
			? "last generic parameter (monad-compatible types belong here):"
			: violation.kind === "monad.inconsistentBranchReturn"
				? "returned monad-like type:"
				: violation.kind === "monad.invalidProducerReturn"
					? "expected producer return shape:"
					: violation.kind === "monad.invalidProducerInvocation"
						? "producer invocation is only allowed in return/extends pattern:"
					: violation.kind === "monad.invalidMonadUsage"
						? "allowed monad-like usage positions:"
				: violation.kind === "monad.destructuredBeforeReader"
					? "last generic argument of this call (or second element of a 2-tuple):"
					: violation.kind === "monad.monadArgRequiresMonadBoundParameter"
						? "callee declaration, last type parameter:"
						: "first consumption occurs here:"

	let result = ""

	result += formatSourceSnippetFromOffsets(filePath, message, source, position, options)
	result += "\n\n"

	if (violation.relatedPosition) {
		const relatedPath =
			violation.relatedDeclarationId != null
				? declarationPathById.get(violation.relatedDeclarationId)
				: filePath
		const relatedSource = relatedPath != null ? files.get(relatedPath) : undefined
		if (relatedSource != null && relatedPath != null) {
			const relatedPos = normalizePosition(violation.relatedPosition, relatedSource)
			const relatedSnippet = formatSourceSnippetFromOffsets(
				relatedPath,
				relatedLabel,
				relatedSource,
				relatedPos,
				options,
			)
			result += indentSnippet(relatedSnippet, "    ")
			result += "\n\n"
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

function buildDeclarationPathById(parsed: ReadonlyMap<string, ParseTypesResult>): ReadonlyMap<string, string> {
	return new Map(
		[...parsed.values()].flatMap(({ types }) => [...types.values()].map(type => [type.id, type.path] as const)),
	)
}

const declarationPathByIdMap = new WeakMap<ReadonlyMap<string, ParseTypesResult>, ReadonlyMap<string, string>>()
