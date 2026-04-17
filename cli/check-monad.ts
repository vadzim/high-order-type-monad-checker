#!/usr/bin/env node

import path from "node:path"
import { getMonadViolations } from "../src/monadChecker.ts"
import type {
	MonadViolation,
	ForcedTypeArgumentOption,
	NamedTypeOption,
	MonadViolationsOptions,
} from "../src/types.ts"
import { formatSourceSnippetFromOffsets } from "./format-source-snippet.ts"
import { readTypesFromFiles } from "./read-types-from-files.ts"

// CLI responsibility boundary:
// - parse argv and read files
// - delegate semantic decisions to parseTypes + monadChecker
// - render checker diagnostics for humans

class EInvalidOption extends Error {}

type SnippetConfig = {
	before: number
	after: number
}

type ParsedCli = {
	globs: string[]
	snippet: SnippetConfig
	checkerOptions: MonadViolationsOptions
}

const USAGE = `Usage: node check-monad.ts [options] <glob> [glob...]

Options:
  --snippet-lines <before>[:<after>]
      Number of lines to render around marker (defaults 4:0).
      <before> counts snippet lines up to marker line (inclusive).
      <after> counts lines after marker line.
      Examples: 7, 7:2, :2.

Repeatable options:
  --monad <file> <type-name>
      Branded / leaf monad identity to enforce.
  --consumer <file> <spec>
      Marks consumer slots for a generic (or leaf). <spec> is
      TypeName or TypeName:<index> (0-based type parameter index).
      With no indices, defaults to slot 0 (same as TypeName:0).
  --reader <file> <spec>
      Marks reader slots for a generic (or leaf). <spec> is
      TypeName or TypeName:<index> (0-based type parameter index).
      With no indices, defaults to slot 0 (same as TypeName:0).

Resolves files with fast-glob, runs readTypes per file, then reports
getMonadViolations() for each provided monad type identity (each run
receives the same --consumer list).

Options and globs may appear in any order. Exit 1 if any violation, if
no --monad is provided, if globs are missing, or if no files match.`

try {
	const cli = parseCli(process.argv.slice(2))
	if (!cli.checkerOptions.monadTypes?.length) {
		throw new EInvalidOption("Missing required --monad option.")
	}
	if (!cli.globs.length) {
		throw new EInvalidOption("Missing required glob arguments.")
	}

	const loaded = await readTypesFromFiles(cli.globs, { idPrefix: "check-monad" })
	if (loaded.files.size === 0) {
		throw new EInvalidOption("No files matched the provided globs.")
	}

	const preparedFiles = [...loaded.files.entries()].map(([filePath, source]) => ({
		filePath: path.join(filePath),
		source,
	}))

	const sourceByPath = new Map(preparedFiles.map(file => [file.filePath, file.source] as const))
	const declarationPathById = new Map(
		[...loaded.parsed.values()].flatMap(({ types }) => [...types.values()].map(type => [type.id, type.path] as const)),
	)
	const violations: RenderViolation[] = []

	const fileViolations = getMonadViolations(loaded.parsed, cli.checkerOptions)
	for (const violation of fileViolations) {
		const rendered = toRenderableViolation(violation, declarationPathById, sourceByPath)
		if (rendered) violations.push(rendered)
	}

	for (const violation of violations.values()) {
		console.error(
			formatSourceSnippetFromOffsets(
				violation.filePath,
				violation.message,
				violation.source,
				violation.position,
				{ contextBefore: cli.snippet.before, contextAfter: cli.snippet.after },
			),
		)
		if (violation.related) {
			console.error("")
			const relatedSnippet = formatSourceSnippetFromOffsets(
				violation.filePath,
				violation.relatedLabel,
				violation.source,
				violation.related,
				{ contextBefore: cli.snippet.before, contextAfter: cli.snippet.after },
			)
			console.error(indentSnippet(relatedSnippet, "    "))
		}
		console.error("")
	}
	const errorCount = violations.length
	const fileCount = preparedFiles.length

	const errorLabel = errorCount === 1 ? "error" : "errors"
	const fileLabel = fileCount === 1 ? "file" : "files"
	console.error(`Found ${errorCount} ${errorLabel} in ${fileCount} ${fileLabel}.`)

	if (errorCount > 0) {
		process.exitCode = 1
	}
} catch (error) {
	if (error instanceof EInvalidOption) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(message)
		console.error("")
		console.error(USAGE)
		process.exit(1)
	}

	console.error(error)
	process.exit(1)
}

type RenderViolation = {
	filePath: string
	source: string
	message: string
	position: { start: number; end: number }
	related?: {
		start: number
		end: number
	}
	relatedLabel: string
}

function toRenderableViolation(
	violation: MonadViolation,
	declarationPathById: Map<string, string>,
	sourceByPath: Map<string, string>,
): RenderViolation | null {
	const filePath = declarationPathById.get(violation.declarationId)
	if (!filePath) return null
	const source = sourceByPath.get(filePath)
	if (!source) return null
	const primary = normalizePosition(violation.position, source)
	const related = violation.relatedPosition ? normalizePosition(violation.relatedPosition, source) : undefined
	return {
		filePath,
		source,
		message: violation.message,
		position: primary,
		relatedLabel:
			violation.kind === "monad.invalidGenericArgumentConstraint"
				? "generic declaration:"
				: "first consumption occurs here:",
		related: related
			? {
					start: related.start,
					end: related.end,
				}
			: undefined,
	}
}

function normalizePosition(pos: { start: number; end: number }, source: string): { start: number; end: number } {
	const safeStart = source.length > 0 ? Math.max(0, Math.min(pos.start, source.length - 1)) : 0
	return { start: safeStart, end: Math.max(safeStart + 1, pos.end) }
}

function parseCli(argv: string[]): ParsedCli {
	const globs: string[] = []
	const monadSpecs: NamedTypeOption[] = []
	const consumerSpecs: ForcedTypeArgumentOption[] = []
	const readerSpecs: ForcedTypeArgumentOption[] = []
	let snippet: SnippetConfig = { before: 4, after: 0 }

	let i = 0
	while (i < argv.length) {
		const token = argv[i]
		if (!token) break
		if (token === "--snippet-lines") {
			const value = argv[i + 1]
			if (!value) throw new EInvalidOption("Missing value for --snippet-lines.")
			snippet = parseSnippetLines(value)
			i += 2
			continue
		}
		if (token === "--monad") {
			const file = argv[i + 1]
			const typeName = argv[i + 2]
			if (!file || !typeName) throw new EInvalidOption("Usage: --monad <file> <type-name>")
			monadSpecs.push({ path: path.join(file), name: typeName })
			i += 3
			continue
		}
		if (token === "--consumer" || token === "--reader") {
			const file = argv[i + 1]
			const specText = argv[i + 2]
			if (!file || !specText) throw new EInvalidOption(`Usage: ${token} <file> <spec>`)
			const spec = parseSlotSpec(file, specText)
			if (token === "--consumer") consumerSpecs.push(spec)
			else readerSpecs.push(spec)
			i += 3
			continue
		}
		if (token.startsWith("--")) {
			throw new EInvalidOption(`Unknown option '${token}'.`)
		}
		globs.push(path.join(token))
		i += 1
	}

	return {
		globs,
		snippet,
		checkerOptions: {
			monadTypes: monadSpecs,
			forcedConsumers: consumerSpecs,
			forcedReaders: readerSpecs,
		},
	}
}

function parseSnippetLines(input: string): SnippetConfig {
	const parts = input.split(":")
	if (parts.length > 2) throw new EInvalidOption(`Invalid --snippet-lines value '${input}'.`)
	if (parts.length === 1) {
		const before = parseNonNegative(parts[0] ?? "", "snippet before")
		return { before, after: 0 }
	}
	const beforeText = parts[0] ?? ""
	const afterText = parts[1] ?? ""
	const before = beforeText.length ? parseNonNegative(beforeText, "snippet before") : 4
	const after = afterText.length ? parseNonNegative(afterText, "snippet after") : 0
	return { before, after }
}

function parseSlotSpec(file: string, specText: string): ForcedTypeArgumentOption {
	const [typeName, ...rest] = specText.split(":")
	if (!typeName) throw new EInvalidOption(`Invalid spec '${specText}'.`)
	if (!rest.length) {
		return { path: path.join(file), name: typeName, index: 0 }
	}
	if (rest.length !== 1) {
		throw new EInvalidOption(`Invalid spec '${specText}'. Expected TypeName or TypeName:<index>.`)
	}
	const [indexText] = rest
	return {
		path: path.join(file),
		name: typeName,
		index: parseNonNegative(indexText ?? "", `${typeName} index 0`),
	}
}

function parseNonNegative(raw: string, label: string): number {
	if (!/^\d+$/.test(raw)) throw new EInvalidOption(`Invalid ${label} '${raw}'. Expected non-negative integer.`)
	return Number(raw)
}

function indentSnippet(snippet: string, prefix: string): string {
	return snippet
		.split("\n")
		.map(line => `${prefix}${line}`)
		.join("\n")
}
