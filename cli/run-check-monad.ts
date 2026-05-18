import path from "node:path"
import fg from "fast-glob"
import { readFile } from "node:fs/promises"
import { buildContentGraph } from "../src/buildContentGraph.ts"
import { concatContentGraphs } from "../src/concatContentGraphs.ts"
import { getMonadViolations, type MonadTypeOption } from "../src/monadChecker.ts"
import { formatGraphViolation } from "./format-graph-violation.ts"
import { resolveDiagnosticFromOffsets, type FormatSourceSnippetOptions } from "./format-source-snippet.ts"

// CLI responsibility boundary:
// - parse argv and read files
// - delegate semantic decisions to buildContentGraph + monadChecker
// - render checker diagnostics for humans

class EInvalidOption extends Error {}

type ParsedCli = {
	globs: string[]
	options: FormatSourceSnippetOptions
	monadTypes: MonadTypeOption[]
	strict: boolean
	onlyOne: boolean
}

type CliStreams = {
	log(message: string): void
	error(message: string): void
}

const USAGE = `Usage: check-monad [options] <glob> [glob...]

Options:
  --help, -h
      Print CLI usage and the repository README.

  --snippet-lines <before>[:<after>]
      Number of lines to render around marker (defaults 4:0).
      <before> counts snippet lines up to marker line (inclusive).
      <after> counts lines after marker line.
      Examples: 7, 7:2, :2.

  --no-strict
      Disable strict mode and allow --monad modules outside loaded globs.

Repeatable options:
  --monad <file> <type-name>:<constructor-name>:<reader-name>:<consumer-name>
      Configure the marker monad type and the three primitive operations.

Resolves files with fast-glob, builds a merged content graph, then reports
violations for each provided monad configuration.

Options and globs may appear in any order. Exit 1 if any violation, if
no --monad is provided, if globs are missing, or if no files match.`

export async function runCli(argv: string[], streams: CliStreams = console) {
	try {
		if (argv.includes("--help") || argv.includes("-h")) {
			streams.log(await renderHelpText())
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

		if (cli.strict) {
			const loadedFiles = new Set(paths.map(filePath => path.resolve(filePath)))
			const missingMonadModules = Array.from(
				new Set(
					cli.monadTypes
						.map(monadType => monadType.path)
						.filter(monadPath => !loadedFiles.has(path.resolve(monadPath))),
				),
			)
			if (missingMonadModules.length > 0) {
				throw new EInvalidOption(
					`Strict mode failed: module from --monad is not loaded by globs: ${missingMonadModules.join(", ")}`,
				)
			}
		}

		const graph = concatContentGraphs(
			files.entries().map(([filePath, content]) => buildContentGraph(filePath, content)),
		)

		const violations = cli.monadTypes.flatMap(monadType =>
			getMonadViolations(graph, { ...monadType, strictMonadModule: cli.strict }),
		)

		const formatted = violations.map(violation => formatGraphViolation(violation, files, cli.options))
		console.error((cli.onlyOne ? formatted.slice(0, 1) : formatted).join("\n"))

		const fileStats = summarizeFiles(violations, files)
		const fileCount = fileStats.length
		const checkedFileCount = files.size
		const checkedFileLabel = checkedFileCount === 1 ? "file" : "files"
		const errorLabel = violations.length === 1 ? "error" : "errors"
		const fileLabel = fileCount === 1 ? "file" : "files"
		streams.log(`Checked ${checkedFileCount} ${checkedFileLabel}.`)
		if (violations.length === 0) {
			streams.log("Found 0 errors.")
		} else {
			streams.log(`Found ${violations.length} ${errorLabel} in ${fileCount} ${fileLabel}.`)
		}
		if (fileStats.length > 0) {
			streams.log("")
			streams.log("Errors  Files")
			for (const stat of fileStats) {
				streams.log(`${String(stat.errors).padStart(6, " ")}  ${stat.path}:${stat.firstLine}`)
			}
		}

		return violations.length > 0 ? 1 : 0
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

function summarizeFiles(
	violations: Array<{ path: string; position: { start: number; end: number } }>,
	files: ReadonlyMap<string, string>,
): { path: string; errors: number; firstLine: number }[] {
	const stats = new Map<string, { errors: number; firstLine: number }>()
	for (const violation of violations) {
		const source = files.get(violation.path)
		if (!source) continue
		const line = resolveDiagnosticFromOffsets(source, violation.position).line
		const current = stats.get(violation.path)
		if (!current) {
			stats.set(violation.path, { errors: 1, firstLine: line })
			continue
		}
		current.errors += 1
		current.firstLine = Math.min(current.firstLine, line)
	}
	return Array.from(stats.entries())
		.map(([path, stat]) => ({ path, ...stat }))
		.sort((a, b) => a.path.localeCompare(b.path))
}

function parseCli(argv: string[]): ParsedCli {
	const globs: string[] = []
	const monadSpecs: MonadTypeOption[] = []
	let options: FormatSourceSnippetOptions = { contextBefore: 4, contextAfter: 0 }
	let strict = true
	let onlyOne = false

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
		if (token === "--no-strict") {
			strict = false
			i += 1
			continue
		}
		if (token === "-1" || token === "--1") {
			onlyOne = true
			i += 1
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
		strict,
		onlyOne,
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
	for (const rel of ["../README.md", "../../README.md"]) {
		try {
			readme = await readFile(new URL(rel, import.meta.url), { encoding: "utf8" })
			break
		} catch {
			// try next candidate (cli/ vs dist/cli/)
		}
	}
	if (!readme) readme = "README.md not found."

	return `${USAGE}\n\n${readme}`
}
