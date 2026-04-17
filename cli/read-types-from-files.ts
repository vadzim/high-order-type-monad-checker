import fg from "fast-glob"
import { readFile } from "node:fs/promises"
import { parseTypes } from "../src/parseTypes.ts"
import type { ParseTypesOptions, ParseTypesResult } from "../src/parseTypes.ts"

export async function readTypesFromFiles(masks: string[], options: ParseTypesOptions = {}) {
	const paths = await fg(masks, { onlyFiles: true, unique: true })

	const files = await Promise.all(
		paths.map(async filePath => ({ path: filePath, content: await readFile(filePath, { encoding: "utf8" }) })),
	)

	const parsedFiles = files.map((file, index) =>
		parseTypes(file.path, file.content, {
			...options,
			idPrefix: `${options.idPrefix ?? "id"}-f-${index}:`,
		}),
	)

	const parsed: ParseTypesResult = {
		types: new Map(parsedFiles.values().flatMap(({ types }) => types.entries())),
		scopes: new Map(parsedFiles.values().flatMap(({ scopes }) => scopes.entries())),
	}

	return { files, parsed }
}
