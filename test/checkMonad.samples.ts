import type { ViolationKind } from "../src/monadCheckerTypes.ts"

export type MonadSample =
	| `// ok: ${string}`
	| `// fail: ${string}`
	| {
			expectedKinds?: undefined
			file?: string
			source: `// ok: ${string}`
	  }
	| {
			expectedKinds?: ViolationKind[]
			file?: string
			source: `// fail: ${string}`
	  }
	| {
			expectedKinds?: ViolationKind[]
			test: `ok: ${string}` | `fail: ${string}`
			modules: {
				file: string
				source: string
			}[]
	  }

export const monadSamples: MonadSample[] = [
	`// ok: producer returns tuple with monad in first slot
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
`,
	`// ok: producer may return readonly tuple with monad-like first slot
import { Monad } from "./api.ts";
type P<A extends Monad> = readonly [A, 1];
`,
	`// ok: producer before extends may destructure readonly tuple on extends side
import { Monad } from "./api.ts";
type Read<T extends Monad, Msg extends string> = [T, Msg];
type Parse<T extends Monad> = Read<T, "x"> extends readonly [
	infer Rest extends Monad,
	infer Name extends string,
]
	? [Rest, Name]
	: never;
`,
	{
		source: `// fail: producer before extends must not be wrapped in [Producer<…>]; use Producer<…> extends …
import { Monad } from "./api.ts";
type Read<T extends Monad, Msg extends string> = [T, Msg];
type Parse<T extends Monad> = [Read<T, "x">] extends [
	infer Rest extends Monad,
	infer Name extends string,
]
	? [Rest, Name]
	: never;
`,
		expectedKinds: ["monad.invalidProducerInvocation"],
	},
	`// ok: producer before extends is bare Read<…>, not [Read<…>]
import { Monad } from "./api.ts";
type Read<T extends Monad, Msg extends string> = [T, Msg];
type Parse<T extends Monad> = Read<T, "x"> extends [
	infer Rest extends Monad,
	infer Name extends string,
]
	? [Rest, Name]
	: never;
`,
	`// ok: tuple first slot may be a type alias to infer…extends monad-like (jsql EmptyTokenList-style)
import { Monad } from "./api.ts";
type StreamAlias = 1 extends infer R extends Monad ? R : never;
type P<A extends Monad> = [StreamAlias, 0];
`,
	{
		test: "ok: forward-decl stream alias then imported tuple first (jsql sql-tokens order)",
		modules: [
			{
				file: "../samples/forward-stream.ts",
				source: `
import type { Monad } from "./api.ts";
export type EmptyStream = 1 extends infer R extends TokensStream ? R : never;
export type TokensStream = Monad;
`,
			},
			{
				file: "../samples/forward-use.ts",
				source: `
import type { EmptyStream } from "./forward-stream.ts";
import type { Monad } from "./api.ts";
export type P<A extends Monad> = [EmptyStream, 0];
`,
			},
		],
	},
	{
		source: `// fail: monad value passed to Read's second generic (not Monad-bound), not invalidProducerReturn on [Rest, Name]
import { Monad } from "./api.ts";
type Read<T extends Monad, Msg extends string> = [T, Msg];
type Parse<T extends Monad> = [Read<"x", T>] extends [
	infer Rest extends Monad,
	infer Name extends string,
]
	? [Rest, Name]
	: never;
`,
		expectedKinds: ["monad.monadArgRequiresMonadBoundParameter"],
	},
	{
		source: `// fail: monad value passed to not Monad-bound parameter, not invalidProducerReturn on [Rest, Name]
import { Monad } from "./api.ts";
type Read<Msg extends string, T> = [T, Msg];
type Parse<T extends Monad> = [Read<"", T>] extends [
	infer Rest extends Monad,
	infer Name extends string,
]
	? [Rest, Name]
	: never;
`,
		expectedKinds: ["monad.monadArgRequiresMonadBoundParameter"],
	},
	`// ok: monad-compatible generic parameter in first slot is allowed
import { Monad } from "./api.ts";
type P<A extends Monad, X> = [A, X];
`,
	`// fail: monad-compatible generic parameter in non-first slot is forbidden
import { Monad } from "./api.ts";
type P<X, A extends Monad> = [A, X];
`,
	`// ok: producer can return call to another producer
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A>;
`,
	`// ok: producer can return never
import { Monad } from "./api.ts";
type P<A extends Monad> = never;
`,
	`// ok: constructor type can return monad as single direct result
import { Monad } from "./api.ts";
type Build = Monad;
`,
	`// ok: generic declaration without monad input can return monad and becomes monad-compatible
import { Monad } from "./api.ts";
type Wrap<T> = Monad;
`,
	`// ok: declaration without monad input may return monad or never
import { Monad } from "./api.ts";
type X<T> = T extends 1 ? Monad : never;
`,
	{
		source: `// fail: declaration without monad input cannot mix monad and non-monad terminal returns
import { Monad } from "./api.ts";
type X<T> = T extends 1 ? Monad : 1;
`,
		expectedKinds: ["monad.inconsistentBranchReturn"],
	},
	`// fail: constructor type cannot return monad as tuple first element
import { Monad } from "./api.ts";
type Build = [Monad, 1];
`,
	{
		source: `// fail: monad variable cannot be used twice in the same scope
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, A];
`,
		expectedKinds: ["monad.consumeMultipleInPath"],
	},
	{
		source: `// fail: monad variable cannot be reused in child scope after parent usage
import { Monad } from "./api.ts";
type P<A extends Monad> = [A] extends [infer X] ? A : never;
`,
		expectedKinds: ["monad.consumeMultipleInPath"],
	},
	{
		source: `// ok: monad variable can be used in sibling conditional branches
import { Monad } from "./api.ts";
type P<A extends Monad> = 1 extends 2 ? [A, 0] : [A, 1];
`,
	},
	`// ok: paired private body not diagnosed; call to private producer counts as [monad-like, result] return
import { Monad, MonadPrivate } from "./api.ts";
type ViaPrivate<A extends Monad> = MonadPrivate<A>;
`,
	`// fail: producer declaration cannot return a conditional infer result
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends [infer M extends Monad, infer H] ? M : never;
`,
	`// fail: producer must not return bare monad type
import { Monad } from "./api.ts";
type P<A extends Monad> = A;
`,
	`// fail: producer must not return object wrapper
import { Monad } from "./api.ts";
type P<A extends Monad> = { a: A };
`,
	`// fail: producer must not return three-item tuple
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1, 3];
`,
	`// fail: producer call is forbidden inside generic argument
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type Wrap<T> = [T];
type R<A extends Monad> = Wrap<P<A>>;
`,
	`// fail: producer call is forbidden inside tuple element
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = [A, P<A>];
`,
	`// fail: producer call before extends must be destructured on right side
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends Monad ? A : never;
`,
	`// fail: infer extends Monad must be in first slot
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends [infer H, infer M extends Monad] ? M : never;
`,
	`// fail: infer in first slot must have extends Monad
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends [infer M, infer H] ? M : never;
`,
	{
		test: "ok: cross-file producer chain is allowed",
		modules: [
			{
				file: "../samples/s1.ts",
				source: `
import { Monad } from "./api.ts";
export type P<A extends Monad> = [A, 1];
`,
			},
			{
				file: "../samples/s2.ts",
				source: `
import { Monad } from "./api.ts";
import { P } from "./s1.ts";
type P2<A extends Monad> = P<A>;
`,
			},
		],
	},
	{
		test: "fail: cross-file callee is not producer",
		modules: [
			{
				file: "../samples/s1.ts",
				source: `
import { Monad } from "./api.ts";
export type P<A extends Monad> = A;
`,
			},
			{
				file: "../samples/s2.ts",
				source: `
import { Monad } from "./api.ts";
import { P } from "./s1.ts";
type P2<A extends Monad> = P<A>;
`,
			},
		],
	},
	`// fail: wrong usage of monad 1
import { Monad } from "./api.ts";
type R<A extends Monad> = \`\${A}\` extends infer U ? never : never;
`,
	`// fail: wrong usage of monad 2
import { Monad } from "./api.ts";
type R<A extends Monad> = A[1] extends infer U ? never : never;
`,
]
