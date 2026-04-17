import fg from "fast-glob"
import { readFile } from "node:fs/promises"
import { parseFilesContent } from "../src/parseContent.ts"
import type { ParseTypesOptions, ParseTypesResult } from "../src/parseContent.ts"

export type ParseFilesResult = {
	files: ReadonlyMap<string, string>
	parsed: ReadonlyMap<string, ParseTypesResult>
}

export async function readTypesFromFiles(masks: string[], options: ParseTypesOptions = {}): Promise<ParseFilesResult> {
	const paths = await fg(masks, { onlyFiles: true, unique: true })

	const files = new Map(
		await Promise.all(
			paths.map(async filePath => [filePath, await readFile(filePath, { encoding: "utf8" })] as const),
		),
	)

	const parsed = parseFilesContent(files, options)

	return { files, parsed }
}
