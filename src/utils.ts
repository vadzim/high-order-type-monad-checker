import { inspect as nodeInspect } from "node:util"

export function never(message: string = "never"): never {
	throw new Error(message)
}

type InspectOptions = {
	colors?: boolean
}

type RefSite = {
	depth: number
	order: number
}

type InspectContext = {
	refIds: Map<object, number>
	isReferenced: Set<object>
	refSites: Map<object, RefSite>
	occurrences: Map<object, number>
	definedRefs: Set<object>
	nextRefId: number
	orderCounter: number
}

const INDENT = "  "
const ANSI_CYAN = "\u001b[36m"
const ANSI_RESET = "\u001b[39m"

function isInspectableObject(value: unknown): value is object {
	return typeof value === "object" && value !== null
}

function collectReferenceInfo(value: unknown, ctx: InspectContext, depth: number): void {
	collectReferenceInfoInner(value, ctx, depth, new Set<object>())
	for (const [obj, count] of ctx.occurrences) {
		if (count > 1) ctx.isReferenced.add(obj)
	}
}

function collectReferenceInfoInner(value: unknown, ctx: InspectContext, depth: number, expanded: Set<object>): void {
	if (!isInspectableObject(value)) return

	const count = (ctx.occurrences.get(value) ?? 0) + 1
	ctx.occurrences.set(value, count)
	const current = ctx.refSites.get(value)
	if (current === undefined) {
		ctx.refSites.set(value, { depth, order: ctx.orderCounter++ })
	} else {
		if (depth < current.depth || (depth === current.depth && current.order > ctx.orderCounter)) {
			ctx.refSites.set(value, { depth, order: ctx.orderCounter })
		}
		ctx.orderCounter++
	}
	if (count > 1 && !ctx.refIds.has(value)) ctx.refIds.set(value, ctx.nextRefId++)
	if (expanded.has(value)) return
	expanded.add(value)

	if (Array.isArray(value)) {
		for (const item of value) collectReferenceInfoInner(item, ctx, depth + 1, expanded)
		return
	}
	if (value instanceof Set) {
		for (const item of value) collectReferenceInfoInner(item, ctx, depth + 1, expanded)
		return
	}
	if (value instanceof Map) {
		for (const [key, mapValue] of value) {
			collectReferenceInfoInner(key, ctx, depth + 1, expanded)
			collectReferenceInfoInner(mapValue, ctx, depth + 1, expanded)
		}
		return
	}

	for (const key of Object.keys(value)) {
		collectReferenceInfoInner((value as Record<string, unknown>)[key], ctx, depth + 1, expanded)
	}
}

function stylizeRefToken(token: string, options: InspectOptions): string {
	return options.colors ? `${ANSI_CYAN}${token}${ANSI_RESET}` : token
}

function renderPrimitive(value: unknown, options: InspectOptions): string {
	return nodeInspect(value, {
		colors: options.colors ?? false,
		depth: 0,
		compact: true,
		breakLength: Infinity,
	})
}

function renderValue(value: unknown, ctx: InspectContext, depth: number, options: InspectOptions): string {
	if (!isInspectableObject(value)) return renderPrimitive(value, options)

	const refId = ctx.refIds.get(value)
	const isReferenced = ctx.isReferenced.has(value)
	const refSite = ctx.refSites.get(value)
	const shouldDefineHere =
		refId !== undefined &&
		isReferenced &&
		refSite !== undefined &&
		refSite.depth === depth &&
		!ctx.definedRefs.has(value)

	if (refId !== undefined && isReferenced && !shouldDefineHere) return stylizeRefToken(`<ref *${refId}>`, options)
	if (shouldDefineHere) ctx.definedRefs.add(value)

	if (Array.isArray(value)) {
		const body = renderArray(value, ctx, depth, options)
		return shouldDefineHere ? `${stylizeRefToken(`<ref *${refId}>`, options)} ${body}` : body
	}
	if (value instanceof Set) {
		const body = renderSet(value, ctx, depth, options)
		return shouldDefineHere ? `${stylizeRefToken(`<ref *${refId}>`, options)} ${body}` : body
	}
	if (value instanceof Map) {
		const body = renderMap(value, ctx, depth, options)
		return shouldDefineHere ? `${stylizeRefToken(`<ref *${refId}>`, options)} ${body}` : body
	}

	const body = renderObject(value as Record<string, unknown>, ctx, depth, options)
	return shouldDefineHere ? `${stylizeRefToken(`<ref *${refId}>`, options)} ${body}` : body
}

function renderArray(value: unknown[], ctx: InspectContext, depth: number, options: InspectOptions): string {
	if (value.length === 0) return "[]"
	const childDepth = depth + 1
	const indent = INDENT.repeat(childDepth)
	const closeIndent = INDENT.repeat(depth)
	const lines = value.map(item => `${indent}${renderValue(item, ctx, childDepth, options)},`)
	return `[\n${lines.join("\n")}\n${closeIndent}]`
}

function renderObject(
	value: Record<string, unknown>,
	ctx: InspectContext,
	depth: number,
	options: InspectOptions,
): string {
	const keys = Object.keys(value)
	if (keys.length === 0) return "{}"
	const childDepth = depth + 1
	const indent = INDENT.repeat(childDepth)
	const closeIndent = INDENT.repeat(depth)
	const lines = keys.map(key => `${indent}${key}: ${renderValue(value[key], ctx, childDepth, options)},`)
	return `{\n${lines.join("\n")}\n${closeIndent}}`
}

function renderSet(value: Set<unknown>, ctx: InspectContext, depth: number, options: InspectOptions): string {
	if (value.size === 0) return "Set(0) []"
	const childDepth = depth + 1
	const indent = INDENT.repeat(childDepth)
	const closeIndent = INDENT.repeat(depth)
	const lines = [...value].map(item => `${indent}${renderValue(item, ctx, childDepth, options)},`)
	return `Set(${value.size}) [\n${lines.join("\n")}\n${closeIndent}]`
}

function renderMap(value: Map<unknown, unknown>, ctx: InspectContext, depth: number, options: InspectOptions): string {
	if (value.size === 0) return "Map(0) {}"
	const childDepth = depth + 1
	const indent = INDENT.repeat(childDepth)
	const closeIndent = INDENT.repeat(depth)
	const lines = [...value].map(
		([key, mapValue]) =>
			`${indent}${renderValue(key, ctx, childDepth, options)} => ${renderValue(mapValue, ctx, childDepth, options)},`,
	)
	return `Map(${value.size}) {\n${lines.join("\n")}\n${closeIndent}}`
}

export function inspect(value: unknown, options: InspectOptions = {}): string {
	const ctx: InspectContext = {
		refIds: new Map<object, number>(),
		isReferenced: new Set<object>(),
		refSites: new Map<object, RefSite>(),
		occurrences: new Map<object, number>(),
		definedRefs: new Set<object>(),
		nextRefId: 1,
		orderCounter: 0,
	}

	collectReferenceInfo(value, ctx, 0)
	return renderValue(value, ctx, 0, options)
}

type SerializedNode =
	| { id: number; kind: "array"; value: unknown[] }
	| { id: number; kind: "object"; value: Record<string, unknown> }
	| { id: number; kind: "nullObject"; value: Record<string, unknown> }
	| { id: number; kind: "set"; value: Set<unknown> }
	| { id: number; kind: "map"; value: Map<unknown, unknown> }
	| { id: number; kind: "date"; value: Date }
	| { id: number; kind: "regexp"; value: RegExp }
	| { id: number; kind: "url"; value: URL }
	| { id: number; kind: "error"; value: Error; ctorName: string }
	| { id: number; kind: "arrayBuffer"; value: ArrayBuffer }
	| { id: number; kind: "dataView"; value: DataView; bufferId: number }
	| { id: number; kind: "typedArray"; value: Exclude<ArrayBufferView, DataView>; ctorName: string; bufferId: number }

type SerializeContext = {
	ids: Map<object, number>
	nodes: SerializedNode[]
}

function assertUnsupported(value: unknown, why: string): never {
	throw new Error(`Cannot serialize value: ${why}.`)
}

function isPlainObject(value: object): value is Record<string, unknown> {
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

function encodePrimitive(value: unknown): string {
	if (value === null) return "null"
	const kind = typeof value
	if (kind === "string") return JSON.stringify(value)
	if (kind === "boolean") return value ? "true" : "false"
	if (kind === "number") {
		if (Number.isNaN(value)) return "Number.NaN"
		if (value === Infinity) return "Infinity"
		if (value === -Infinity) return "-Infinity"
		if (Object.is(value, -0)) return "-0"
		return String(value)
	}
	if (kind === "undefined") return "undefined"
	if (kind === "bigint") return `${String(value)}n`
	if (kind === "symbol") {
		const key = Symbol.keyFor(value as symbol)
		if (key === undefined) assertUnsupported(value, "non-global symbol")
		return `Symbol.for(${JSON.stringify(key)})`
	}
	if (kind === "function") assertUnsupported(value, "functions/classes are not supported")
	assertUnsupported(value, `unsupported primitive type ${kind}`)
}

function encodePropertyKey(key: string | symbol): string {
	if (typeof key === "string") return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`
	const globalName = Symbol.keyFor(key)
	if (globalName === undefined) assertUnsupported(key, "non-global symbol property key")
	return `[Symbol.for(${JSON.stringify(globalName)})]`
}

function encodePropertyValue(value: unknown, ctx: SerializeContext): string {
	if (typeof value === "function") assertUnsupported(value, "functions/classes are not supported")
	if (typeof value === "object" && value !== null) return `v${visitNode(value, ctx)}`
	return encodePrimitive(value)
}

function visitNode(value: object, ctx: SerializeContext): number {
	const existing = ctx.ids.get(value)
	if (existing !== undefined) return existing
	const id = ctx.nodes.length
	ctx.ids.set(value, id)

	if (Array.isArray(value)) {
		ctx.nodes.push({ id, kind: "array", value })
		for (const item of value) {
			if (typeof item === "function") assertUnsupported(item, "functions/classes are not supported")
			if (typeof item === "object" && item !== null) visitNode(item, ctx)
		}
		return id
	}
	if (value instanceof Set) {
		ctx.nodes.push({ id, kind: "set", value })
		for (const item of value) {
			if (typeof item === "function") assertUnsupported(item, "functions/classes are not supported")
			if (typeof item === "object" && item !== null) visitNode(item, ctx)
		}
		return id
	}
	if (value instanceof Map) {
		ctx.nodes.push({ id, kind: "map", value })
		for (const [k, v] of value) {
			if (typeof k === "function") assertUnsupported(k, "functions/classes are not supported")
			if (typeof v === "function") assertUnsupported(v, "functions/classes are not supported")
			if (typeof k === "object" && k !== null) visitNode(k, ctx)
			if (typeof v === "object" && v !== null) visitNode(v, ctx)
		}
		return id
	}
	if (value instanceof Date) {
		ctx.nodes.push({ id, kind: "date", value })
		return id
	}
	if (value instanceof RegExp) {
		ctx.nodes.push({ id, kind: "regexp", value })
		return id
	}
	if (value instanceof URL) {
		ctx.nodes.push({ id, kind: "url", value })
		return id
	}
	if (value instanceof Error) {
		const ctorName = value.constructor?.name || "Error"
		ctx.nodes.push({ id, kind: "error", value, ctorName })
		return id
	}
	if (value instanceof ArrayBuffer) {
		ctx.nodes.push({ id, kind: "arrayBuffer", value })
		return id
	}
	if (value instanceof DataView) {
		ctx.nodes.push({ id, kind: "dataView", value, bufferId: visitNode(value.buffer, ctx) })
		return id
	}
	if (ArrayBuffer.isView(value)) {
		const ctorName = (value as Exclude<ArrayBufferView, DataView>).constructor?.name
		if (!ctorName) assertUnsupported(value, "unknown typed array constructor")
		ctx.nodes.push({
			id,
			kind: "typedArray",
			value: value as Exclude<ArrayBufferView, DataView>,
			ctorName,
			bufferId: visitNode(value.buffer, ctx),
		})
		return id
	}
	if (isPlainObject(value)) {
		ctx.nodes.push({
			id,
			kind: Object.getPrototypeOf(value) === null ? "nullObject" : "object",
			value: value as Record<string, unknown>,
		})
		for (const key of Reflect.ownKeys(value)) {
			const desc = Object.getOwnPropertyDescriptor(value, key)
			if (!desc?.enumerable) continue
			const propValue = (value as Record<string | symbol, unknown>)[key]
			if (typeof propValue === "function") assertUnsupported(propValue, "functions/classes are not supported")
			if (typeof propValue === "object" && propValue !== null) visitNode(propValue, ctx)
		}
		return id
	}
	assertUnsupported(
		value,
		`unsupported object type ${(value as { constructor?: { name?: string } }).constructor?.name ?? "unknown"}`,
	)
}

export function serialize(value: unknown): string {
	if (typeof value === "function") assertUnsupported(value, "functions/classes are not supported")
	if (typeof value !== "object" || value === null) return `(() => ${encodePrimitive(value)})()`

	const ctx: SerializeContext = { ids: new Map<object, number>(), nodes: [] }
	const rootId = visitNode(value, ctx)

	const initLines = ctx.nodes.map(node => {
		switch (node.kind) {
			case "array":
				return `const v${node.id} = []`
			case "object":
				return `const v${node.id} = {}`
			case "nullObject":
				return `const v${node.id} = Object.create(null)`
			case "set":
				return `const v${node.id} = new Set()`
			case "map":
				return `const v${node.id} = new Map()`
			case "date":
				return `const v${node.id} = new Date(${JSON.stringify(node.value.toISOString())})`
			case "regexp":
				return `const v${node.id} = new RegExp(${JSON.stringify(node.value.source)}, ${JSON.stringify(node.value.flags)})`
			case "url":
				return `const v${node.id} = new URL(${JSON.stringify(node.value.toString())})`
			case "error":
				return `const v${node.id} = new ${node.ctorName}(${JSON.stringify(node.value.message)})`
			case "arrayBuffer": {
				const bytes = [...new Uint8Array(node.value)].join(", ")
				return `const v${node.id} = new Uint8Array([${bytes}]).buffer`
			}
			case "dataView":
				return `const v${node.id} = new DataView(v${node.bufferId}, ${node.value.byteOffset}, ${node.value.byteLength})`
			case "typedArray":
				return `const v${node.id} = new ${node.ctorName}(v${node.bufferId}, ${node.value.byteOffset}, ${(node.value as unknown as { length: number }).length})`
		}
	})

	const assignLines: string[] = []
	for (const node of ctx.nodes) {
		switch (node.kind) {
			case "array":
				for (const item of node.value) assignLines.push(`v${node.id}.push(${encodePropertyValue(item, ctx)})`)
				break
			case "object":
			case "nullObject":
				for (const key of Reflect.ownKeys(node.value)) {
					const desc = Object.getOwnPropertyDescriptor(node.value, key)
					if (!desc?.enumerable) continue
					assignLines.push(
						`v${node.id}${encodePropertyKey(key)} = ${encodePropertyValue(node.value[key as keyof typeof node.value], ctx)}`,
					)
				}
				break
			case "set":
				for (const item of node.value) assignLines.push(`v${node.id}.add(${encodePropertyValue(item, ctx)})`)
				break
			case "map":
				for (const [k, v] of node.value) {
					assignLines.push(`v${node.id}.set(${encodePropertyValue(k, ctx)}, ${encodePropertyValue(v, ctx)})`)
				}
				break
			case "error":
				// Preserve enumerable custom fields and standard `cause` when present.
				for (const key of Reflect.ownKeys(node.value as unknown as object)) {
					if (key === "message" || key === "name") continue
					const desc = Object.getOwnPropertyDescriptor(node.value, key)
					if (!desc?.enumerable) continue
					assignLines.push(
						`v${node.id}${encodePropertyKey(key)} = ${encodePropertyValue((node.value as unknown as Record<string | symbol, unknown>)[key], ctx)}`,
					)
				}
				break
			case "date":
			case "regexp":
			case "url":
			case "arrayBuffer":
			case "dataView":
			case "typedArray":
				break
		}
	}

	return [
		"(() => {",
		...initLines.map(line => `  ${line}`),
		...assignLines.map(line => `  ${line}`),
		`  return v${rootId}`,
		"})()",
	].join("\n")
}
