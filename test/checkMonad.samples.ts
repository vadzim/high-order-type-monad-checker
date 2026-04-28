export type MonadSample = { noAloneTest?: boolean } & (
	| {
			name: `ok: ${string}`
			expectedKinds?: undefined
	  }
	| {
			name: `fail: ${string}`
			expectedKinds?: string[]
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
		name: "ok: marker is used to declare first generic parameter",
		source: `type Ok<M extends Monad> = [M, 0];`,
	},
	{
		name: "fail: monad class marker cannot be used as value",
		source: `type Bad = [Monad, 1];`,
	},
	{
		name: "fail: only first generic parameter may be monad-marked",
		source: `type Bad<X, M extends Monad> = [M, X];`,
	},
	{
		name: "fail: monad marker cannot be used in generic default",
		source: `type Bad<T = Monad> = T;`,
		expectedKinds: ["monad.invalidTypeParameterDefault"],
	},
	{
		name: "fail: monad value type cannot be used in generic default",
		source: `type Bad<M extends Monad, T = M> = [M, 0];`,
		expectedKinds: ["monad.invalidTypeParameterDefault"],
	},
	{
		name: "fail: monad value type cannot be used in generic default as a subexpression",
		source: `type Bad<M extends Monad, T = M["m"]> = [M, 0];`,
		expectedKinds: ["monad.invalidTypeParameterDefault"],
	},
	{
		name: "fail: monad value can only be passed as first generic argument",
		source: `type Pair<X, Y> = [X, Y]; type Bad<M extends Monad> = Pair<1, M>;`,
	},
	{
		name: "ok: reader may consume monad multiple times",
		source: `type Ok<M extends Monad> = [M, [MRead<M>, MRead<M>]];`,
	},
	{
		name: "fail: same branch cannot consume monad twice outside reader",
		source: `type Pair<X, Y> = [X, Y]; type Bad<M extends Monad> = Pair<M, M>;`,
	},
	{
		name: "ok: sibling conditional branches may consume separately",
		source: `type Ok<M extends Monad> = 1 extends 2 ? [M, 0] : [M, 1];`,
	},
	{
		name: "fail: consumer must return consumer shape in all branches",
		source: `type Bad<M extends Monad> = 1 extends 2 ? [M, 0] : string;`,
	},
	{
		name: "ok: user consumer may return itself recursively when another branch returns tuple",
		source: `type Ok<M extends Monad, C extends 0 | 1 = 0> = C extends 0 ? [M, 0] : Ok<M, 0>;`,
	},
	{
		name: "fail: user consumers may not be just mutually recursive",
		source: `
type A<M extends Monad, C extends 0 | 1 = 0> = B<M, 0>;
type B<M extends Monad, C extends 0 | 1 = 0> = A<M, 0>;
`,
	},
	{
		name: "ok: user consumers may be mutually recursive if one branch returns tuple",
		source: `
type A<M extends Monad, C extends 0 | 1 = 0> = C extends 0 ? [M, 0] : B<M, 0>;
type B<M extends Monad, C extends 0 | 1 = 0> = C extends 0 ? [M, 0] : A<M, 0>;
`,
	},
	{
		name: "ok: user consumers may be mutually recursive if one branch returns another call",
		source: `
type A<M extends Monad, C extends 0 | 1 = 0> = C extends 0 ? MGet<M> : B<M, 0>;
type B<M extends Monad, C extends 0 | 1 = 0> = C extends 0 ? MGet<M> : A<M, 0>;
`,
		noAloneTest: true,
	},
	{
		name: "ok: user consumer may return itself recursively when another branch returns another call",
		source: `type G<M extends Monad> = [MNext<M>, MRead<M>]; type Ok<M extends Monad, C extends 0 | 1 = 0> = C extends 0 ? G<M> : Ok<M, 0>;`,
	},
	{
		name: "ok: user consumer may return itself recursively when another branch returns another call from another module",
		source: `type Ok<M extends Monad, C extends 0 | 1 = 0> = C extends 0 ? MGet<M> : Ok<M, 0>;`,
		noAloneTest: true,
	},
	{
		name: "ok: user consumer may return another call from another module",
		source: `type Ok<M extends Monad, C extends 0 | 1 = 0> = MGet<M>`,
		noAloneTest: true,
	},
	{
		name: "ok: user consumer may return another call",
		source: `type G<M extends Monad> = [MNext<M>, MRead<M>]; type Ok<M extends Monad, C extends 0 | 1 = 0> = G<M>`,
	},
	{
		name: "fail: user consumer should return proper tuple",
		source: `type G<M extends Monad> = [MRead<M>, MRead<M>]`,
	},
	{
		name: "fail: user consumer cannot return itself recursively without non-recursive non-never branch",
		source: `type Bad<M extends Monad> = 1 extends 2 ? never : Bad<M>;`,
	},
	{
		name: "fail: user type with monad input cannot return bare monad",
		source: `type Bad<M extends Monad> = MNext<M>;`,
	},
	{
		name: "fail: consumer call cannot be wrapped",
		source: `type Wrap<T> = T; type Bad<M extends Monad> = Wrap<MNext<M>>;`,
	},
	{
		name: "ok: configured consumer may be passed as first arg to monad-input type",
		source: `type Use<M extends Monad> = [M, 0]; type Ok<M extends Monad> = Use<MNext<MNext<M>>>;`,
	},
	{
		name: "ok: configured consumer may be returned as first item in a tuple",
		source: `type Ok<M extends Monad> = [MNext<MNext<M>>, 0];`,
	},
	{
		name: "fail: monad cannot be consumed twice in a tuple",
		source: `type Bad<M extends Monad> = [MNext<M>, MNext<M>];`,
	},
	{
		name: "fail: monad cannot be consumed twice in an object",
		source: `type Bad<M extends Monad> = { head: MNext<M>, tail: MNext<M> };`,
	},
	{
		name: "ok: monad can be consumed in a conditional infer constraint in a first arg of a tuple",
		source: `type Ok<M extends Monad> = [MNext<M>] extends [infer X extends Monad] ? [X, 1] : never;`,
	},
	{
		name: "fail: monad M cannot be consumed in a condition and in its true branch",
		source: `type Bad<M extends Monad> = [MNext<M>] extends [infer X extends Monad] ? [MNext<M>, 1] : never;`,
	},
	{
		name: "fail: monad M cannot be consumed in a condition and in its false branch",
		source: `type Bad<M extends Monad> = [MNext<M>] extends [infer X extends Monad] ? never : [MNext<M>, 1];`,
	},
	{
		name: "fail: consumer call with direct marker tuple rhs is not allowed",
		source: `type Bad<M extends Monad> = MNext<M> extends [Monad, infer R] ? never : never;`,
	},
	{
		name: "ok: consumer call may appear on left side of extends with infer constrained by marker",
		source: `type Ok<M extends Monad> = MNext<M> extends [infer N extends Monad, ...infer _] ? never : never;`,
	},
	{
		name: "ok: configured consumer call may use direct root infer-extends marker form",
		source: `type Ok<M extends Monad> = MNext<M> extends infer NextMonad extends Monad ? [NextMonad, 1] : never;`,
	},
	{
		name: "fail: consumer call on left side of extends needs tuple rhs or direct infer-extends marker rhs",
		source: `type Bad<M extends Monad> = MNext<M> extends Monad ? never : never;`,
	},
	{
		name: "fail: non-consumer left side cannot use direct infer-extends marker form",
		source: `type Wrap<T extends Monad> = [T, 1]; type Bad<M extends Monad> = Wrap<M> extends infer NextMonad extends Monad ? NextMonad : never;`,
		expectedKinds: ["monad.invalidProducerPattern"],
	},
	{
		name: "fail: direct infer-extends marker form forbids nested infer in generic wrappers",
		source: `type Wrap<T> = T; type Bad<M extends Monad> = MNext<M> extends Wrap<infer N> extends Monad ? N : never;`,
		expectedKinds: ["monad.invalidConsumerInvocation", "monad.invalidMarkerUsage"],
	},
	{
		name: "ok: monad M can be passed to argument of Monad type class",
		source: `type Wrap<T extends Monad> = [T, 1]; type Ok<M extends Monad> = Wrap<M> extends [infer N extends Monad, infer R] ? [N, R] : never;`,
	},
	{
		name: "fail: monad M should be passed only to argument of Monad type class",
		source: `type Wrap<T> = T; type Bad<M extends Monad> = Wrap<M> extends [infer N extends Monad, infer R] ? [N, R] : never;`,
	},
	{
		name: "fail: monad M should be passed only to argument of Monad type class (2)",
		source: `type Bad<M extends Monad> = Array<M> extends [infer N extends Monad, infer R] ? [N, R] : never;`,
	},
	{
		name: "fail: monad M should be passed only to argument of Monad type class (3)",
		source: `type Bad<M extends Monad> = M[1] extends [infer N extends Monad, infer R] ? [N, R] : never;`,
	},
	{
		name: "fail: monad M should be passed only to argument of Monad type class (4)",
		source: `type Bad<M extends Monad> = \`\${M}\` extends [infer N extends Monad, infer R] ? [N, R] : never;`,
	},
	{
		name: "ok: user producer call with extra args may be returned immediately by another producer",
		source: `type P<A extends Monad, Msg extends string> = [A, Msg]; type R<A extends Monad> = P<A, "x">;`,
	},
	{
		name: "ok: user producer call with extra args may be immediately destructured in conditional",
		source: `type P<A extends Monad, Msg extends string> = [A, Msg]; type R<A extends Monad> = P<A, "x"> extends [infer M2 extends Monad, infer R2] ? [M2, R2] : never;`,
	},
	{
		name: "fail: user producer call must not be used as generic argument",
		source: `type P<A extends Monad, Msg extends string> = [A, Msg]; type Wrap<T extends Monad> = [T, 0]; type Bad<A extends Monad> = Wrap<P<A, "x">>;`,
	},
	{
		name: "fail: user producer call in conditional must destructure first item as infer ... extends Monad",
		source: `type P<A extends Monad, Msg extends string> = [A, Msg]; type Bad<A extends Monad> = P<A, "x"> extends [infer M2, infer R2] ? [M2, R2] : never;`,
	},
	{
		name: "fail: user producer call in conditional must destructure monad in first slot",
		source: `type P<A extends Monad, Msg extends string> = [A, Msg]; type Bad<A extends Monad> = P<A, "x"> extends [infer R2, infer M2 extends Monad] ? [M2, R2] : never;`,
	},
	{
		name: "ok: user producer that returns another producer is still a user producer and may be returned immediately",
		source: `type P<A extends Monad> = [A, 1]; type Q<A extends Monad> = P<A>; type R<A extends Monad> = Q<A>;`,
	},
	{
		name: "fail: user producer that returns another producer keeps producer invocation restrictions",
		source: `type P<A extends Monad> = [A, 1]; type Q<A extends Monad> = P<A>; type Bad<A extends Monad> = [A, Q<A>];`,
	},
	{
		name: `ok: producer returns tuple with monad in first slot`,
		source: `
type P<A extends Monad> = [A, 1];
`,
	},
	{
		name: `ok: producer may return readonly tuple with monad-like first slot`,
		source: `
type P<A extends Monad> = readonly [A, 1];
`,
	},
	{
		name: `ok: producer before extends may destructure readonly tuple on extends side`,
		source: `
type Read<T extends Monad, Msg extends string> = [T, Msg];
type PParse<T extends Monad> = Read<T, "x"> extends readonly [
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
type Read<T extends Monad, Msg extends string> = [T, Msg];
type PParse<T extends Monad> = [Read<T, "x">] extends [
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
type Read<T extends Monad, Msg extends string> = [T, Msg];
type PParse<T extends Monad> = Read<T, "x"> extends [
	infer Rest extends Monad,
	infer Name extends string,
]
	? [Rest, Name]
	: never;
`,
	},
	{
		name: `fail: monad value passed to Read's second generic (not Monad-bound), not invalidProducerReturn on [Rest, Name]`,
		source: `
type Read<T extends Monad, Msg extends string> = [T, Msg];
type PParse<T extends Monad> = [Read<"x", T>] extends [
	infer Rest extends Monad,
	infer Name extends string,
]
	? [Rest, Name]
	: never;
`,
		expectedKinds: ["monad.invalidMonadUsageContext"],
	},
	{
		name: `fail: monad value passed to not Monad-bound parameter, not invalidProducerReturn on [Rest, Name]`,
		source: `
type Read<Msg extends string, T> = [T, Msg];
type PParse<T extends Monad> = [Read<"", T>] extends [
	infer Rest extends Monad,
	infer Name extends string,
]
	? [Rest, Name]
	: never;
`,
		expectedKinds: ["monad.invalidMonadUsageContext"],
	},
	{
		name: `ok: monad-compatible generic parameter in first slot is allowed`,
		source: `
type P<A extends Monad, X> = [A, X];
`,
	},
	{
		name: `fail: monad-compatible generic parameter in non-first slot is forbidden`,
		source: `
type P<X, A extends Monad> = [A, X];
`,
	},
	{
		name: `ok: producer can return call to another producer`,
		source: `
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A>;
`,
	},
	{
		name: `ok: producer can return never`,
		source: `
type P<A extends Monad> = never;
`,
	},
	{
		name: `ok: constructor type can return monad as single direct result`,
		source: `
type Build = Monad;
`,
	},
	{
		name: `ok: generic declaration without monad input can return monad and becomes monad-compatible`,
		source: `
type Wrap<T> = Monad;
`,
	},
	{
		name: `fail: declaration without monad input cannot mix monad and non-monad terminal returns`,
		source: `
type X<T> = T extends 1 ? Monad : 1;
`,
		expectedKinds: ["monad.invalidMarkerUsage"],
	},
	{
		name: `fail: constructor type cannot return monad as tuple first element`,
		source: `
type Build = [Monad, 1];
`,
	},
	{
		name: `fail: monad variable cannot be used twice in the same scope`,
		source: `
type P<A extends Monad> = [A, A];
`,
		expectedKinds: ["monad.multipleConsumption"],
	},
	{
		name: `fail: monad variable cannot be reused in child scope after parent usage`,
		source: `
type P<A extends Monad> = [A] extends [infer X] ? A : never;
`,
		expectedKinds: ["monad.multipleConsumption"],
	},
	{
		name: `ok: monad variable can be used in sibling conditional branches`,
		source: `
type P<A extends Monad> = 1 extends 2 ? [A, 0] : [A, 1];
`,
	},
	{
		name: `fail: producer declaration cannot return a conditional infer result`,
		source: `
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends [infer M extends Monad, infer H] ? M : never;
`,
	},
	{
		name: `fail: producer must not return bare monad type`,
		source: `
type P<A extends Monad> = A;
`,
	},
	{
		name: `fail: producer must not return object wrapper`,
		source: `
type P<A extends Monad> = { a: A };
`,
	},
	{
		name: `fail: producer must not return three-item tuple`,
		source: `
type P<A extends Monad> = [A, 1, 3];
`,
	},
	{
		name: `fail: producer call is forbidden inside generic argument`,
		source: `
type P<A extends Monad> = [A, 1];
type Wrap<T> = [T];
type R<A extends Monad> = Wrap<P<A>>;
`,
	},
	{
		name: `fail: producer call is forbidden inside tuple element`,
		source: `
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = [A, P<A>];
`,
	},
	{
		name: `fail: producer call before extends must be destructured on right side`,
		source: `
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends Monad ? A : never;
`,
	},
	{
		name: `fail: infer extends Monad must be in first slot`,
		source: `
type P<A extends Monad> = [A, 1];
type R<A extends Monad> = P<A> extends [infer H, infer M extends Monad] ? M : never;
`,
	},
	{
		name: `fail: infer in first slot must have extends Monad`,
		source: `
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
export type P<A extends Monad> = [A, 1];
`,
			},
			{
				file: "../samples/s2.ts",
				source: `
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
export type P<A extends Monad> = A;
`,
			},
			{
				file: "../samples/s2.ts",
				source: `
import { P } from "./s1.ts";
type P2<A extends Monad> = P<A>;
`,
			},
		],
	},
	{
		name: `fail: wrong usage of monad 1`,
		source: `
type R<A extends Monad> = \`\${A}\` extends infer U ? never : never;
`,
	},
	{
		name: `fail: wrong usage of monad 2`,
		source: `
type R<A extends Monad> = A[1] extends [infer U extends Monad] ? [U, 1] : never;
`,
	},
	{
		name: `fail: Monad inferred in conditional cannot be consumed wrongly`,
		source: `
type R<A extends Monad> = MGet<A> extends [infer R extends Monad, infer H] ? R[1] extends [infer U extends Monad] ? [U, 1] : never : never
`,
	},
	{
		name: `fail: Monad inferred in conditional cannot be consumed twice`,
		source: `
type R<A extends Monad> = MGet<A> extends [infer R extends Monad, infer H] ? [R, R] : never
`,
	},
]
