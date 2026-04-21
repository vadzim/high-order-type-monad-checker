import "core-js"
import type { MonadViolationsOptions, MonadViolation, MonadTypeOption } from "./monadCheckerTypes.ts"
import { never } from "./utils.ts"
import type { ContentGraph } from "./buildContentGraph.ts"

// monadChecker responsibility boundary:
// - evaluate borrow rules over parseTypes output
// - emit violations only (no CLI/output formatting concerns)

export function getMonadViolations(graph: ContentGraph, options: MonadTypeOption): MonadViolation[] {
	const violations: MonadViolation[] = []

	const monadFile = new Map(
		graph.types
			.values()
			.filter(s => s.scope.path === options.path)
			.map(t => [t.name, t]),
	)

	const monadClass = monadFile.get(options.name) ?? never("Monad class not found")

	const monadConstructor = monadFile.get(options.constructorName) ?? never("Monad constructor not found")
	const monadReader = monadFile.get(options.readerName) ?? never("Monad reader not found")
	const monadConsumer = monadFile.get(options.consumerName) ?? never("Monad consumer not found")

	// monadClass can only be used in the right side of extends immediately
	// for (const call of monadClass.called) {
	// 	if (call.parent.type.name !== "extends") continue
	// 	const extendsCall = call.arguments[0]
	// 	if (extendsCall.type.name !== monadClass.name) continue
	// 	violations.push({
	// 		kind: "monad.invalidUsage",
	// 		message: "Monad class can only be used in the right side of extends immediately",
	// 	})
	// }

	throw new Error("Not implemented")
}
