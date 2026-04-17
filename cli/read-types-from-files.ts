import fg from "fast-glob"
import { readFile } from "node:fs/promises"
import { parseTypes } from "../src/parseTypes.ts"
import type { ParseTypesOptions, ParseTypesResult } from "../src/parseTypes.ts"

export async function readTypesFromFiles(
	masks: string[],
	options: ParseTypesOptions = {},
): Promise<{
	files: Map<string, string>
	parsed: Map<string, ParseTypesResult>
}> {
	const paths = await fg(masks, { onlyFiles: true, unique: true })

	const files = new Map(
		await Promise.all(
			paths.map(async filePath => [filePath, await readFile(filePath, { encoding: "utf8" })] as const),
		),
	)

	const parsed = new Map(
		files
			.entries()
			.map(([path, content], index) => [
				path,
				parseTypes(path, content, { idPrefix: `${options.idPrefix ?? ""}f-${index}:` }),
			]),
	)

	return { files, parsed }
}
