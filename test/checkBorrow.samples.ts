import type { ViolationKind } from "../src/types.ts"

export type OpaqueSample =
	| `// ok: ${string}`
	| `// fail: ${string}`
	| {
			expectedKinds?: undefined
			source: `// ok: ${string}`
			file?: string
	  }
	| {
			expectedKinds?: ViolationKind[]
			source: `// fail: ${string}`
			file?: string
	  }

const baseSamples: OpaqueSample[] = [
	{
		source: `// ok: direct reader call is free
type O = { __opaque: "O" };
type Read<A extends O> = 1;
type X<A extends O> = Read<A>;`,
	},
	{
		source: `// ok: branch isolated consumption
type O = { __opaque: "O" };
type X<A extends O, F extends boolean> = F extends true ? A : A;`,
	},
	{
		source: `// ok: infer extends opaque itself
type O = { __opaque: "O" };
type X<T> = T extends infer A extends O ? A : never;`,
	},
	{
		source: `// ok: opaque argument passed to constrained parameter
type O = { __opaque: "O" };
type G<A extends O> = A;
type X<A extends O> = G<A>;`,
	},
	{
		source: `// ok: declaration with no ternary has one path
type O = { __opaque: "O" };
type X<A extends O> = [A];`,
	},
	{
		source: `// ok: nested readers remain non-consuming
type O = { __opaque: "O" };
type R0<A extends O> = 1;
type R1<A extends O> = R0<R0<A>>;
type X<A extends O> = R1<A>;`,
	},
	{
		expectedKinds: ["opaque.consumeMultipleInPath"],
		source: `// fail: double consume in one path
type O = { __opaque: "O" };
type C<A extends O> = [A];
type X<A extends O> = [C<A>, C<A>];`,
	},
	{
		source: `// ok: wrapped value in consumer is a regular consume
type O = { __opaque: "O" };
type R<A extends O> = A;
type X<A extends O> = R<[A]>;`,
	},
	{
		source: `// ok: consumer inside consumer argument is regular consume
type O = { __opaque: "O" };
type R<A extends O> = A;
type C<A extends O> = [A];
type X<A extends O> = R<C<A>>;`,
	},
	{
		expectedKinds: ["opaque.consumeMultipleInPath"],
		source: `// fail: opaque variable in conditional condition
type O = { __opaque: "O" };
type X<A extends O> = A extends string ? A : never;`,
	},
	{
		expectedKinds: ["opaque.invalidGenericArgumentConstraint"],
		source: `// fail: generic target parameter lacks opaque constraint
type O = { __opaque: "O" };
type G<A> = A;
type X<A extends O> = G<A>;`,
	},
	{
		source: `// ok: generated allowed reader path
type O = { __opaque: "O" };
type Read<A extends O> = 1;
type G1<A extends O> = Read<A>;
type X<A extends O, F extends boolean> = F extends true ? G1<A> : Read<A>;`,
	},
	{
		source: `// ok: 2 readers in one path
type O = { __opaque: "O" };
type Read<A extends O> = 1;
type G1<A extends O> = Read<A>;
type X<A extends O, F extends boolean> = [G1<A>, Read<A>];`,
	},
	{
		source: `// fail: 2 consumers in one path
type O = { __opaque: "O" };
type Read<A extends O> = A;
type G1<A extends O> = Read<A>;
type X<A extends O, F extends boolean> = [G1<A>, Read<A>];`,
	},
	{
		source: `// ok: 1 deep consumer in one path
type O = { __opaque: "O" };
type Read<A extends O> = A;
type G1<A extends O> = Read<A>;
type X<A extends O, F extends boolean> = [G1<A>];`,
	},
	{
		source: `// ok: same type as reader and consumer
type O = { __opaque: "O" };
type T1<A extends O, B extends O> = A;
type T2<A extends O, B extends O> = T1<A, B>;
type X<A extends O, C extends O, D extends O> =  [T2<C, A>, T2<D, A>];`,
	},
	{
		source: `// fail: same type as reader and consumer
type O = { __opaque: "O" };
type T1<A extends O, B extends O> = A;
type T2<A extends O, B extends O> = T1<A, B>;
type X<A extends O, C extends O, D extends O> =  [T2<A, C>, T2<A, D>];`,
	},
	{
		expectedKinds: ["opaque.invalidGenericArgumentConstraint"],
		source: `// fail: generated invalid opaque generic arg
type O = { __opaque: "O" };
type R<A extends O> = A;
type Bad2<A> = A;
type X<A extends O> = R<Bad2<A>>;`,
	},
	{
		expectedKinds: ["opaque.consumeMultipleInPath"],
		source: `// fail: alias that references opaque argument is consumer
type O = { __opaque: "O" };
type R<A extends O> = A;
type X<A extends O> = [R<A>, R<A>];`,
	},
	{
		source: `// ok: external reader
import { Read, Opaque } from "./api.ts";
type P1<A extends Opaque> = A;
type P2<A extends Opaque> =
	Read<A> extends ""
		? S<"">
		: Read<A> extends infer B extends Opaque
			? P1<B>
			: S<"">`,
	},
	{
		source: `// fail: external consumer
import { Consume, Opaque } from "./api.ts";
type P1<A extends Opaque> = A;
type P2<A extends Opaque> =
	Consume<A> extends ""
		? S<"">
		: Consume<A> extends infer B extends Opaque
			? P1<B>
			: S<"">`,
	},
	{
		source: `// ok: external renamed reader
import { Read as R1 } from "./api.ts";
type O = { __opaque: "O" };
type P1<A extends O> = A;
type P2<A extends O> =
	R1<A> extends ""
		? S<"">
		: R1<A> extends infer B extends string
			? P1<Action, A>
			: S<"">`,
	},
	{
		source: `// ok: external opaque type 1
import { Read, Opaque } from "./api.ts";
type X<T extends Opaque> =
	Read<T> extends "only" ? T : 1`,
	},
	{
		source: `// ok: external opaque type 2
import { Read, Opaque } from "./api.ts";
type X<T extends Opaque> =
	Lowercase<Read<T>> extends "only" ? T : 1`,
	},
	{
		source: `// fail: external opaque type 3
import { Read, Opaque } from "./api.ts";
type X<T extends Opaque> =
	Read<Lowercase<T>> extends "only" ? T : 1`,
	},
	{
		source: `// ok: external opaque type 4
import { Read, Consume, Opaque } from "./api.ts";
type X<T extends Opaque> =
	Lowercase<Read<T>> extends "only" ? Consume<T> : T`,
	},
	{
		source: `// ok: global consumer
import { Opaque } from "./api.ts";
type X<T extends Opaque> = Lowercase<T>;`,
	},
	{
		source: `// ok: global consumer 2
import { Opaque } from "./api.ts";
type A<T extends Opaque> =
	B<T, ""> extends [
		infer N extends string,
		infer R extends Opaque,
	]
		? [N, R]
		: never`,
	},
	{
		file: "../samples/api.ts",
		source: `// ok: file with opaque type, reader
type Opaque = [1]
type Read<A extends Opaque> = A
type Consume<A extends Opaque> = 1
type R2<A extends Opaque> = [Read<A>, Read<A>]`,
	},
	{
		file: "../samples/api.ts",
		source: `// fail: file with opaque type, consumer
type Opaque = [1]
type Read<A extends Opaque> = A
type Consume<A extends Opaque> = 1
type R2<A extends Opaque> = [Consume<A>, Consume<A>]`,
	},
	{
		file: "../samples/api.ts",
		source: `// fail: file with opaque type, reader 2
type Opaque = [1]
type Read2<A extends Opaque> = A
type R2<A extends Opaque> = [Read2<A>, Read2<A>]`,
	},
	{
		file: "../samples/api.ts",
		source: `// fail: file with opaque type, consumer 2
type Opaque = [1]
type Read<A extends Opaque> = A
type Consume2<A extends Opaque> = A
type R2<A extends Opaque> = [Consume2<A>, Consume2<A>]`,
	},
	{
		file: "../samples/api.ts",
		source: `// ok: file with opaque type 4
export type Opaque = Make<string, string, string>
export type Read<T extends Opaque> = T["a"]
export type Consume<T extends Opaque> = ParseSqlTokens<T["b"]>
type Make<A, B, C> = { a: A; b: B; c: C }
`,
	},
	{
		source: `// ok: reading & consuming
import { Read, Consume, Opaque } from "./api.ts";
type D<T extends Opaque> = Read<T> extends "" ? Consume<T> : D<Consume<T>>`,
	},
	{
		source: `// fail: consuming two times 1
import { Read, Consume, Opaque } from "./api.ts";
type D<T extends Opaque> = Read<T> extends "" ? Consume<T> : D<Consume<T>>
export type X<T extends Opaque> =[D<T>, D<T>]`,
	},
	{
		source: `// fail: consuming two times 2
import { Read, Consume, Opaque } from "./api.ts";
type C<A,B>=[A,B]
export type X<T extends Opaque> =
		C<readonly [T, T], []>`,
	},
	{
		source: `// fail: consuming two times 3
import { Read, Consume, Opaque } from "./api.ts";
export type X<T extends Opaque> = [T, T]`,
	},
	{
		source: `// fail: consuming two times 4
import { Read, Consume, Opaque } from "./api.ts";
export type X<T extends Consume<Opaque>> = [T, T]`,
	},
	{
		source: `// fail: consuming two times 4.1
import { Read, Consume, Opaque } from "./api.ts";
export type X<T extends Read<Opaque>> = [T, T]`,
	},
	{
		source: `// fail: consuming two times 5
import { Read, Consume, Opaque } from "./api.ts";
export type X<T extends [Opaque]> = [T[0], T[0]]`,
	},
	{
		source: `// fail: consuming two times 6
import { Read, Consume, Opaque } from "./api.ts";
export type X<A> = A extends [Opaque] ? [A[0], A[0]] : never`,
	},
	{
		source: `// fail: consuming two times 7
import { Read, Consume, Opaque } from "./api.ts";
export type X<A> = A extends [infer T extends Opaque] ? [T[0], T[0]] : never`,
	},
	{
		source: `// fail: consuming two times 8
import { Read, Consume, Opaque } from "./api.ts";
export type X<A> = A extends [infer T extends Opaque] ? [A[0], A[0]] : never`,
	},
	{
		source: `// fail: consuming two times 9
import { Read, Consume, Opaque } from "./api.ts";
export type X<A> = A extends [infer T extends Opaque] ? [A[0], T[0]] : never`,
	},
	{
		source: `// fail: consuming two times 10
import { Read, Consume, Opaque } from "./api.ts";
export type X<A, B> = [A, B] extends [infer S, infer T extends Opaque] ? [A[0], T[0]] : S`,
	},
	{
		source: `// fail: consuming two times 11
import { Read, Consume, Opaque } from "./api.ts";
export type X<A, B> = [A, B] extends [infer S, infer T extends Opaque] ? [B[0], T[0]] : S`,
	},
	{
		source: `// ok: consuming two times 12
import { Read, Consume, Opaque } from "./api.ts";
export type X<A, B> = [A, B] extends [infer S, infer T extends Opaque] ? [B[0], A[0]] : [T[0], S]`,
	},
	{
		source: `// fail: consuming two times 12.1
import { Read, Consume, Opaque } from "./api.ts";
export type X<A, B> = [A, B] extends [infer S extends D<Opaque>, infer T extends Opaque] ? [B[0], A[0]] : [T[0], S]`,
	},
	{
		source: `// ok: consuming two times 13
import { Read, Consume, Opaque } from "./api.ts";
export type X<A, B> = [A, B] extends [infer T extends Opaque, infer S] ? [B[0], A[0]] : S[0]`,
	},
	{
		source: `// ok: consuming two times 14
import { Read, Consume, Opaque } from "./api.ts";
export type X<A, B> = [A, B] extends [infer T extends Opaque, infer S] ? [B[0], S[0]] : 1`,
	},
	{
		source: `// ok: consuming two times 15
import { Read, Consume, Opaque } from "./api.ts";
export type X<A, B> = [A, B] extends [infer T extends Opaque, infer S] ? [A[0], S[0]] : 1`,
	},
	{
		source: `// ok: consuming two times 16
import { Read, Consume, Opaque } from "./api.ts";
export type X<A, B> = [A, B] extends [infer T extends Opaque, infer S] ? [T[0], S[0]] : 1`,
	},
	{
		source: `// fail: consuming two times 20
import { Read, Consume, Opaque } from "./api.ts";
type C<A,B>=[A,B]
type D<T extends Opaque> = Read<T> extends "" ? Consume<T> : D<Consume<T>>
export type X<T extends Opaque> =
	D<T> extends infer T2 extends Opaque
		? C<readonly [T2, T2], []>
		: never`,
	},
	{
		source: `// fail: consuming inferred
import { Read, Consume, Opaque } from "./api.ts";
export type X<T extends Opaque> =
	Read<T> extends "("
		? T["a"] extends infer R extends string
			? Y<ParseSqlTokens<R>, R, []>
			: never
		: X<Consume<T>>`,
	},
]

export const opaqueSamples: OpaqueSample[] = [...baseSamples]
