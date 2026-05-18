import { formatSourceSnippetFromOffsets } from "./format-source-snippet.js";
export function formatGraphViolation(violation, files, options = {}) {
    const source = files.get(violation.path);
    if (!source) {
        throw new Error(`File ${violation.path} is not found`);
    }
    const position = normalizePosition(violation.position, source);
    let result = formatSourceSnippetFromOffsets(violation.path, `[${violation.kind}] ${violation.message}`, source, position, options);
    const relatedItems = violation.related ? [...violation.related] : [];
    if (relatedItems.length > 0) {
        const relatedChunks = [];
        for (const related of relatedItems) {
            const relatedSource = files.get(related.path);
            if (!relatedSource)
                continue;
            const relatedPosition = normalizePosition(related.position, relatedSource);
            const relatedMessage = related.message ?? "Related context:";
            const relatedSnippet = formatSourceSnippetFromOffsets(related.path, relatedMessage, relatedSource, relatedPosition, options);
            relatedChunks.push(relatedSnippet);
        }
        if (relatedChunks.length > 0) {
            result += indentText(4, "\n\nRelated:\n" + relatedChunks.join("\n\n"));
        }
    }
    return result;
}
function normalizePosition(pos, source) {
    const safeStart = source.length > 0 ? Math.max(0, Math.min(pos.start, source.length - 1)) : 0;
    return { start: safeStart, end: Math.max(safeStart + 1, pos.end) };
}
function indentText(size, text) {
    const prefix = "".padStart(size);
    return text
        .split("\n")
        .map(line => line && `${prefix}${line}`)
        .join("\n");
}
