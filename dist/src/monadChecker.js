import "core-js";
import { never } from "./utils.js";
export function getMonadViolations(graph, options) {
    const violations = [];
    const settingsPath = normalizeTypePath(options.path);
    const monadInfo = new Map(graph.types
        .values()
        .filter(t => normalizeTypePath(t.scope.path) === settingsPath && t.kind === "typeAlias")
        .map(t => [t.name, t]));
    const monadClass = monadInfo.get(options.name);
    const monadConstructor = monadInfo.get(options.constructorName);
    const monadReader = monadInfo.get(options.readerName);
    const monadConsumer = monadInfo.get(options.consumerName);
    if (options.strictMonadModule) {
        if (!monadClass?.declaration ||
            !monadConstructor?.declaration ||
            !monadReader?.declaration ||
            !monadConsumer?.declaration)
            never();
    }
    if (!monadClass)
        return [];
    const monadClassName = monadClass.name;
    function related(...items) {
        const normalized = items.flatMap(item => item?.position && item.path ? [{ message: item.message, position: item.position, path: item.path }] : []);
        return normalized.length > 0 ? normalized : undefined;
    }
    function findMonadConstraintFor(typeRef) {
        const declarationCall = typeRef.declaration;
        const declarationRoot = declarationCall?.parent;
        const extendsCall = declarationRoot?.parent;
        const constraintTarget = extendsCall?.arguments[1];
        if (!constraintTarget || constraintTarget.type.ref !== monadClass)
            return { decl: null, constraint: null };
        if (declarationCall?.position && declarationCall.scope.path) {
            return {
                decl: {
                    message: `${typeRef.name} is declared here`,
                    position: declarationCall.position,
                    path: declarationCall.scope.path,
                },
                constraint: {
                    message: `${typeRef.name} is constrained by ${monadClass.name} here`,
                    position: constraintTarget.position,
                    path: constraintTarget.scope.path,
                },
            };
        }
        return {
            decl: null,
            constraint: {
                message: `${typeRef.name} is constrained by ${monadClass.name} here`,
                position: constraintTarget.position,
                path: constraintTarget.scope.path,
            },
        };
    }
    const callToOwner = new Map(graph.types.values().flatMap(type => allCallsForType(type).map(call => [call, type])));
    const monadValueTypes = new Set();
    if (monadConsumer && !monadConsumer.declaration) {
        monadValueTypes.add(monadConsumer);
    }
    if (monadConstructor && !monadConstructor.declaration) {
        monadValueTypes.add(monadConstructor);
    }
    for (const type of graph.types) {
        for (const [index, arg] of type.arguments.entries()) {
            if (arg.extends?.type.ref !== monadClass)
                continue;
            if (index !== 0) {
                violations.push({
                    owner: type,
                    violation: {
                        kind: "monad.invalidTypeParameterOrder",
                        message: `Using ${arg.variable.name} here as a monad-marked type parameter is not allowed, because only the first generic parameter may extend ${monadClass.name}`,
                        position: arg.variable.position,
                        path: arg.variable.scope.path,
                        related: related({
                            message: type.arguments[0]
                                ? `Only the first generic parameter may extend ${monadClass.name}`
                                : undefined,
                            position: type.arguments[0]?.variable.position,
                            path: type.arguments[0]?.variable.scope.path,
                        }),
                    },
                });
            }
            monadValueTypes.add(arg.variable.ref);
        }
    }
    for (const call of usages(monadClass)) {
        if (!isAllowedMonadClassMarkerUse(call)) {
            violations.push({
                owner: callToOwner.get(call) ?? null,
                violation: {
                    kind: "monad.invalidMarkerUsage",
                    message: `Using ${call.type.name} here is not allowed, because ${call.type.name} is only a marker type. It may be used only as an extends-constraint target (for example, T extends ${call.type.name}, including [infer T extends ${call.type.name}, ...]) and not as a standalone value type`,
                    position: call.position,
                    path: call.scope.path,
                    related: related({
                        message: `${monadClass.name} marker declaration is here`,
                        position: monadClass.position,
                        path: monadClass.scope.path,
                    }),
                },
            });
            continue;
        }
        if (call.parent?.type.name === "<extends>" && call.parent.arguments[1] === call) {
            monadValueTypes.add(call.parent.arguments[0].arguments[0].type.ref);
        }
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const type of graph.types) {
            if (type.kind !== "typeAlias" || monadValueTypes.has(type))
                continue;
            const branches = terminalReturns(type);
            if (branches.length === 0)
                continue;
            if (branches.every(call => call.type.name === "never" || monadValueTypes.has(call.type.ref))) {
                monadValueTypes.add(type);
                changed = true;
            }
        }
    }
    for (const type of graph.types) {
        for (const arg of type.arguments) {
            const defaultCall = arg.default;
            if (!defaultCall)
                continue;
            const badDefaultUse = Array.from(allCalls(defaultCall)).find(call => call.type.ref === monadClass || monadValueTypes.has(call.type.ref));
            if (!badDefaultUse)
                continue;
            const monadConstraint = findMonadConstraintFor(badDefaultUse.type.ref);
            violations.push({
                owner: type,
                violation: {
                    kind: "monad.invalidTypeParameterDefault",
                    message: `Using ${badDefaultUse.type.name} in a type parameter default is not allowed, because monad marker and monad value types cannot appear in generic defaults`,
                    position: badDefaultUse.position,
                    path: badDefaultUse.scope.path,
                    related: related({
                        message: "Type parameter declaration is here",
                        position: arg.variable.position,
                        path: arg.variable.scope.path,
                    }, monadConstraint.constraint),
                },
            });
        }
    }
    const consumerTypes = new Set();
    if (monadConsumer)
        consumerTypes.add(monadConsumer);
    const userMonadInputTypes = new Set(Array.from(graph.types).filter(type => type.kind === "typeAlias" && type !== monadConsumer && type !== monadReader && hasMonadInput(type)));
    const tupleReturnTypes = new Set();
    const typeAliases = new Set(Array.from(graph.types).filter(type => type.kind === "typeAlias"));
    const terminalReturnsByType = new Map(Array.from(typeAliases).map(type => [type, terminalReturns(type)]));
    const recursionComponents = [];
    const seenRecursionSets = new Set();
    for (const type of typeAliases) {
        const recursion = type.recursion;
        if (!recursion || seenRecursionSets.has(recursion))
            continue;
        seenRecursionSets.add(recursion);
        const component = new Set(Array.from(recursion).filter(member => typeAliases.has(member)));
        if (component.size > 0)
            recursionComponents.push(component);
    }
    for (const type of typeAliases) {
        if (recursionComponents.some(component => component.has(type)))
            continue;
        recursionComponents.push(new Set([type]));
    }
    changed = true;
    while (changed) {
        changed = false;
        for (const componentSet of recursionComponents) {
            if (Array.from(componentSet).every(type => tupleReturnTypes.has(type)))
                continue;
            if (Array.from(componentSet).some(type => terminalReturnsByType.get(type).length === 0))
                continue;
            const recursiveComponent = componentSet.size > 1 || Array.from(componentSet).some(type => type.recursion?.has(type) === true);
            const allBranchesAllowed = Array.from(componentSet).every(type => terminalReturnsByType
                .get(type)
                .every(branch => isAllowedConsumerBranchInComponent(branch, componentSet)));
            if (!allBranchesAllowed)
                continue;
            if (recursiveComponent && !hasNonRecursiveReturn(componentSet))
                continue;
            for (const type of componentSet) {
                if (tupleReturnTypes.has(type))
                    continue;
                tupleReturnTypes.add(type);
                changed = true;
            }
        }
    }
    for (const consumerType of userMonadInputTypes) {
        const branches = terminalReturns(consumerType);
        const monadInputArg = consumerType.arguments.find(arg => arg.extends?.type.ref === monadClass) ?? null;
        for (const branch of branches) {
            if (isAllowedConsumerBranch(branch))
                continue;
            const sourceReturn = body(branch.type.ref);
            const sourceRelated = sourceReturn && branch.type.ref !== consumerType
                ? {
                    message: `${branch.type.name} return source is here`,
                    position: sourceReturn.position,
                    path: sourceReturn.scope.path,
                }
                : null;
            violations.push({
                owner: consumerType,
                violation: {
                    kind: "monad.incompatibleTypes",
                    message: branches.length > 1
                        ? `This branch of ${consumerType.name} is not allowed, because a user type that accepts monad input must return a tuple (length >= 2) with monad in the first slot, or never, in every branch`
                        : `Return type of ${consumerType.name} is not allowed, because a user type that accepts monad input must return a tuple (length >= 2) with monad in the first slot, or never`,
                    position: branch.position,
                    path: branch.scope.path,
                    related: related({
                        message: `${consumerType.name} accepts monad input via this constraint`,
                        position: monadInputArg?.extends?.position ?? consumerType.position,
                        path: monadInputArg?.extends?.scope.path ?? consumerType.scope.path,
                    }, sourceRelated),
                },
            });
        }
    }
    for (const consumerType of consumerTypes) {
        for (const call of usages(consumerType)) {
            if (isAllowedConsumerInvocation(call))
                continue;
            violations.push({
                owner: callToOwner.get(call) ?? consumerType,
                violation: {
                    kind: "monad.invalidConsumerInvocation",
                    message: `Using consumer ${consumerType.name} here is not allowed. It must be either in terminal return position of another consumer, or as the immediate left side of extends with either (a) a tuple pattern on the right side like [infer ... extends ${monadClass.name}, result], or (b) infer ... extends ${monadClass.name} (configured primitive consumer only)`,
                    position: call.position,
                    path: call.scope.path,
                    related: related({
                        message: `${consumerType.name} is declared here`,
                        position: consumerType.position,
                        path: consumerType.scope.path,
                    }),
                },
            });
        }
    }
    const userProducerTypes = new Set(Array.from(userMonadInputTypes).filter(type => tupleReturnTypes.has(type)));
    for (const producerType of userProducerTypes) {
        for (const call of usages(producerType)) {
            if (isProducerConditionalPatternError(call)) {
                const wrongPattern = call.parent?.arguments[1];
                violations.push({
                    owner: callToOwner.get(call) ?? producerType,
                    violation: {
                        kind: "monad.invalidProducerPattern",
                        message: `Using producer ${producerType.name} here is not allowed, because conditional destructuring must use a right-side tuple pattern like [infer M2 extends ${monadClass.name}, infer R2]`,
                        position: call.position,
                        path: call.scope.path,
                        related: related({
                            message: `${producerType.name} is declared here`,
                            position: producerType.position,
                            path: producerType.scope.path,
                        }, {
                            message: "Wrong destructuring pattern is here",
                            position: wrongPattern?.position,
                            path: wrongPattern?.scope.path,
                        }),
                    },
                });
                continue;
            }
            if (isAllowedUserProducerInvocation(call))
                continue;
            violations.push({
                owner: callToOwner.get(call) ?? producerType,
                violation: {
                    kind: "monad.invalidProducerInvocation",
                    message: `Using producer ${producerType.name} here is not allowed. A user producer call must be either in immediate terminal return position of another user producer, or as the immediate left side of conditional extends with a tuple pattern like [infer M2 extends ${monadClass.name}, infer R2]`,
                    position: call.position,
                    path: call.scope.path,
                    related: related(...invalidProducerInvocationRelated(call, producerType)),
                },
            });
        }
    }
    for (const monadType of monadValueTypes) {
        for (const call of usages(monadType)) {
            if (isIgnoredMonadUsage(call))
                continue;
            if (!isMonadArgumentUsage(call))
                continue;
            if (isAllowedTupleConsumerResultPosition(call))
                continue;
            const parent = call.parent;
            if (!parent)
                continue;
            if (parent.arguments[0] !== call || !hasMonadInput(parent.type.ref)) {
                const calleeType = parent.type.ref;
                const firstArg = calleeType.arguments[0];
                let relatedMessage = parent.arguments[0] !== call
                    ? "The first argument slot is here"
                    : firstArg
                        ? `${calleeType.name}'s first generic parameter is declared here`
                        : undefined;
                let relatedPosition = parent.arguments[0] !== call ? parent.arguments[0]?.position : firstArg?.variable.position;
                let relatedPath = parent.arguments[0] !== call ? parent.arguments[0]?.scope.path : firstArg?.variable.scope.path;
                const monadConstraint = findMonadConstraintFor(call.type.ref);
                violations.push({
                    owner: callToOwner.get(call) ?? null,
                    violation: {
                        kind: monadArgumentUsageKind(parent),
                        message: monadUsageErrorMessage(call, parent),
                        position: call.position,
                        path: call.scope.path,
                        related: related({
                            message: relatedMessage,
                            position: relatedPosition,
                            path: relatedPath,
                        }, monadConstraint.constraint),
                    },
                });
            }
        }
    }
    for (const monadType of monadValueTypes) {
        const seenInBranch = [];
        const calls = Array.from(usages(monadType)).sort(compareCalls);
        for (const call of calls) {
            if (isIgnoredMonadUsage(call))
                continue;
            const previous = seenInBranch.find(prev => prev.type.ref === call.type.ref &&
                (scopeContains(prev.scope, call.scope) || sharesConditionalConditionPath(prev, call)));
            if (previous) {
                const monadConstraint = findMonadConstraintFor(call.type.ref);
                violations.push({
                    owner: callToOwner.get(call) ?? null,
                    violation: {
                        kind: "monad.multipleConsumption",
                        message: `Using monad ${call.type.name} here is not allowed, because this evaluation path already consumed it earlier. Only ${options.readerName} may read the same monad multiple times`,
                        position: call.position,
                        path: call.scope.path,
                        related: related({
                            message: `The same evaluation path already consumed ${call.type.name} here`,
                            position: previous.position,
                            path: previous.scope.path,
                        }, monadConstraint.constraint),
                    },
                });
                continue;
            }
            seenInBranch.push(call);
        }
    }
    // Check conditional patterns for type assignments and monad-related conditionals
    for (const type of graph.types) {
        if (type.kind !== "typeAlias")
            continue;
        // Skip checking the monad module types themselves (constructor, reader, consumer)
        if (type === monadConstructor || type === monadReader || type === monadConsumer)
            continue;
        // Only check top-level conditionals in the type body, not nested ones
        const typeBody = body(type);
        if (!typeBody || typeBody.type.name !== "<conditional>")
            continue;
        const conditional = typeBody;
        const extendsCall = conditional.arguments[0];
        const trueRoot = conditional.arguments[1];
        const falseRoot = conditional.arguments[2];
        if (!extendsCall || !trueRoot || !falseRoot)
            continue;
        // Check if this is a type assignment pattern: ... extends infer X ? ... : ...
        const isTypeAssignment = isSimpleInferPattern(extendsCall);
        // Check if this is pattern matching (infer with constraints)
        const isPatternMatching = isPatternMatchingConditional(extendsCall);
        // Check if this conditional is monad-related (only check the type being validated, not nested types)
        const isMonadRelated = hasMonadInput(type);
        if (isTypeAssignment && !isMonadRelated) {
            // Pattern: ... extends infer X ? ... : never
            // Else branch must be "never"
            if (falseRoot.type.name !== "never") {
                violations.push({
                    owner: callToOwner.get(conditional) ?? type,
                    violation: {
                        kind: "conditional.typeAssignmentElseMustBeNever",
                        message: `Type assignment pattern detected (extends infer without constraints). The else branch must be "never", but found "${falseRoot.type.name}"`,
                        position: falseRoot.position,
                        path: falseRoot.scope.path,
                        related: related({
                            message: "Type assignment pattern is here",
                            position: extendsCall.position,
                            path: extendsCall.scope.path,
                        }),
                    },
                });
            }
        }
        else if (isMonadRelated && !isTypeAssignment && !isPatternMatching) {
            // Monad-related conditionals (not pattern matching): neither branch should be "never"
            if (trueRoot.type.name === "never") {
                violations.push({
                    owner: callToOwner.get(conditional) ?? type,
                    violation: {
                        kind: "conditional.monadRelatedNeverNotAllowed",
                        message: `Using "never" in the true branch of a monad-related conditional is not allowed. Consider returning an error type instead`,
                        position: trueRoot.position,
                        path: trueRoot.scope.path,
                        related: related({
                            message: "Monad-related conditional is here",
                            position: conditional.position,
                            path: conditional.scope.path,
                        }),
                    },
                });
            }
            if (falseRoot.type.name === "never") {
                violations.push({
                    owner: callToOwner.get(conditional) ?? type,
                    violation: {
                        kind: "conditional.monadRelatedNeverNotAllowed",
                        message: `Using "never" in the else branch of a monad-related conditional is not allowed. Consider returning an error type instead`,
                        position: falseRoot.position,
                        path: falseRoot.scope.path,
                        related: related({
                            message: "Monad-related conditional is here",
                            position: conditional.position,
                            path: conditional.scope.path,
                        }),
                    },
                });
            }
        }
    }
    // Check that conditional branches with monad consumers in tuples have consistent tuple lengths
    for (const type of graph.types) {
        if (type.kind !== "typeAlias")
            continue;
        if (type === monadConstructor || type === monadReader || type === monadConsumer)
            continue;
        if (!hasMonadInput(type))
            continue;
        const typeBody = body(type);
        if (!typeBody || typeBody.type.name !== "<conditional>")
            continue;
        const conditional = typeBody;
        const trueRoot = conditional.arguments[1];
        const falseRoot = conditional.arguments[2];
        if (!trueRoot || !falseRoot)
            continue;
        // Check if either branch has a consumer call in a tuple
        const trueTupleWithConsumer = getTupleWithConsumer(trueRoot);
        const falseTupleWithConsumer = getTupleWithConsumer(falseRoot);
        if (trueTupleWithConsumer && !falseTupleWithConsumer) {
            // True branch has consumer in tuple, check false branch tuple length
            const falseTuple = resolveTupleCall(falseRoot);
            if (falseTuple && falseTuple.arguments.length !== trueTupleWithConsumer.arguments.length) {
                violations.push({
                    owner: callToOwner.get(conditional) ?? type,
                    violation: {
                        kind: "conditional.inconsistentTupleLengthWithConsumer",
                        message: `Tuple length mismatch: true branch has ${trueTupleWithConsumer.arguments.length} elements with monad consumer, but false branch has ${falseTuple.arguments.length} elements`,
                        position: falseTuple.position,
                        path: falseTuple.scope.path,
                        related: related({
                            message: `True branch tuple with consumer has ${trueTupleWithConsumer.arguments.length} elements`,
                            position: trueTupleWithConsumer.position,
                            path: trueTupleWithConsumer.scope.path,
                        }),
                    },
                });
            }
        }
        else if (falseTupleWithConsumer && !trueTupleWithConsumer) {
            // False branch has consumer in tuple, check true branch tuple length
            const trueTuple = resolveTupleCall(trueRoot);
            if (trueTuple && trueTuple.arguments.length !== falseTupleWithConsumer.arguments.length) {
                violations.push({
                    owner: callToOwner.get(conditional) ?? type,
                    violation: {
                        kind: "conditional.inconsistentTupleLengthWithConsumer",
                        message: `Tuple length mismatch: false branch has ${falseTupleWithConsumer.arguments.length} elements with monad consumer, but true branch has ${trueTuple.arguments.length} elements`,
                        position: trueTuple.position,
                        path: trueTuple.scope.path,
                        related: related({
                            message: `False branch tuple with consumer has ${falseTupleWithConsumer.arguments.length} elements`,
                            position: falseTupleWithConsumer.position,
                            path: falseTupleWithConsumer.scope.path,
                        }),
                    },
                });
            }
        }
    }
    const ownerKinds = new Map();
    const ownerViolations = new Map();
    for (const record of violations) {
        if (!record.owner)
            continue;
        if (!ownerKinds.has(record.owner))
            ownerKinds.set(record.owner, new Set());
        ownerKinds.get(record.owner).add(record.violation.kind);
        if (!ownerViolations.has(record.owner))
            ownerViolations.set(record.owner, []);
        ownerViolations.get(record.owner).push(record.violation);
    }
    return compactViolations(violations
        .filter(record => {
        if (!record.owner)
            return true;
        const kinds = ownerKinds.get(record.owner);
        if (!kinds)
            return true;
        const kind = record.violation.kind;
        // Focus on generic parameter-order root cause for this declaration.
        if (kinds.has("monad.invalidTypeParameterOrder")) {
            return kind === "monad.invalidTypeParameterOrder";
        }
        if (kinds.has("monad.invalidTypeParameterDefault")) {
            return kind === "monad.invalidTypeParameterDefault";
        }
        // If invocation structure is wrong, branch-shape incompatibility is derivative noise.
        if (kind === "monad.incompatibleTypes" &&
            (kinds.has("monad.invalidProducerPattern") ||
                kinds.has("monad.invalidProducerInvocation") ||
                kinds.has("monad.invalidConsumerInvocation"))) {
            return false;
        }
        // If producer conditional pattern is wrong, marker-use error in that same declaration is derivative.
        if (kind === "monad.invalidMarkerUsage" && kinds.has("monad.invalidProducerPattern")) {
            return false;
        }
        // If "consumed twice" is present, hide generic context-level monad usage diagnostics in that declaration.
        if (kind === "monad.invalidMonadUsageContext" && kinds.has("monad.multipleConsumption")) {
            return false;
        }
        // If monad argument-position misuse is present, producer-invocation error is derivative noise.
        if (kind === "monad.invalidProducerInvocation" && kinds.has("monad.invalidMonadUsageContext")) {
            const ownerMessages = ownerViolations.get(record.owner) ?? [];
            if (ownerMessages.some(v => v.kind === "monad.invalidMonadUsageContext" &&
                v.message.includes("first generic parameter is monad-bound"))) {
                return false;
            }
        }
        return true;
    })
        .map(record => record.violation));
    function terminalReturns(type) {
        return Array.from(returns(body(type)));
    }
    function isTupleWithMonadResult(call) {
        return ((call.type.name === "<tuple>" || call.type.name === "<readonlyTuple>") &&
            call.arguments.length >= 2 &&
            isMonadCompatibleCall(call.arguments[0]));
    }
    function isMonadCompatibleCall(call) {
        if (isMonadValueCall(call))
            return true;
        return findMonadConstraintFor(call.type.ref).constraint != null;
    }
    function isAllowedConsumerBranch(call) {
        if (call.type.name === "never")
            return true;
        if (isTupleWithMonadResult(call))
            return true;
        return tupleReturnTypes.has(call.type.ref);
    }
    function isAllowedConsumerBranchInComponent(call, component) {
        if (call.type.name === "never")
            return true;
        if (isTupleWithMonadResult(call))
            return true;
        if (component.has(call.type.ref))
            return true;
        return tupleReturnTypes.has(call.type.ref);
    }
    function hasNonRecursiveReturn(component) {
        for (const type of component) {
            for (const branch of terminalReturnsByType.get(type) ?? []) {
                if (branch.type.name === "never")
                    continue;
                if (isTupleWithMonadResult(branch))
                    return true;
                if (!component.has(branch.type.ref) && tupleReturnTypes.has(branch.type.ref))
                    return true;
            }
        }
        return false;
    }
    function isMonadValueCall(call) {
        return monadValueTypes.has(call.type.ref);
    }
    function isAllowedConsumerInvocation(call) {
        if (consumerTypeInTupleHead(call))
            return true;
        if (consumerPassedToUserMonadInputAsFirstArg(call))
            return true;
        if (consumerInFirstTupleItemOnConditionalExtendsLeft(call))
            return true;
        const owner = callToOwner.get(call);
        if (monadConsumer && owner === monadConsumer && terminalReturns(owner).some(ret => ret === call))
            return true;
        if (call.parent?.type.name !== "<extends>" || call.parent.arguments[0] !== call)
            return false;
        return (isTupleWithConfiguredMonadPattern(call.parent.arguments[1] ?? null) ||
            isConfiguredConsumerRootConditionalInferExtendsPattern(call));
    }
    function isAllowedUserProducerInvocation(call) {
        if (isProducerReturnedImmediatelyByProducer(call))
            return true;
        if (isProducerImmediatelyDestructuredInConditional(call))
            return true;
        return false;
    }
    function isProducerConditionalPatternError(call) {
        if (call.parent?.type.name !== "<extends>" || call.parent.arguments[0] !== call)
            return false;
        if (call.parent.parent?.type.name !== "<conditional>" || call.parent.parent.arguments[0] !== call.parent)
            return false;
        return !isInferMonadTupleDestructurePattern(call.parent.arguments[1] ?? null);
    }
    function isProducerReturnedImmediatelyByProducer(call) {
        const owner = callToOwner.get(call);
        if (!owner || !userProducerTypes.has(owner))
            return false;
        return terminalReturns(owner).some(ret => ret === call);
    }
    function isProducerImmediatelyDestructuredInConditional(call) {
        if (call.parent?.type.name !== "<extends>" || call.parent.arguments[0] !== call)
            return false;
        if (call.parent.parent?.type.name !== "<conditional>" || call.parent.parent.arguments[0] !== call.parent)
            return false;
        return isInferMonadTupleDestructurePattern(call.parent.arguments[1] ?? null);
    }
    function invalidProducerInvocationRelated(call, producerType) {
        const chain = [
            {
                message: `${producerType.name} is declared here`,
                position: producerType.position,
                path: producerType.scope.path,
            },
        ];
        const owner = callToOwner.get(call);
        const wrapper = call.parent;
        if (wrapper) {
            chain.push({
                message: `Producer call is nested in this wrapper (${wrapper.type.name})`,
                position: wrapper.position,
                path: wrapper.scope.path,
            });
        }
        if (!owner)
            return chain;
        chain.push({
            message: `Enclosing type ${owner.name} is declared here`,
            position: owner.position,
            path: owner.scope.path,
        });
        const ownerBody = body(owner);
        if (ownerBody) {
            chain.push({
                message: "Expected immediate terminal return position of the enclosing producer is here",
                position: ownerBody.position,
                path: ownerBody.scope.path,
            });
        }
        const nearestConditional = Array.from(parents(call)).find(parent => parent.type.name === "<conditional>");
        if (nearestConditional) {
            chain.push({
                message: "Nearest conditional check is here",
                position: nearestConditional.position,
                path: nearestConditional.scope.path,
            });
        }
        const nearestExtends = Array.from(parents(call)).find(parent => parent.type.name === "<extends>");
        if (nearestExtends) {
            chain.push({
                message: "Nearest extends check is here",
                position: nearestExtends.position,
                path: nearestExtends.scope.path,
            });
        }
        if (!hasMonadInput(owner)) {
            chain.push({
                message: `${owner.name} does not accept ${monadClassName} input, so producer calls are not allowed here`,
                position: owner.position,
                path: owner.scope.path,
            });
            return chain;
        }
        if (userProducerTypes.has(owner)) {
            return chain;
        }
        chain.push({
            message: `${owner.name} is not validated as a producer here`,
            position: owner.position,
            path: owner.scope.path,
        });
        chain.push(...producerValidationFailureChain(owner, new Set()));
        return chain;
    }
    function producerValidationFailureChain(type, seen) {
        if (seen.has(type))
            return [];
        seen.add(type);
        const branches = terminalReturnsByType.get(type) ?? terminalReturns(type);
        for (const branch of branches) {
            if (branch.type.name === "never")
                continue;
            if (isTupleWithMonadResult(branch))
                continue;
            if (tupleReturnTypes.has(branch.type.ref))
                continue;
            const result = [
                {
                    message: `${type.name} returns this non-producer branch`,
                    position: branch.position,
                    path: branch.scope.path,
                },
            ];
            const returnedType = branch.type.ref;
            if (!returnedType || returnedType === type)
                return result;
            result.push({
                message: `${returnedType.name} is declared here`,
                position: returnedType.position,
                path: returnedType.scope.path,
            });
            if (!hasMonadInput(returnedType)) {
                result.push({
                    message: `${returnedType.name} does not accept ${monadClassName} input and cannot serve as a producer return`,
                    position: returnedType.position,
                    path: returnedType.scope.path,
                });
                return result;
            }
            if (tupleReturnTypes.has(returnedType)) {
                result.push({
                    message: `${returnedType.name} is producer-compatible; this branch fails for a different reason`,
                    position: returnedType.position,
                    path: returnedType.scope.path,
                });
                return result;
            }
            result.push({
                message: `${returnedType.name} is not validated as a producer because one of its returns is invalid`,
                position: returnedType.position,
                path: returnedType.scope.path,
            });
            return [...result, ...producerValidationFailureChain(returnedType, seen)];
        }
        return [];
    }
    function isInferMonadTupleDestructurePattern(call) {
        if (!call || !(call.type.name === "<tuple>" || call.type.name === "<readonlyTuple>"))
            return false;
        if (call.arguments.length < 2)
            return false;
        const first = call.arguments[0];
        if (!first || first.type.name !== "<extends>")
            return false;
        const firstLeft = first.arguments[0];
        if (!firstLeft || firstLeft.type.name !== "<typeDeclaration>")
            return false;
        return first.arguments[1]?.type.ref === monadClass;
    }
    function monadUsageErrorMessage(call, parent) {
        if (parent.type.name === "<indexedAccess>") {
            return `Using monad ${call.type.name} here is not allowed, because indexed access cannot consume monad values`;
        }
        if (parent.type.name === "<typeOperator>" || parent.type.name === "<syntax>") {
            return `Using monad ${call.type.name} here is not allowed, because this syntax form cannot consume monad values`;
        }
        if (parent.type.name === "<tuple>" || parent.type.name === "<readonlyTuple>") {
            return `Using monad ${call.type.name} here is not allowed, because tuple usage is allowed only for consumer returns with monad in the first slot and tuple length >= 2`;
        }
        if (parent.type.name === "<object>" || parent.type.name === "<pair>" || parent.type.name === "<readonlyPair>") {
            return `Using monad ${call.type.name} here is not allowed, because object wrappers cannot consume monad values`;
        }
        return `Using monad ${call.type.name} here is not allowed. Allowed forms are: (1) pass it as the first argument of a type whose first generic parameter is monad-bound; (2) return it as the first item of a tuple with length >= 2`;
    }
    function monadArgumentUsageKind(parent) {
        return "monad.invalidMonadUsageContext";
    }
    function monadUsageContextMessage(parent) {
        if (parent.type.name === "<indexedAccess>")
            return "Indexed access usage context is here";
        if (parent.type.name === "<typeOperator>" || parent.type.name === "<syntax>")
            return "This syntax usage context is here";
        if (parent.type.name === "<tuple>" || parent.type.name === "<readonlyTuple>")
            return "Tuple usage context is here";
        if (parent.type.name === "<object>" || parent.type.name === "<pair>" || parent.type.name === "<readonlyPair>")
            return "Object usage context is here";
        return "Usage context is here";
    }
    function isTupleWithConfiguredMonadPattern(call) {
        if (!call ||
            !(call.type.name === "<tuple>" || call.type.name === "<readonlyTuple>") ||
            call.arguments.length < 1)
            return false;
        const head = call.arguments[0];
        if (!head)
            return false;
        if (head.type.ref === monadClass)
            return true;
        return (head.type.name === "<extends>" &&
            head.arguments[1]?.type.ref === monadClass &&
            head.arguments[0]?.type.name === "<typeDeclaration>");
    }
    function isIgnoredMonadUsage(call) {
        const owner = callToOwner.get(call);
        if (owner === monadReader || owner === monadConsumer)
            return true;
        if (call.type.ref === monadConsumer)
            return true;
        return call.parent?.type.ref === monadReader;
    }
    function isAllowedMonadClassMarkerUse(call) {
        if (
        // [infer] T extends Monad
        call.parent?.type.name === "<extends>" &&
            call.parent.arguments[1] === call &&
            call.parent.arguments[0]?.type.name === "<typeDeclaration>") {
            if (
            // infer T extends Monad ? ...
            call.parent.parent?.type.name === "<conditional>" &&
                call.parent.parent.arguments[0] === call.parent) {
                return true;
            }
            if (
            // type X<T extends Monad, ...> =
            call.parent.parent?.type.name === "<typeDeclaration>" &&
                call.parent.parent.arguments[2] === call.parent) {
                return true;
            }
            if (
            // consumerCall extends [infer T extends Monad, ...] ? ...
            (call.parent.parent?.type.name === "<tuple>" || call.parent.parent?.type.name === "<readonlyTuple>") &&
                call.parent.parent.arguments[0] === call.parent &&
                call.parent.parent.parent?.type.name === "<extends>" &&
                call.parent.parent.parent.arguments[1] === call.parent.parent &&
                call.parent.parent.parent.parent?.type.name === "<conditional>" &&
                call.parent.parent.parent.parent.arguments[0] === call.parent.parent.parent) {
                return true;
            }
            if (
            // configuredConsumerCall extends infer T extends Monad ? ...
            call.parent.parent?.type.name === "<extends>" &&
                call.parent.parent.arguments[1] === call.parent &&
                call.parent.parent.parent?.type.name === "<conditional>" &&
                call.parent.parent.parent.arguments[0] === call.parent.parent &&
                monadConsumer &&
                call.parent.parent.arguments[0]?.type.ref === monadConsumer) {
                return true;
            }
        }
        return false;
    }
    function isConfiguredConsumerRootConditionalInferExtendsPattern(call) {
        if (!monadConsumer || call.type.ref !== monadConsumer)
            return false;
        const extendsCall = call.parent;
        if (!extendsCall || extendsCall.type.name !== "<extends>" || extendsCall.arguments[0] !== call)
            return false;
        const rhs = extendsCall.arguments[1];
        if (!rhs ||
            rhs.type.name !== "<extends>" ||
            rhs.arguments[0]?.type.name !== "<typeDeclaration>" ||
            rhs.arguments[1]?.type.ref !== monadClass)
            return false;
        return extendsCall.parent?.type.name === "<conditional>" && extendsCall.parent.arguments[0] === extendsCall;
    }
    function isMonadArgumentUsage(call) {
        if (!call.parent)
            return false;
        if (call.parent.type.name === "<typeDeclaration>")
            return false;
        if (call.parent.type.name === "<declaration>")
            return false;
        if (call.parent.type.name === "<extends>")
            return false;
        if (call.parent.type.name === "<conditional>")
            return false;
        return true;
    }
    function isAllowedTupleConsumerResultPosition(call) {
        if (!(call.parent?.type.name === "<tuple>" || call.parent?.type.name === "<readonlyTuple>"))
            return false;
        if (call.parent.arguments[0] !== call)
            return false;
        const owner = callToOwner.get(call.parent);
        if (!owner || !(owner === monadConsumer || hasMonadInput(owner)))
            return false;
        return terminalReturns(owner).some(ret => ret === call.parent);
    }
    function consumerTypeInTupleHead(call) {
        if (call.type.ref !== monadConsumer)
            return false;
        if (!(call.parent?.type.name === "<tuple>" || call.parent?.type.name === "<readonlyTuple>"))
            return false;
        if (call.parent.arguments[0] !== call)
            return false;
        const owner = callToOwner.get(call.parent);
        if (!owner || !(owner === monadConsumer || hasMonadInput(owner)))
            return false;
        return terminalReturns(owner).some(ret => ret === call.parent);
    }
    function consumerPassedToUserMonadInputAsFirstArg(call) {
        if (call.type.ref !== monadConsumer)
            return false;
        if (!call.parent || call.parent.arguments[0] !== call)
            return false;
        const calleeType = call.parent.type.ref;
        return hasMonadInput(calleeType);
    }
    function consumerInFirstTupleItemOnConditionalExtendsLeft(call) {
        if (call.type.ref !== monadConsumer)
            return false;
        if (!(call.parent?.type.name === "<tuple>" || call.parent?.type.name === "<readonlyTuple>") ||
            call.parent.arguments[0] !== call)
            return false;
        const extendsCall = call.parent.parent;
        if (!extendsCall || extendsCall.type.name !== "<extends>" || extendsCall.arguments[0] !== call.parent)
            return false;
        return isTupleWithConfiguredMonadPattern(extendsCall.arguments[1] ?? null);
    }
    function hasMonadInput(type) {
        if (type === monadConsumer && !monadConsumer.declaration)
            return true;
        if (type === monadReader && !monadReader.declaration)
            return true;
        return type.arguments[0]?.extends?.type.ref === monadClass;
    }
    function sharesConditionalConditionPath(left, right) {
        const leftSlot = nearestConditionalSlot(left);
        const rightSlot = nearestConditionalSlot(right);
        if (!leftSlot || !rightSlot)
            return false;
        if (leftSlot.conditional !== rightSlot.conditional)
            return false;
        return ((leftSlot.slot === 0 && (rightSlot.slot === 1 || rightSlot.slot === 2)) ||
            (rightSlot.slot === 0 && (leftSlot.slot === 1 || leftSlot.slot === 2)));
    }
    function nearestConditionalSlot(call) {
        let current = call;
        while (current?.parent) {
            if (current.parent.type.name === "<conditional>") {
                const slot = current.parent.arguments.indexOf(current);
                return slot < 0 ? null : { conditional: current.parent, slot };
            }
            current = current.parent;
        }
        return null;
    }
    function isSimpleInferPattern(extendsCall) {
        // Pattern: ... extends infer X ? ... : ...
        // Check if right side of extends is a simple infer without constraints
        if (extendsCall.type.name !== "<extends>")
            return false;
        const rightSide = extendsCall.arguments[1];
        if (!rightSide)
            return false;
        // Check if it's an infer with a type declaration
        if (rightSide.type.name === "<extends>") {
            const leftOfExtends = rightSide.arguments[0];
            if (leftOfExtends?.type.name === "<typeDeclaration>") {
                // This is "infer X extends Something" - has constraints, not a simple assignment
                return false;
            }
        }
        // Check if it's just a type declaration (infer X without extends)
        if (rightSide.type.name === "<typeDeclaration>") {
            // This is "infer X" without constraints - simple assignment
            return true;
        }
        return false;
    }
    function isPatternMatchingConditional(extendsCall) {
        // Check if this is a pattern matching conditional with constrained infers
        // Pattern matching with constraints like [infer X extends Monad, infer Y extends string]
        // is allowed to use never as fallback
        if (extendsCall.type.name !== "<extends>")
            return false;
        const leftSide = extendsCall.arguments[0];
        const rightSide = extendsCall.arguments[1];
        if (!rightSide)
            return false;
        // Check for tuple/array patterns with constrained infer
        if (rightSide.type.name === "<tuple>" || rightSide.type.name === "<readonlyTuple>") {
            // Check if any element has infer with meaningful constraints (not unknown)
            const results = [];
            for (const arg of rightSide.arguments) {
                if (arg.type.name === "<extends>" && arg.arguments[0]?.type.name === "<typeDeclaration>") {
                    const constraint = arg.arguments[1];
                    const isConstrained = constraint && constraint.type.name !== "unknown";
                    results.push(isConstrained);
                }
            }
            const hasConstrainedInfer = results.some(r => r);
            return hasConstrainedInfer;
        }
        // Check for direct infer with meaningful constraint
        if (rightSide.type.name === "<extends>" && rightSide.arguments[0]?.type.name === "<typeDeclaration>") {
            const constraint = rightSide.arguments[1];
            if (constraint && constraint.type.name !== "unknown") {
                return true;
            }
        }
        // Check if left side is a tuple/array - this makes it structural pattern matching
        // Pattern: [MNext<M>] extends [infer X extends Monad] ? ... : never
        if (leftSide && (leftSide.type.name === "<tuple>" || leftSide.type.name === "<readonlyTuple>")) {
            return true;
        }
        return false;
    }
    function getTupleWithConsumer(root) {
        // Check if root is directly a tuple with consumer
        if (root.type.name === "<tuple>" || root.type.name === "<readonlyTuple>") {
            if (hasMonadConsumerInTuple(root))
                return root;
        }
        // Check if root is a type reference that resolves to a tuple with consumer
        if (root.type.ref && root.type.ref.kind === "typeAlias") {
            const resolvedBody = body(root.type.ref);
            if (resolvedBody && (resolvedBody.type.name === "<tuple>" || resolvedBody.type.name === "<readonlyTuple>")) {
                if (hasMonadConsumerInTuple(resolvedBody))
                    return resolvedBody;
            }
        }
        return null;
    }
    function resolveTupleCall(root) {
        // Check if root is directly a tuple
        if (root.type.name === "<tuple>" || root.type.name === "<readonlyTuple>") {
            return root;
        }
        // Check if root is a type reference that resolves to a tuple
        if (root.type.ref && root.type.ref.kind === "typeAlias") {
            const resolvedBody = body(root.type.ref);
            if (resolvedBody && (resolvedBody.type.name === "<tuple>" || resolvedBody.type.name === "<readonlyTuple>")) {
                return resolvedBody;
            }
        }
        return null;
    }
    function hasMonadConsumerInTuple(tuple) {
        // Check if any element in the tuple is a monad consumer call
        for (const arg of tuple.arguments) {
            if (arg.type.ref === monadConsumer)
                return true;
        }
        return false;
    }
}
function compactViolations(violations) {
    const unique = new Map();
    for (const violation of violations) {
        const key = [
            violation.kind,
            violation.path,
            violation.position.start,
            violation.position.end,
            violation.message,
        ].join("::");
        if (!unique.has(key))
            unique.set(key, violation);
    }
    const reduced = suppressIncompatibleBySharedReturnSource(suppressGenericBranchViolations(Array.from(unique.values())));
    const groupedBySpan = Map.groupBy(reduced.values(), violation => [violation.path, violation.position.start, violation.position.end].join("::"));
    return Array.from(groupedBySpan.values())
        .flatMap(group => group
        .sort((left, right) => violationRank(left) - violationRank(right))
        .slice(0, 1))
        .sort((left, right) => {
        if (left.path !== right.path)
            return left.path.localeCompare(right.path);
        if (left.position.start !== right.position.start)
            return left.position.start - right.position.start;
        if (left.position.end !== right.position.end)
            return left.position.end - right.position.end;
        return violationRank(left) - violationRank(right);
    });
}
function suppressGenericBranchViolations(violations) {
    return violations.filter(violation => {
        if (violation.kind !== "monad.incompatibleTypes")
            return true;
        const source = findReturnSourceRelated(violation);
        if (source &&
            violations.some(candidate => {
                if (candidate === violation)
                    return false;
                if (!candidate.kind.startsWith("monad."))
                    return false;
                if (candidate.kind === "monad.incompatibleTypes")
                    return false;
                if (candidate.path !== source.path)
                    return false;
                return (candidate.position.start <= source.position.start && candidate.position.end >= source.position.end);
            })) {
            return false;
        }
        return !violations.some(candidate => {
            if (candidate === violation)
                return false;
            if (!candidate.kind.startsWith("monad.invalid"))
                return false;
            if (candidate.path !== violation.path)
                return false;
            return (candidate.position.start >= violation.position.start && candidate.position.end <= violation.position.end);
        });
    });
}
function findReturnSourceRelated(violation) {
    return violation.related?.find(item => item.message?.includes("return source is here")) ?? null;
}
function suppressIncompatibleBySharedReturnSource(violations) {
    const seenSources = new Set();
    return violations.filter(violation => {
        if (violation.kind !== "monad.incompatibleTypes")
            return true;
        const source = findReturnSourceRelated(violation);
        if (!source)
            return true;
        const key = [source.path, source.position.start, source.position.end].join("::");
        if (seenSources.has(key))
            return false;
        seenSources.add(key);
        return true;
    });
}
function violationRank(violation) {
    if (violation.message.includes("already consumed it earlier"))
        return 0;
    if (violation.message.startsWith("Using producer "))
        return 1;
    if (violation.message.startsWith("Using consumer "))
        return 1;
    if (violation.message.includes("only the first generic parameter may extend"))
        return 1;
    if (violation.message.includes("is only a marker type"))
        return 2;
    switch (violation.kind) {
        case "monad.multipleConsumption":
            return 0;
        case "monad.invalidProducerPattern":
        case "monad.invalidProducerInvocation":
        case "monad.invalidConsumerInvocation":
        case "monad.invalidTypeParameterOrder":
        case "monad.invalidTypeParameterDefault":
            return 1;
        case "monad.invalidMarkerUsage":
        case "monad.invalidMonadUsageContext":
            return 2;
        case "monad.incompatibleTypes":
            return 3;
        default:
            return violation.kind.startsWith("monad.invalid") ? 4 : 5;
    }
}
function normalizeTypePath(path) {
    return path
        .replaceAll("\\", "/")
        .replace(/^\.\/+/, "")
        .replaceAll(/\/+/g, "/");
}
function usages(type) {
    return type.called.values().filter(c => c.parent?.type.name !== "<typeDeclaration>");
}
function* parents(call) {
    let current = call;
    while (current.parent != null) {
        yield current.parent;
        current = current.parent;
    }
}
function* returns(body) {
    if (body) {
        if (body.type.name !== "<conditional>") {
            yield body;
        }
        else {
            yield* returns(body.arguments[1]);
            yield* returns(body.arguments[2]);
        }
    }
}
function* allCalls(c) {
    if (c) {
        yield c;
        yield* c.arguments.values().flatMap(allCalls);
    }
}
function* allCallsForType(type) {
    yield* allCalls(type.declaration?.parent);
}
function body(type) {
    return type?.declaration?.parent?.arguments[1] ?? type?.body;
}
function scopeContains(parent, child) {
    let current = child;
    while (current) {
        if (current === parent)
            return true;
        current = current.parent;
    }
    return false;
}
function compareCalls(left, right) {
    if (left.scope.path !== right.scope.path)
        return left.scope.path.localeCompare(right.scope.path);
    if (left.position.start !== right.position.start)
        return left.position.start - right.position.start;
    return left.position.end - right.position.end;
}
