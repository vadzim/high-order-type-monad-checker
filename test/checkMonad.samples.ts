import type { ViolationKind } from "../src/monadCheckerTypes.ts"

export type MonadSample = (
	| {
			name: `ok: ${string}`
			expectedKinds?: undefined
	  }
	| {
			name: `fail: ${string}`
			expectedKinds?: ViolationKind[]
	  }
) &
	(
		| {
				file?: string
				source: string
		  }
		| {
				modules: {
					file: string
					source: string
				}[]
		  }
	)

export const monadSamples: MonadSample[] = [
	{
		name: `ok: producer returns tuple with monad in first slot`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
`,
	},
	{
		name: `ok: producer may return readonly tuple with monad-like first slot`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = readonly [A, 1];
`,
	},
	{
		name: `ok: producer before extends may destructure readonly tuple on extends side`,
		source: `
import { Monad } from "./api.ts";
type Read<T extends Monad, Msg extends string> = [T, Msg];
type Parse<T extends Monad> = Read<T, "x"> extends readonly [
	infer Rest extends Monad,
	infer Name extends string,
]
	? [Rest, Name]
	: never;
`,
	},
	{
		name: `fail: producer before extends must not be wrapped in [Producer<…>]; use Producer<…> extends …`,
		source: `
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
	{
		name: `ok: producer before extends is bare Read<…>, not [Read<…>]`,
		source: `
import { Monad } from "./api.ts";
type Read<T extends Monad, Msg extends string> = [T, Msg];
type Parse<T extends Monad> = Read<T, "x"> extends [
	infer Rest extends Monad,
	infer Name extends string,
]
	? [Rest, Name]
	: never;
`,
	},
	{
		name: `ok: tuple first slot may be a type alias to infer…extends monad-like (jsql EmptyTokenList-style)`,
		source: `
import { Monad } from "./api.ts";
type StreamAlias = 1 extends infer R extends Monad ? R : never;
type P<A extends Monad> = [StreamAlias, 0];
`,
	},
	{
		name: "ok: forward-decl stream alias then imported tuple first (jsql sql-tokens order)",
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
		name: `fail: monad value passed to Read's second generic (not Monad-bound), not invalidProducerReturn on [Rest, Name]`,
		source: `
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
		name: `fail: monad value passed to not Monad-bound parameter, not invalidProducerReturn on [Rest, Name]`,
		source: `
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
	{
		name: `ok: monad-compatible generic parameter in first slot is allowed`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad, X> = [A, X];
`,
	},
	{
		name: `fail: monad-compatible generic parameter in non-first slot is forbidden`,
		source: `
import { Monad } from "./api.ts";
type P<X, A extends Monad> = [A, X];
`,
	},
	{
		name: `ok: producer can return call to another producer`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A>;
`,
	},
	{
		name: `ok: producer can return never`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = never;
`,
	},
	{
		name: `ok: constructor type can return monad as single direct result`,
		source: `
import { Monad } from "./api.ts";
type Build = Monad;
`,
	},
	{
		name: `ok: generic declaration without monad input can return monad and becomes monad-compatible`,
		source: `
import { Monad } from "./api.ts";
type Wrap<T> = Monad;
`,
	},
	{
		name: `ok: declaration without monad input may return monad or never`,
		source: `
import { Monad } from "./api.ts";
type X<T> = T extends 1 ? Monad : never;
`,
	},
	{
		name: `fail: declaration without monad input cannot mix monad and non-monad terminal returns`,
		source: `
import { Monad } from "./api.ts";
type X<T> = T extends 1 ? Monad : 1;
`,
		expectedKinds: ["monad.inconsistentBranchReturn"],
	},
	{
		name: `fail: constructor type cannot return monad as tuple first element`,
		source: `
import { Monad } from "./api.ts";
type Build = [Monad, 1];
`,
	},
	{
		name: `fail: monad variable cannot be used twice in the same scope`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, A];
`,
		expectedKinds: ["monad.consumeMultipleInPath"],
	},
	{
		name: `fail: monad variable cannot be reused in child scope after parent usage`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A] extends [infer X] ? A : never;
`,
		expectedKinds: ["monad.consumeMultipleInPath"],
	},
	{
		name: `ok: monad variable can be used in sibling conditional branches`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = 1 extends 2 ? [A, 0] : [A, 1];
`,
	},
	{
		name: `ok: paired private body not diagnosed; call to private producer counts as [monad-like, result] return`,
		source: `
import { Monad, MonadPrivate } from "./api.ts";
type ViaPrivate<A extends Monad> = MonadPrivate<A>;
`,
	},
	{
		name: `fail: producer declaration cannot return a conditional infer result`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends [infer M extends Monad, infer H] ? M : never;
`,
	},
	{
		name: `fail: producer must not return bare monad type`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = A;
`,
	},
	{
		name: `fail: producer must not return object wrapper`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = { a: A };
`,
	},
	{
		name: `fail: producer must not return three-item tuple`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1, 3];
`,
	},
	{
		name: `fail: producer call is forbidden inside generic argument`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type Wrap<T> = [T];
type R<A extends Monad> = Wrap<P<A>>;
`,
	},
	{
		name: `fail: producer call is forbidden inside tuple element`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = [A, P<A>];
`,
	},
	{
		name: `fail: producer call before extends must be destructured on right side`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends Monad ? A : never;
`,
	},
	{
		name: `fail: infer extends Monad must be in first slot`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends [infer H, infer M extends Monad] ? M : never;
`,
	},
	{
		name: `fail: infer in first slot must have extends Monad`,
		source: `
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends [infer M, infer H] ? M : never;
`,
	},
	{
		name: "ok: cross-file producer chain is allowed",
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
		name: "fail: cross-file callee is not producer",
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
	{
		name: `fail: wrong usage of monad 1`,
		source: `
import { Monad } from "./api.ts";
type R<A extends Monad> = \`\${A}\` extends infer U ? never : never;
`,
	},
	{
		name: `fail: wrong usage of monad 2`,
		source: `
import { Monad } from "./api.ts";
type R<A extends Monad> = A[1] extends infer U ? never : never;
`,
	},
]
