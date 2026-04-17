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

const baseSamples: MonadSample[] = [
	`// ok: type returns only monadic or never
import { Monad } from "./api.ts";
type Z = F extends Monad ? F : 1 extends 2 ? F : never;
`,
	`// fail: type mixes monadic and non-monadic terminal returns
import { Monad } from "./api.ts";
type Z = F extends Monad ? F : 1 extends 2 ? F : number;
`,
	`// fail: generic type mixes monadic and non-monadic return (param)
import { Monad } from "./api.ts";
type P<N extends number> = F extends Monad ? F : 1 extends 2 ? F : N;
`,
	`// fail: generic type mixes monadic and non-monadic return (tuple)
import { Monad } from "./api.ts";
type P<N extends number> = F extends Monad ? F : 1 extends 2 ? F : [];
`,
	`// fail: branches return different monad-compatible types
import { Monad } from "./api.ts";
type P<N extends number> = F extends Monad ? F : 1 extends 2 ? F : Monad;
`,
	`// fail: branch returns wrapped monadic value
import { Monad } from "./api.ts";
type P<N extends number> = F extends Monad ? F : 1 extends 2 ? F : [F];
`,
	`// fail: branch returns object-wrapped monadic value
import { Monad } from "./api.ts";
type P<N extends number> = F extends Monad ? F : 1 extends 2 ? F : { f: F };
`,
	`// fail: branch returns recursive non-direct type
import { Monad } from "./api.ts";
type P<N extends number> = F extends Monad ? F : 1 extends 2 ? F : P<1>;
`,
	`// fail: non-generic monadic alias cannot be mixed with non-monadic return
import { Monad } from "./api.ts";
type F = Monad
type P<N extends number> = 1 extends 2 ? F : 2;
`,
	`// fail: conditional alias resolving to monadic cannot be mixed
import { Monad } from "./api.ts";
type F = 2 extends number ? Monad : never
type P<N extends number> = 1 extends 2 ? F : 2;
`,
	`// ok: monad-compatible generic parameter is allowed only in last slot
import { Monad } from "./api.ts";
type P1<A extends Monad> = 1
type P2<X1, A extends Monad> = 1
type P2<X1, X2 extends number, A extends Monad> = 1
`,
	`// fail: monad-compatible generic parameter in non-last slot (simple)
import { Monad } from "./api.ts";
type P2<A extends Monad, X1> = 1
`,
	`// fail: monad-compatible generic parameter in non-last slot (mixed)
import { Monad } from "./api.ts";
type F = 2 extends number ? Monad : never
type P2<X2, A extends F, X1, X3 extends string> = 1
`,
	`// ok: monad-compatible infer allowed only as tuple[1] in 2-tuple
import { Monad } from "./api.ts";
type P<N extends number> = K<N> extends [infer H, infer R extends Monad] ? R : never;
`,
	`// fail: monad-compatible infer in tuple[0] is forbidden
import { Monad } from "./api.ts";
type P<N extends number> = K<N> extends [infer H extends Monad, infer R] ? R : never;
`,
	`// fail: top-level monad-compatible infer is forbidden
import { Monad } from "./api.ts";
type P<N extends number> = K<N> extends infer R extends Monad ? R : never;
`,
	`// fail: monad-compatible infer in 3-tuple is forbidden
import { Monad } from "./api.ts";
type P<N extends number> = K<N> extends [infer H, infer R extends Monad, infer S] ? R : never;
`,
	`// fail: monad-compatible infer inside object pattern is forbidden
import { Monad } from "./api.ts";
type P<N extends number> = K<N> extends { r: infer R extends Monad } ? R : never;
`,
	`// fail: monad-compatible infer inside generic argument is forbidden
import { Monad } from "./api.ts";
type P<N extends number> = K<N> extends X<infer R extends Monad> ? R : never;
`,
	`// fail: monad-compatible infer in nested tuple is forbidden
import { Monad } from "./api.ts";
type P<N extends number> = K<N> extends [[infer H, infer R extends Monad]] ? R : never;
`,
	`// fail: monad-compatible infer in deep nested tuple is forbidden
import { Monad } from "./api.ts";
type P<N extends number> = K<N> extends [infer U, [infer H, infer R extends Monad]] ? R : never;
`,
	`// ok: monad-compatible type can only be used as the last parameter to a generic type or as the 2nd element in a 2-tuple as returned value
import { Monad } from "./api.ts";
type P<A extends Monad> = 1 extends number ? G<3, A> : [4, A];
`,
	`// fail: monad-compatible type can only be used as the last parameter to a generic type or as the 2nd element in a 2-tuple as returned value
import { Monad } from "./api.ts";
type P<A extends Monad> = 1 extends number ? G<3, [4, A]> : [4, A];
`,
	`// fail: monad-compatible type can only be used as the last parameter to a generic type or as the 2nd element in a 2-tuple as returned value
import { Monad } from "./api.ts";
type P<A extends Monad> = 1 extends A ? G<3, 3> : [4, 4];
`,
	`// fail: monad-compatible type can only be used as the last parameter to a generic type or as the 2nd element in a 2-tuple as returned value
import { Monad } from "./api.ts";
type P<A extends Monad> = A extends 1 ? G<3, 3> : [4, 4];
`,
	`// fail: monad-compatible type can only be used as the last parameter to a generic type or as the 2nd element in a 2-tuple as returned value
import { Monad } from "./api.ts";
type P<A extends Monad> = 1 extends number ? [A, 4] : [4, A];
`,
	`// fail: monad-compatible type can only be used as the last parameter to a generic type or as the 2nd element in a 2-tuple as returned value
import { Monad } from "./api.ts";
type P<A extends Monad> = { a: A };
`,
	{
		test: "ok: monadic type can be used only at the argument of monadic type",
		modules: [
			{
				file: "../samples/s1.ts",
				source: `
import { Monad } from "./api.ts";
export type P<X, Y, A extends Monad> = [1, A];
`,
			},
			{
				file: "../samples/s2.ts",
				source: `
import { Monad } from "./api.ts";
import { P } from "./s1.ts";
type P2<A extends Monad> = P<1, 2, A>;
`,
			},
		],
	},
	{
		test: "fail: monadic type cannot be used at the argument of 'unknown' type",
		modules: [
			{
				file: "../samples/s1.ts",
				source: `
import { Monad } from "./api.ts";
export type P<X, Y, A extends unknown> = [1, A];
`,
			},
			{
				file: "../samples/s2.ts",
				source: `
import { Monad } from "./api.ts";
import { P } from "./s1.ts";
type P2<A extends Monad> = P<1, 2, A>;
`,
			},
		],
	},
	{
		test: "fail: monadic type cannot be used at the argument of non-monadic type",
		modules: [
			{
				file: "../samples/s1.ts",
				source: `
import { Monad } from "./api.ts";
export type P<X, Y, A extends [Monad]> = [1, A];
`,
			},
			{
				file: "../samples/s2.ts",
				source: `
import { Monad } from "./api.ts";
import { P } from "./s1.ts";
type P2<A extends Monad> = P<1, 2, A>;
`,
			},
		],
	},
	{
		test: "fail: monadic type cannot be used at the argument without type",
		modules: [
			{
				file: "../samples/s1.ts",
				source: `
import { Monad } from "./api.ts";
export type P<X, Y, A> = [1, A];
`,
			},
			{
				file: "../samples/s2.ts",
				source: `
import { Monad } from "./api.ts";
import { P } from "./s1.ts";
type P2<A extends Monad> = P<1, 2, A>;
`,
			},
		],
	},
	`// ok: monad-compatible type variable can be used twice in different branches of the same scope
import { Monad } from "./api.ts";
type P<A extends Monad> = 1 extends 2 ? A : [A];
`,
	`// ok: monad-compatible type variable can be used twice in different branches of the same scope 2
import { Monad } from "./api.ts";
type P<A extends Monad> = [A] extends 2 ? 1 : 2;
`,
	`// ok: different monad-compatible type variable can be used twice in the same scope
import { Monad } from "./api.ts";
type P<A extends Monad> = B extends Monad ? [A, B] extends 2 ? 1 : 2 : 3;
`,
	`// fail: monad-compatible type variable cannot be used twice in the same scope
import { Monad } from "./api.ts";
type P<A extends Monad> = 1 extends 2 ? A : [A, [A]];
`,
	`// fail: monad-compatible type variable cannot be used twice in the same scope 2
import { Monad } from "./api.ts";
type P<A extends Monad> = [A, A] extends 2 ? 1 : 2;
`,
	`// fail: monad-compatible type variable cannot be used again once it was used in an ascedent scope
import { Monad } from "./api.ts";
type P<A extends Monad> = [A] extends 2 ? A : 2;
`,
	// 	`// ok: monadic type is returned by a generic type which does not accept other monadic types in its parameter list
	// import { Monad } from "./api.ts";
	// type P<N extends number> = F extends Monad ? F : never;
	// `,
]

export const monadSamples: MonadSample[] = [...baseSamples]
