#!/usr/bin/env node

import path from "node:path"
import { pathToFileURL } from "node:url"
import fg from "fast-glob"
import { readFile } from "node:fs/promises"
import { buildContentGraph } from "../src/buildContentGraph.ts"
import { concatContentGraphs } from "../src/concatContentGraphs.ts"
import { getMonadViolations, type MonadTypeOption } from "../src/monadChecker2.ts"
import { formatGraphViolation } from "./format-graph-violation.ts"
import type { FormatSourceSnippetOptions } from "./format-source-snippet.ts"

// CLI responsibility boundary:
// - parse argv and read files
// - delegate semantic decisions to buildContentGraph + monadChecker2
// - render checker diagnostics for humans

class EInvalidOption extends Error {}

type ParsedCli = {
	globs: string[]
	options: FormatSourceSnippetOptions
	monadTypes: MonadTypeOption[]
}

type CliStreams = {
	error(message: string): void
}

const USAGE = `Usage: node check-monad.ts [options] <glob> [glob...]

Options:
  --help, -h
      Print CLI usage and the repository README.

  --snippet-lines <before>[:<after>]
      Number of lines to render around marker (defaults 4:0).
      <before> counts snippet lines up to marker line (inclusive).
      <after> counts lines after marker line.
      Examples: 7, 7:2, :2.

Repeatable options:
  --monad <file> <type-name>:<constructor-name>:<reader-name>:<consumer-name>
      Configure the marker monad type and the three primitive operations.

Resolves files with fast-glob, builds a merged content graph, then reports
violations for each provided monad configuration.

Options and globs may appear in any order. Exit 1 if any violation, if
no --monad is provided, if globs are missing, or if no files match.`

export async function runCli(argv: string[], streams: CliStreams = { error: message => console.error(message) }) {
	try {
		if (argv.includes("--help") || argv.includes("-h")) {
			streams.error(await renderHelpText())
			return 0
		}

		const cli = parseCli(argv)
		if (!cli.monadTypes.length) {
			throw new EInvalidOption("Missing required --monad option.")
		}
		if (!cli.globs.length) {
			throw new EInvalidOption("Missing required glob arguments.")
		}

		const paths = await fg(cli.globs, { onlyFiles: true, unique: true })
		if (paths.length === 0) {
			throw new EInvalidOption("No files matched the provided globs.")
		}

		const files = new Map(
			await Promise.all(
				paths.map(async filePath => [filePath, await readFile(filePath, { encoding: "utf8" })] as const),
			),
		)

		const graph = concatContentGraphs(
			files.entries().map(([filePath, content]) => buildContentGraph(filePath, content)),
		)
		const violations = cli.monadTypes.flatMap(monadType => getMonadViolations(graph, monadType))

		let errorCount = 0
		for (const violation of violations) {
			const formatted = formatGraphViolation(violation, files, cli.options)
			if (formatted) {
				streams.error(formatted)
				errorCount++
			}
		}

		const fileCount = files.size
		const errorLabel = errorCount === 1 ? "error" : "errors"
		const fileLabel = fileCount === 1 ? "file" : "files"
		streams.error(`Found ${errorCount} ${errorLabel} in ${fileCount} ${fileLabel}.`)

		return errorCount > 0 ? 1 : 0
	} catch (error) {
		if (error instanceof EInvalidOption) {
			const message = error instanceof Error ? error.message : String(error)
			streams.error(message)
			streams.error("")
			streams.error(USAGE)
			return 1
		}

		streams.error(String(error))
		return 1
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await runCli(process.argv.slice(2))
}

function parseCli(argv: string[]): ParsedCli {
	const globs: string[] = []
	const monadSpecs: MonadTypeOption[] = []
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
			const monadInfo = argv[i + 2]
			if (!file || !monadInfo) {
				throw new EInvalidOption(
					"Usage: --monad <file> <type-name>:<constructor-name>:<reader-name>:<consumer-name>",
				)
			}
			const parts = monadInfo.split(":")
			if (parts.length !== 4) {
				throw new EInvalidOption(
					"Invalid --monad type pair. Expected <type-name>:<constructor-name>:<reader-name>:<consumer-name>.",
				)
			}
			monadSpecs.push({
				path: path.join(file),
				name: parts[0] ?? "",
				constructorName: parts[1] ?? "",
				readerName: parts[2] ?? "",
				consumerName: parts[3] ?? "",
			})
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
		monadTypes: monadSpecs,
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

async function renderHelpText(): Promise<string> {
	let readme = ""
	try {
		readme = await readFile(new URL("../README.md", import.meta.url), { encoding: "utf8" })
	} catch {
		readme = "README.md not found."
	}

	return `${USAGE}\n\n${readme}`
}
