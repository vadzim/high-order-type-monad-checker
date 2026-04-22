import type { Position } from "../src/parseContent.ts"

export type SourceHighlight = {
	/** 1-based line number. */
	line: number
	/** 1-based start column (inclusive). */
	column: number
	/** 1-based end column (inclusive). Defaults to `column`. */
	endColumn?: number
}

/** Anchor for {@link formatSourceSnippet}: 1-based line, UTF-16 `startPos` in `source`, and marker width. */
export type FormatSourceSnippetAnchor = {
	/** 1-based line number. */
	line: number
	/** UTF-16 character offset in line where the red `~` marker starts. */
	startPos: number
	/** Number of `~` characters (e.g. type name length). */
	textLength: number
}

export type OffsetRange = {
	start: number
	end: number
}

export type ResolvedDiagnostic = {
	line: number
	column: number
	anchor: FormatSourceSnippetAnchor
}

export type FormatSourceSnippetOptions = {
	/** Lines above the highlighted line (default 3). */
	contextBefore?: number
	/** Lines below the highlighted line (default 0). */
	contextAfter?: number
	/** Strip ANSI sequences (no colors / no reversed line numbers). */
	noColor?: boolean
	/** Tab width for aligning markers when lines contain tab characters (default {@link DEFAULT_SNIPPET_TAB_WIDTH}). */
	tabWidth?: number
}

/** Tab size in spaces: each tab advances to the next tab stop; used by {@link formatSourceSnippet} unless `tabWidth` is set. */
export const DEFAULT_SNIPPET_TAB_WIDTH = 4

const DIAG_ANSI = {
	reset: "\x1b[0m",
	lightCyan: "\x1b[96m",
	lightYellow: "\x1b[93m",
} as const

function formatDiagnosticHeader(
	file: string,
	line: number,
	column: number,
	message: string,
	options: FormatSourceSnippetOptions,
): string {
	if (!useAnsi(options)) {
		return `${file}:${line}:${column} - ${message}`
	}
	return `${DIAG_ANSI.lightCyan}${file}${DIAG_ANSI.reset}:${DIAG_ANSI.lightYellow}${line}${DIAG_ANSI.reset}:${DIAG_ANSI.lightYellow}${column}${DIAG_ANSI.reset} - ${message}`
}

export function formatSourceSnippetFromOffsets(
	file: string,
	message: string,
	source: string,
	pos: OffsetRange,
	options: FormatSourceSnippetOptions = {},
): string {
	const resolved = resolveDiagnosticFromOffsets(source, pos)
	const header = formatDiagnosticHeader(file, resolved.line, resolved.column, message, options)
	const snippet = formatSourceSnippet(source, resolved.anchor, options)
	return `${header}\n${snippet}`
}

export function resolveDiagnosticFromOffsets(source: string, pos: OffsetRange): ResolvedDiagnostic {
	const safeStart = source.length > 0 ? Math.max(0, Math.min(pos.start, source.length - 1)) : 0
	const safeEnd = Math.max(safeStart + 1, pos.end)
	const highlight = highlightFromOffsets(source, { start: safeStart, end: safeEnd })
	const rawLen = Math.max(1, pos.end - pos.start)
	const maxLen = Math.max(1, source.length - safeStart)
	return {
		line: highlight.line,
		column: highlight.column,
		anchor: {
			line: highlight.line,
			startPos: Math.max(0, highlight.column - 1),
			textLength: Math.min(rawLen, maxLen),
		},
	}
}

/**
 * Renders numbered context lines (reversed line numbers when ANSI enabled), the highlighted line,
 * then a red `~` marker of length `anchor.textLength` starting at column derived from `anchor.startPos`
 * on `anchor.line`.
 */
function formatSourceSnippet(
	source: string,
	anchor: FormatSourceSnippetAnchor,
	options: FormatSourceSnippetOptions,
): string {
	const before = options?.contextBefore ?? 3
	const after = options?.contextAfter ?? 0
	const tabWidth =
		typeof options?.tabWidth === "number" && Number.isFinite(options.tabWidth) && options.tabWidth >= 1
			? Math.floor(options.tabWidth)
			: DEFAULT_SNIPPET_TAB_WIDTH
	const color = useAnsi(options)
	const lines = splitLines(source)
	const lineIndex = anchor.line - 1
	if (lineIndex < 0 || lineIndex >= lines.length) {
		return ""
	}

	const text = lines[lineIndex]
	if (text === undefined) {
		return ""
	}

	const start = Math.max(0, lineIndex - before)
	const end = Math.min(lines.length - 1, lineIndex + after)
	const gutterW = gutterWidthForRange(start + 1, end + 1)
	const out: string[] = []

	for (let i = start; i <= end; i++) {
		const lineText = lines[i]
		if (lineText === undefined) continue
		const displayLine = i + 1
		const displayText = expandTabsInLine(lineText, tabWidth)

		out.push(formatGutterLine(displayLine, gutterW, displayText, color))
		if (i === lineIndex) {
			const anchorText =
				" ".repeat(expandTabsInLine(lineText.slice(0, anchor.startPos), tabWidth).length) +
				(color ? ansi.lightRed : "") +
				"~".repeat(anchor.textLength) +
				(color ? ansi.reset : "")
			out.push(" ".repeat(gutterW) + " | " + anchorText)
		}
	}

	return out.join("\n")
}

const ansi = {
	reset: "\x1b[0m",
	reverse: "\x1b[7m",
	lightRed: "\x1b[91m",
} as const

function useAnsi(options?: FormatSourceSnippetOptions): boolean {
	if (options?.noColor) return false
	return true
}

function gutterWidthForRange(startLine: number, endLine: number): number {
	let result = Math.max(String(startLine).length, String(endLine).length)
	if (result < 3) result += 1
	return result
}

function formatGutterLine(lineNo: number, gutterW: number, sourceText: string, color: boolean): string {
	const padded = String(lineNo).padStart(gutterW, " ")
	const num = color ? `${ansi.reverse}${padded}${ansi.reset}` : padded
	if (!sourceText) return `${num} |`
	return `${num} | ${sourceText}`
}

function blankGutter(gutterW: number, color: boolean): string {
	if (color) {
		const padded = " ".repeat(gutterW)
		return `${ansi.reverse}${padded}${ansi.reset} | `
	}
	return `${" ".repeat(gutterW)} | `
}

/** Visual column (0-based) after processing `line[0..end)`; tabs advance to tab stops. */
function visualWidthUpTo(line: string, end: number, tabWidth: number): number {
	let w = 0
	const n = Math.max(0, Math.min(end, line.length))
	for (let i = 0; i < n; i++) {
		const c = line[i]
		if (c === "\t") {
			w += tabWidth - (w % tabWidth)
		} else {
			w += 1
		}
	}
	return w
}

/** Replace tabs with spaces so printed width matches {@link visualWidthUpTo}. */
function expandTabsInLine(line: string, tabWidth: number): string {
	let out = ""
	let col = 0
	for (let i = 0; i < line.length; i++) {
		const c = line[i]
		if (c === "\t") {
			const n = tabWidth - (col % tabWidth)
			out += " ".repeat(n)
			col += n
		} else {
			out += c
			col += 1
		}
	}
	return out
}

/**
 * Build highlight from UTF-16 offsets (same as TS). If `start`/`end` span newlines, `end` is clipped
 * to the end of the start line.
 */
export function highlightFromOffsets(source: string, pos: Position): SourceHighlight {
	const lines = splitLines(source)
	let offset = 0
	for (let i = 0; i < lines.length; i++) {
		const lineText = lines[i] ?? ""
		const lineStart = offset
		const contentEnd = offset + lineText.length
		const onLastLine = i === lines.length - 1
		if (pos.start <= contentEnd || onLastLine) {
			const colStart = Math.max(1, pos.start - lineStart + 1)
			const endClipped = Math.min(pos.end, contentEnd)
			const colEnd = Math.max(colStart, Math.min(endClipped - lineStart + 1, lineText.length + 1))
			return { line: i + 1, column: colStart, endColumn: colEnd }
		}
		offset = contentEnd + newlineLen(source, contentEnd)
	}
	return { line: 1, column: 1, endColumn: 1 }
}

function splitLines(source: string): string[] {
	return source.split(/\r\n|\n|\r/)
}

function newlineLen(source: string, at: number): number {
	if (at >= source.length) return 0
	if (source[at] === "\r" && source[at + 1] === "\n") return 2
	if (source[at] === "\n" || source[at] === "\r") return 1
	return 0
}
