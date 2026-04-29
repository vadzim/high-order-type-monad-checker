export type SourceHighlight = {
    /** 1-based line number. */
    line: number;
    /** 1-based start column (inclusive). */
    column: number;
    /** 1-based end column (inclusive). Defaults to `column`. */
    endColumn?: number;
};
/** Anchor for {@link formatSourceSnippet}: 1-based line, UTF-16 `startPos` in `source`, and marker width. */
export type FormatSourceSnippetAnchor = {
    /** 1-based line number. */
    line: number;
    /** UTF-16 character offset in line where the red `~` marker starts. */
    startPos: number;
    /** Number of `~` characters (e.g. type name length). */
    textLength: number;
};
export type OffsetRange = {
    start: number;
    end: number;
};
export type ResolvedDiagnostic = {
    line: number;
    column: number;
    anchor: FormatSourceSnippetAnchor;
};
export type FormatSourceSnippetOptions = {
    /** Lines above the highlighted line (default 3). */
    contextBefore?: number;
    /** Lines below the highlighted line (default 0). */
    contextAfter?: number;
    /** Strip ANSI sequences (no colors / no reversed line numbers). */
    noColor?: boolean;
    /** Tab width for aligning markers when lines contain tab characters (default {@link DEFAULT_SNIPPET_TAB_WIDTH}). */
    tabWidth?: number;
};
/** Tab size in spaces: each tab advances to the next tab stop; used by {@link formatSourceSnippet} unless `tabWidth` is set. */
export declare const DEFAULT_SNIPPET_TAB_WIDTH = 4;
export declare function formatSourceSnippetFromOffsets(file: string, message: string, source: string, pos: OffsetRange, options?: FormatSourceSnippetOptions): string;
export declare function resolveDiagnosticFromOffsets(source: string, pos: OffsetRange): ResolvedDiagnostic;
/**
 * Build highlight from UTF-16 offsets (same as TS). If `start`/`end` span newlines, `end` is clipped
 * to the end of the start line.
 */
export declare function highlightFromOffsets(source: string, pos: OffsetRange): SourceHighlight;
