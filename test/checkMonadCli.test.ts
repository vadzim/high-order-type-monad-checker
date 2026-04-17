// import test from "node:test"
// import assert from "node:assert/strict"
// import { spawnSync } from "node:child_process"
// import { mkdtemp, rm, writeFile } from "node:fs/promises"
// import { tmpdir } from "node:os"
// import path from "node:path"

// async function withTempFile(source: string, fn: (filePath: string) => void | Promise<void>) {
// 	const dir = await mkdtemp(path.join(tmpdir(), "monad-checker-cli-"))
// 	const filePath = path.join(dir, "sample.ts")
// 	try {
// 		await writeFile(filePath, source, "utf8")
// 		await fn(filePath)
// 	} finally {
// 		await rm(dir, { recursive: true, force: true })
// 	}
// }

// function runCli(args: string[]) {
// 	return spawnSync(process.execPath, ["cli/check-monad.ts", ...args], {
// 		cwd: path.resolve(process.cwd()),
// 		encoding: "utf8",
// 	})
// }

// test("cli renders related snippets for each repeated-consume violation", async () => {
// 	const source = `
// type O = { __monad: "O" };
// type C<A extends O> = [A];
// type X<A extends O> = [C<A>, C<A>, C<A>];
// `
// 	await withTempFile(source, filePath => {
// 		const out = runCli(["--monad", filePath, "O", filePath])
// 		assert.equal(out.status, 1, out.stderr)

// 		const repeatedMessage = "consumed multiple times in one path."
// 		const repeatedCount = out.stderr.split(repeatedMessage).length - 1
// 		const firstUsageCount = out.stderr.split("first consumption occurs here:").length - 1
// 		assert.ok(repeatedCount >= 1, "Expected at least one repeated-consume diagnostic.")
// 		assert.equal(
// 			firstUsageCount,
// 			repeatedCount,
// 			"Each repeated-consume diagnostic should include a first-consumption snippet.",
// 		)

// 		// Ensure snippet markers are rendered for both primary and related snippets.
// 		assert.match(out.stderr, /\n\s*\|\s*~+/m)
// 		const cleanedupOutput = out.stderr.replaceAll(/\/tmp\/.*?(\w+?\.ts)/g, "$1")

// 		assert.equal(
// 			cleanedupOutput,
// 			`sample.ts:4:32 - Monad-bound variable 'A' consumed multiple times in one path.
//  1 |
//  2 | type O = { __monad: "O" };
//  3 | type C<A extends O> = [A];
//  4 | type X<A extends O> = [C<A>, C<A>, C<A>];
//    |                                ~

//     sample.ts:4:26 - first consumption occurs here:
//      1 |
//      2 | type O = { __monad: "O" };
//      3 | type C<A extends O> = [A];
//      4 | type X<A extends O> = [C<A>, C<A>, C<A>];
//        |                          ~

// sample.ts:4:38 - Monad-bound variable 'A' consumed multiple times in one path.
//  1 |
//  2 | type O = { __monad: "O" };
//  3 | type C<A extends O> = [A];
//  4 | type X<A extends O> = [C<A>, C<A>, C<A>];
//    |                                      ~

//     sample.ts:4:26 - first consumption occurs here:
//      1 |
//      2 | type O = { __monad: "O" };
//      3 | type C<A extends O> = [A];
//      4 | type X<A extends O> = [C<A>, C<A>, C<A>];
//        |                          ~

// Found 2 errors in 1 file.
// `,
// 		)
// 	})
// })

// test("cli exits 0 when no violations found", async () => {
// 	const source = `
// type O = { __monad: "O" };
// type R<A extends O> = A;
// type X<A extends O> = R<A>;
// `
// 	await withTempFile(source, filePath => {
// 		const out = runCli(["--monad", filePath, "O", filePath])
// 		assert.equal(out.status, 0, out.stderr)
// 		assert.equal(out.stderr.trim(), "Found 0 errors in 1 file.")
// 	})
// })

// test("cli renders related declaration snippet for invalid generic constraint", async () => {
// 	const source = `
// type O = { __monad: "O" };
// type G<A> = A;
// type X<A extends O> = G<A>;
// `
// 	await withTempFile(source, filePath => {
// 		const out = runCli(["--monad", filePath, "O", filePath])
// 		assert.equal(out.status, 1, out.stderr)
// 		assert.match(
// 			out.stderr,
// 			/Type 'A' is monad \('O'\), so generic 'G' must declare its 1st parameter as 'A extends O'\./,
// 		)
// 		assert.match(out.stderr, /\n\s+.*generic declaration:/)
// 		assert.match(out.stderr, /\n\s*\|\s*~+/m)
// 	})
// })
