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
	`// ok: producer returns tuple with monad in second slot
import { Monad } from "./api.ts";
type P<A extends Monad> = [1, A];
`,
	{
		source: `// fail: producer before extends must not be wrapped in [Producer<…>]; use Producer<…> extends …
import { Monad } from "./api.ts";
type Read<Msg extends string, T extends Monad> = [Msg, T];
type Parse<T extends Monad> = [Read<"x", T>] extends [
	infer Name extends string,
	infer Rest extends Monad,
]
	? [Name, Rest]
	: never;
`,
		expectedKinds: ["monad.invalidProducerInvocation"],
	},
	`// ok: producer before extends is bare Read<…>, not [Read<…>]
import { Monad } from "./api.ts";
type Read<Msg extends string, T extends Monad> = [Msg, T];
type Parse<T extends Monad> = Read<"x", T> extends [
	infer Name extends string,
	infer Rest extends Monad,
]
	? [Name, Rest]
	: never;
`,
	`// ok: tuple second slot may be a type alias to infer…extends monad-like (jsql EmptyTokenList-style)
import { Monad } from "./api.ts";
type StreamAlias = 1 extends infer R extends Monad ? R : never;
type P<A extends Monad> = [0, StreamAlias];
`,
	{
		test: "ok: forward-decl stream alias then imported tuple second (jsql sql-tokens order)",
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
export type P<A extends Monad> = [0, EmptyStream];
`,
			},
		],
	},
	{
		source: `// fail: monad value passed to Read's first generic (not Monad-bound), not invalidProducerReturn on [Name, Rest]
import { Monad } from "./api.ts";
type Read<Msg extends string, T extends Monad> = [Msg, T];
type Parse<T extends Monad> = [Read<T, "">] extends [
	infer Name extends string,
	infer Rest extends Monad,
]
	? [Name, Rest]
	: never;
`,
		expectedKinds: ["monad.monadArgRequiresMonadBoundParameter"],
	},
	{
		source: `// fail: monad value passed to not Monad-bound parameter, not invalidProducerReturn on [Name, Rest]
import { Monad } from "./api.ts";
type Read<Msg extends string, T> = [Msg, T];
type Parse<T extends Monad> = [Read<"", T>] extends [
	infer Name extends string,
	infer Rest extends Monad,
]
	? [Name, Rest]
	: never;
`,
		expectedKinds: ["monad.monadArgRequiresMonadBoundParameter"],
	},
	`// ok: monad-compatible generic parameter in last slot is allowed
import { Monad } from "./api.ts";
type P<X, A extends Monad> = [X, A];
`,
	`// fail: monad-compatible generic parameter in non-last slot is forbidden
import { Monad } from "./api.ts";
type P<A extends Monad, X> = [X, A];
`,
	`// ok: producer can return call to another producer
import { Monad } from "./api.ts";
type P<A extends Monad> = [1, A];
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
	`// fail: constructor type cannot return monad as tuple second element
import { Monad } from "./api.ts";
type Build = [1, Monad];
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
type P<A extends Monad> = 1 extends 2 ? [0, A] : [1, A];
`,
	},
	`// ok: paired private body not diagnosed; call to private producer counts as [result, monad-like] return
import { Monad, MonadPrivate } from "./api.ts";
type ViaPrivate<A extends Monad> = MonadPrivate<A>;
`,
	`// fail: producer declaration cannot return a conditional infer result
import { Monad } from "./api.ts";
type P<A extends Monad> = [1, A];
type R<A extends Monad> = P<A> extends [infer H, infer M extends Monad] ? M : never;
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
type P<A extends Monad> = [1, A, 3];
`,
	`// fail: producer call is forbidden inside generic argument
import { Monad } from "./api.ts";
type P<A extends Monad> = [1, A];
type Wrap<T> = [T];
type R<A extends Monad> = Wrap<P<A>>;
`,
	`// fail: producer call is forbidden inside tuple element
import { Monad } from "./api.ts";
type P<A extends Monad> = [1, A];
type R<A extends Monad> = [P<A>, A];
`,
	`// fail: producer call before extends must be destructured on right side
import { Monad } from "./api.ts";
type P<A extends Monad> = [1, A];
type R<A extends Monad> = P<A> extends Monad ? A : never;
`,
	`// fail: infer extends Monad must be in second slot
import { Monad } from "./api.ts";
type P<A extends Monad> = [1, A];
type R<A extends Monad> = P<A> extends [infer M extends Monad, infer H] ? M : never;
`,
	`// fail: infer in second slot must have extends Monad
import { Monad } from "./api.ts";
type P<A extends Monad> = [1, A];
type R<A extends Monad> = P<A> extends [infer H, infer M] ? M : never;
`,
	{
		test: "ok: cross-file producer chain is allowed",
		modules: [
			{
				file: "../samples/s1.ts",
				source: `
import { Monad } from "./api.ts";
export type P<A extends Monad> = [1, A];
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
