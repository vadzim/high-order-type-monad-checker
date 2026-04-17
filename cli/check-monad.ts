#!/usr/bin/env node

import path from "node:path"
import { getMonadViolations } from "../src/monadChecker.ts"
import type { NamedTypeOption, MonadViolationsOptions } from "../src/monadCheckerTypes.ts"
import { readTypesFromFiles } from "./read-types-from-files.ts"
import { formatViolation } from "./format-violation.ts"
import type { FormatSourceSnippetOptions } from "./format-source-snippet.ts"
import { buildDeclarationPathById } from "../src/parsed-content-helpers.ts"

// CLI responsibility boundary:
// - parse argv and read files
// - delegate semantic decisions to parseTypes + monadChecker
// - render checker diagnostics for humans

class EInvalidOption extends Error {}

type ParsedCli = {
	globs: string[]
	options: FormatSourceSnippetOptions
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
  --skip-body <file> <type-name>
      Do not report violations for code inside that type alias / interface /
      class body (same path + name resolution as --monad). Call sites in
      other types are still checked.

Resolves files with fast-glob, runs readTypes per file, then reports
getMonadViolations() for each provided monad type identity.

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

	const declarationPathById = buildDeclarationPathById(loaded.parsed)

	let errorCount = 0

	const fileViolations = getMonadViolations(loaded.parsed, cli.checkerOptions)
	for (const violation of fileViolations) {
		const formatted = formatViolation(violation, loaded, cli.options)
		if (formatted) {
			console.error(formatted)
			errorCount++
		}
	}

	const fileCount = loaded.files.size

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

function parseCli(argv: string[]): ParsedCli {
	const globs: string[] = []
	const monadSpecs: NamedTypeOption[] = []
	const skipBodySpecs: NamedTypeOption[] = []
	let options: FormatSourceSnippetOptions = { contextBefore: 4, contextAfter: 0 }

	let i = 0
	while (i < argv.length) {
		const token = argv[i]
		if (!token) break
		if (token === "--snippet-lines") {
			const value = argv[i + 1]
			if (!value) throw new EInvalidOption("Missing value for --snippet-lines.")
			const { contextBefore, contextAfter } = parseSnippetLines(value)
			options = { ...options, contextBefore, contextAfter }
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
		if (token === "--skip-body") {
			const file = argv[i + 1]
			const typeName = argv[i + 2]
			if (!file || !typeName) throw new EInvalidOption("Usage: --skip-body <file> <type-name>")
			skipBodySpecs.push({ path: path.join(file), name: typeName })
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
		options,
		checkerOptions: {
			monadTypes: monadSpecs,
			skipDeclarationBodies: skipBodySpecs.length ? skipBodySpecs : undefined,
		},
	}
}

function parseSnippetLines(input: string): {
	contextBefore: number
	contextAfter: number
} {
	const parts = input.split(":")
	if (parts.length > 2) throw new EInvalidOption(`Invalid --snippet-lines value '${input}'.`)
	if (parts.length === 1) {
		const before = parseNonNegative(parts[0] ?? "", "snippet before")
		return { contextBefore: before, contextAfter: 0 }
	}
	const beforeText = parts[0] ?? ""
	const afterText = parts[1] ?? ""
	const contextBefore = beforeText.length ? parseNonNegative(beforeText, "snippet before") : 4
	const contextAfter = afterText.length ? parseNonNegative(afterText, "snippet after") : 0
	return { contextBefore, contextAfter }
}

function parseNonNegative(raw: string, label: string): number {
	if (!/^\d+$/.test(raw)) throw new EInvalidOption(`Invalid ${label} '${raw}'. Expected non-negative integer.`)
	return Number(raw)
}
