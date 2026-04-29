import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runCli } from "../cli/run-check-monad.ts"

const monadModule = `
type Monad = { head: string, tail: string }
type MCreate<Text extends string> =
	Parse<string> extends [infer Head extends string, infer Tail extends string]
		? [{ head: Head, tail: Tail }] extends [infer Result extends Monad]
			? Result
			: never
		: never
type MRead<M extends Monad> = M["head"]
type MNext<M extends Monad> = MCreate<M["tail"]>
`

async function withTempFile(source: string, fn: (filePath: string) => void | Promise<void>) {
	const dir = await mkdtemp(path.join(tmpdir(), "monad-checker-cli-"))
	const filePath = path.join(dir, "sample.ts")
	try {
		await writeFile(filePath, source, "utf8")
		await fn(filePath)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

async function captureCli(args: string[]) {
	const messages: string[] = []
	const status = await runCli(args, {
		log: message => messages.push(message),
		error: message => messages.push(message),
	})
	return { status, stderr: messages.join("\n").replaceAll(/\x1b\[[0-9;]*m/g, "") }
}

test("cli exits 0 when the graph has no monad violations", async () => {
	const source = `${monadModule}
type Ok<M extends Monad> = [MNext<M>, MRead<M>]
`

	await withTempFile(source, filePath => {
		return captureCli([filePath, "--monad", filePath, "Monad:MCreate:MRead:MNext"]).then(out => {
			assert.equal(out.status, 0, out.stderr)
			assert.match(out.stderr, /Found 0 errors\./)
		})
	})
})

test("cli renders primary and related snippets for repeated branch consumption", async () => {
	const source = `${monadModule}
type Pair<X, Y> = [X, Y]
type Bad<M extends Monad> = Pair<M, M>
`

	await withTempFile(source, filePath => {
		return captureCli([filePath, "--snippet-lines", "2:1", "--monad", filePath, "Monad:MCreate:MRead:MNext"]).then(
			out => {
				assert.equal(out.status, 1, out.stderr)
				assert.match(
					out.stderr,
					/Using monad M here is not allowed, because this evaluation path already consumed it earlier\./,
				)
				assert.match(out.stderr, /The same evaluation path already consumed M here/)
				assert.match(out.stderr, new RegExp(`${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`))
				assert.match(out.stderr, /\n\s*\|\s*~+/m)
				assert.match(out.stderr, /\nErrors  Files\n/)
				assert.match(
					out.stderr,
					new RegExp(`\\n\\s*\\d+\\s+${filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`),
				)
			},
		)
	})
})

test("cli --help prints usage and readme", async () => {
	const out = await captureCli(["--help"])
	assert.equal(out.status, 0, out.stderr)
	assert.match(out.stderr, /Usage: check-monad \[options\] <glob> \[glob\.\.\.\]/)
	assert.match(out.stderr, /# high-order-type-monad-checker/)
})
