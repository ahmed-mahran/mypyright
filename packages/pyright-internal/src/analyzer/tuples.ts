/*
 * tuples.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Provides special-case logic for type analysis of tuples.
 */

import { DiagnosticAddendum } from '../common/diagnostic';
import { ExpressionNode, SliceNode } from '../parser/parseNodes';
import { ConstraintTracker } from './constraintTracker';
import { matchAccumulateSequence } from './sequenceMatching';
import { TypeEvaluator } from './typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    combineTypes,
    isAnyOrUnknown,
    isClassInstance,
    isInstantiableClass,
    isTypeVar,
    isTypeVarTuple,
    isUnpackedTypeVarTuple,
    TupleTypeArg,
    Type,
    TypeVarType,
} from './types';
import { AssignTypeFlags, isLiteralType, isTupleClass, isUnboundedTupleClass, specializeTupleClass } from './typeUtils';

// Assigns the source type arguments to the dest type arguments. It assumed
// the the caller has already verified that both the dest and source are
// tuple classes.
export function assignTupleTypeArgs(
    evaluator: TypeEvaluator,
    destType: ClassType,
    srcType: ClassType,
    diag: DiagnosticAddendum | undefined,
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number
) {
    const destTypeArgs = [...(destType.priv.tupleTypeArgs ?? [])];
    const srcTypeArgs = [...(srcType.priv.tupleTypeArgs ?? [])];

    const matchedTypeArgs = matchTupleTypeArgs(
        evaluator,
        destTypeArgs,
        srcTypeArgs,
        constraints,
        flags,
        recursionCount
    );

    //TODO: Handle diag on mismatch
    if (matchedTypeArgs !== undefined && constraints && !constraints.isLocked()) {
        const tupleClass = evaluator.getTupleClassType();
        //TODO: check variance
        matchedTypeArgs.forEach((pair) => {
            if (pair.destSequence.length === 1 && isTypeVarTuple(pair.destSequence[0].type)) {
                const srcArgType = createVariadicTuple(pair.srcSequence, tupleClass);
                constraints.setBounds(pair.destSequence[0].type, srcArgType);
            } else if (pair.srcSequence.length === 1 && isTypeVarTuple(pair.srcSequence[0].type)) {
                const destArgType = createVariadicTuple(pair.destSequence, tupleClass);
                constraints.setBounds(pair.srcSequence[0].type, destArgType);
            } else if (pair.destSequence.length === pair.srcSequence.length) {
                for (let i = 0; i < pair.destSequence.length; i++) {
                    const destArg = pair.destSequence[i].type;
                    const srcArg = pair.srcSequence[i].type;
                    if (isTypeVar(destArg)) {
                        constraints.setBounds(destArg, srcArg);
                    } else if (isTypeVar(srcArg)) {
                        constraints.setBounds(srcArg, destArg);
                    }
                }
            }
        });
    }
    // if (adjustTupleTypeArgs(evaluator, destTypeArgs, srcTypeArgs, flags)) {
    //     for (let argIndex = 0; argIndex < srcTypeArgs.length; argIndex++) {
    //         const entryDiag = diag?.createAddendum();
    //         const destArgType = destTypeArgs[argIndex].type;
    //         const srcArgType = srcTypeArgs[argIndex].type;

    //         // Handle the special case where the dest is a TypeVarTuple
    //         // and the source is a `*tuple[Any, ...]`. This is allowed.
    //         if (
    //             isTypeVarTuple(destArgType) &&
    //             destArgType.priv.isUnpacked &&
    //             !destArgType.priv.isInUnion &&
    //             isTupleGradualForm(srcArgType)
    //         ) {
    //             return true;
    //         }

    //         if (
    //             !evaluator.assignType(
    //                 destArgType,
    //                 srcArgType,
    //                 entryDiag?.createAddendum(),
    //                 constraints,
    //                 flags,
    //                 recursionCount
    //             )
    //         ) {
    //             if (entryDiag) {
    //                 entryDiag.addMessage(
    //                     LocAddendum.tupleEntryTypeMismatch().format({
    //                         entry: argIndex + 1,
    //                     })
    //                 );
    //             }
    //             return false;
    //         }
    //     }
    // } else {
    //     const isDestIndeterminate = destTypeArgs.some((t) => t.isUnbounded || isTypeVarTuple(t.type));

    //     if (srcTypeArgs.some((t) => t.isUnbounded || isTypeVarTuple(t.type))) {
    //         if (isDestIndeterminate) {
    //             diag?.addMessage(
    //                 LocAddendum.tupleSizeIndeterminateSrcDest().format({
    //                     expected: destTypeArgs.length - 1,
    //                 })
    //             );
    //         } else {
    //             diag?.addMessage(
    //                 LocAddendum.tupleSizeIndeterminateSrc().format({
    //                     expected: destTypeArgs.length,
    //                 })
    //             );
    //         }
    //     } else {
    //         if (isDestIndeterminate) {
    //             diag?.addMessage(
    //                 LocAddendum.tupleSizeMismatchIndeterminateDest().format({
    //                     expected: destTypeArgs.length - 1,
    //                     received: srcTypeArgs.length,
    //                 })
    //             );
    //         } else {
    //             diag?.addMessage(
    //                 LocAddendum.tupleSizeMismatch().format({
    //                     expected: destTypeArgs.length,
    //                     received: srcTypeArgs.length,
    //                 })
    //             );
    //         }
    //     }

    //     return false;
    // }

    return matchedTypeArgs !== undefined;
}

function createVariadicTuple(typeArgs: TupleTypeArg[], tupleClass: ClassType | undefined) {
    if (tupleClass && isInstantiableClass(tupleClass)) {
        const tuple = ClassType.cloneAsInstance(
            specializeTupleClass(
                tupleClass,
                typeArgs.map((typeArg) => {
                    return {
                        type: typeArg.type,
                        isUnbounded: typeArg.isUnbounded,
                        isOptional: typeArg.isOptional,
                    };
                }),
                /* isTypeArgExplicit */ true,
                /* isUnpacked */ true
            )
        );
        tuple.priv.isEmptyContainer = typeArgs.length === 0;
        return tuple;
    }
    return undefined;
}

// Matches the source and dest type arguments list such that TypeVarTuples
// from either list are matched to zero or more arguments from the other
// list. Matching is performed in a greedy manner; such that one TypeVarTuple
// from one list matches as most arguments from the other list as possible.
// If no arguments matches for a given TypeVarTuple, then an empty unpacked
// tuple is assumed.
// It returns list of matches, or undefined otherwise.
export function matchTupleTypeArgs(
    evaluator: TypeEvaluator,
    destTypeArgs: TupleTypeArg[],
    srcTypeArgs: TupleTypeArg[],
    constraints: ConstraintTracker | undefined,
    flags: AssignTypeFlags,
    recursionCount: number
) {
    const isRepeated = function (type: TupleTypeArg | undefined): boolean {
        return (
            type !== undefined &&
            (isTypeVarTuple(type.type) ||
                (isClassInstance(type.type) && isTupleClass(type.type) && isUnboundedTupleClass(type.type) === true))
        );
    };

    const toStr = function (type: TupleTypeArg | undefined): string {
        return type !== undefined ? evaluator.printType(type.type) : 'undefined';
    };

    const memo = new Map<string, boolean>();
    const matches = function (destType: TupleTypeArg | undefined, srcType: TupleTypeArg | undefined): boolean {
        const key = `${toStr(destType)}|${toStr(srcType)}`;
        let res = memo.get(key);
        if (res !== undefined) {
            return res;
        } else {
            res =
                destType !== undefined &&
                srcType !== undefined &&
                evaluator.assignType(
                    destType.type,
                    srcType.type,
                    /* diag */ undefined,
                    // matching repeated VS non-repeated needs to build up new constraints,
                    // as the repeated element is collecting more non-repeated elements
                    (isRepeated(destType) && isRepeated(srcType)) || !(isRepeated(destType) || isRepeated(srcType))
                        ? constraints
                        : new ConstraintTracker(),
                    flags,
                    recursionCount
                );
            memo.set(key, res);
            return res;
        }
    };

    // We are testing combinations of matches, so we don't want to change any constraints
    // based on any invalid combinations.
    const wasLocked = constraints?.isLocked();
    if (!wasLocked) {
        constraints?.lock();
    }
    const matchedTypeArgs = matchAccumulateSequence<TupleTypeArg, TupleTypeArg>(
        destTypeArgs,
        srcTypeArgs,
        isRepeated,
        isRepeated,
        matches,
        toStr,
        toStr
    );
    if (!wasLocked) {
        constraints?.unlock();
    }

    return matchedTypeArgs;
}

// Adjusts the source and/or dest type arguments list to attempt to match
// the length of the src type arguments list if the dest or source contain
// entries with indeterminate length or unpacked TypeVarTuple entries.
// It returns true if the source is potentially compatible with the dest
// type, false otherwise.
export function adjustTupleTypeArgs(
    evaluator: TypeEvaluator,
    destTypeArgs: TupleTypeArg[],
    srcTypeArgs: TupleTypeArg[],
    flags: AssignTypeFlags
): boolean {
    const destUnboundedOrVariadicIndex = destTypeArgs.findIndex((t) => t.isUnbounded || isTypeVarTuple(t.type));
    const srcUnboundedIndex = srcTypeArgs.findIndex((t) => t.isUnbounded);
    const srcVariadicIndex = srcTypeArgs.findIndex((t) => isTypeVarTuple(t.type));

    if (srcUnboundedIndex >= 0) {
        if (isAnyOrUnknown(srcTypeArgs[srcUnboundedIndex].type)) {
            // If the source contains an unbounded Any, expand it to match the dest length.
            const typeToReplicate = srcTypeArgs.length > 0 ? srcTypeArgs[srcUnboundedIndex].type : AnyType.create();

            while (srcTypeArgs.length < destTypeArgs.length) {
                srcTypeArgs.splice(srcUnboundedIndex, 0, { type: typeToReplicate, isUnbounded: true });
            }

            if (srcTypeArgs.length > destTypeArgs.length) {
                srcTypeArgs.splice(srcUnboundedIndex, 1);
            }
        } else if (destUnboundedOrVariadicIndex < 0) {
            // If the source contains an unbounded type but the dest does not, it's incompatible.
            return false;
        }
    }

    // If the dest contains an unbounded Any, expand it to match the source length.
    if (
        destUnboundedOrVariadicIndex >= 0 &&
        destTypeArgs[destUnboundedOrVariadicIndex].isUnbounded &&
        isAnyOrUnknown(destTypeArgs[destUnboundedOrVariadicIndex].type)
    ) {
        while (destTypeArgs.length < srcTypeArgs.length) {
            destTypeArgs.splice(destUnboundedOrVariadicIndex, 0, destTypeArgs[destUnboundedOrVariadicIndex]);
        }
    }

    // Remove any optional parameters from the end of the two lists until the lengths match.
    while (srcTypeArgs.length > destTypeArgs.length && srcTypeArgs[srcTypeArgs.length - 1].isOptional) {
        srcTypeArgs.splice(srcTypeArgs.length - 1, 1);
    }

    while (destTypeArgs.length > srcTypeArgs.length && destTypeArgs[destTypeArgs.length - 1].isOptional) {
        destTypeArgs.splice(destTypeArgs.length - 1, 1);
    }

    const srcArgsToCapture = srcTypeArgs.length - destTypeArgs.length + 1;
    let skipAdjustSrc = false;

    // If we're doing reverse type mappings and the source contains a TypeVarTuple,
    // we need to adjust the dest so the reverse type mapping assignment
    // can be performed.
    if ((flags & AssignTypeFlags.Contravariant) !== 0) {
        const destArgsToCapture = destTypeArgs.length - srcTypeArgs.length + 1;

        if (srcVariadicIndex >= 0 && destArgsToCapture >= 0) {
            // If the only removed arg from the dest type args is itself a variadic,
            // don't bother adjusting it.
            const skipAdjustment = destArgsToCapture === 1 && isTypeVarTuple(destTypeArgs[srcVariadicIndex].type);
            const tupleClass = evaluator.getTupleClassType();

            if (!skipAdjustment && tupleClass && isInstantiableClass(tupleClass)) {
                const removedArgs = destTypeArgs.splice(srcVariadicIndex, destArgsToCapture);

                // Package up the remaining type arguments into a tuple object.
                const variadicTuple = ClassType.cloneAsInstance(
                    specializeTupleClass(
                        tupleClass,
                        removedArgs.map((typeArg) => {
                            return {
                                type: typeArg.type,
                                isUnbounded: typeArg.isUnbounded,
                                isOptional: typeArg.isOptional,
                            };
                        }),
                        /* isTypeArgExplicit */ true,
                        /* isUnpacked */ true
                    )
                );

                destTypeArgs.splice(srcVariadicIndex, 0, {
                    type: variadicTuple,
                    isUnbounded: false,
                });
            }

            skipAdjustSrc = true;
        }
    } else {
        if (destUnboundedOrVariadicIndex >= 0 && srcArgsToCapture >= 0) {
            // If the dest contains a variadic element, determine which source
            // args map to this element and package them up into an unpacked tuple.
            if (isTypeVarTuple(destTypeArgs[destUnboundedOrVariadicIndex].type)) {
                const tupleClass = evaluator.getTupleClassType();

                if (tupleClass && isInstantiableClass(tupleClass)) {
                    const removedArgs = srcTypeArgs.splice(destUnboundedOrVariadicIndex, srcArgsToCapture);

                    let variadicTuple: Type;

                    // If we're left with a single unpacked variadic type var, there's no
                    // need to wrap it in a nested tuple.
                    if (removedArgs.length === 1 && isUnpackedTypeVarTuple(removedArgs[0].type)) {
                        variadicTuple = removedArgs[0].type;
                    } else {
                        // Package up the remaining type arguments into a tuple object.
                        variadicTuple = ClassType.cloneAsInstance(
                            specializeTupleClass(
                                tupleClass,
                                removedArgs.map((typeArg) => {
                                    return {
                                        type: typeArg.type,
                                        isUnbounded: typeArg.isUnbounded,
                                        isOptional: typeArg.isOptional,
                                    };
                                }),
                                /* isTypeArgExplicit */ true,
                                /* isUnpacked */ true
                            )
                        );
                    }

                    srcTypeArgs.splice(destUnboundedOrVariadicIndex, 0, {
                        type: variadicTuple,
                        isUnbounded: false,
                    });
                }

                skipAdjustSrc = true;
            }
        }
    }

    if (!skipAdjustSrc && destUnboundedOrVariadicIndex >= 0 && srcArgsToCapture >= 0) {
        // If possible, package up the source entries that correspond to
        // the dest unbounded tuple. This isn't possible if the source contains
        // an unbounded tuple outside of this range.
        if (
            srcUnboundedIndex < 0 ||
            (srcUnboundedIndex >= destUnboundedOrVariadicIndex &&
                srcUnboundedIndex < destUnboundedOrVariadicIndex + srcArgsToCapture)
        ) {
            const removedArgTypes = srcTypeArgs.splice(destUnboundedOrVariadicIndex, srcArgsToCapture).map((t) => {
                if (isTypeVar(t.type) && isUnpackedTypeVarTuple(t.type)) {
                    return TypeVarType.cloneForUnpacked(t.type, /* isInUnion */ true);
                }
                return t.type;
            });

            srcTypeArgs.splice(destUnboundedOrVariadicIndex, 0, {
                type: removedArgTypes.length > 0 ? combineTypes(removedArgTypes) : AnyType.create(),
                isUnbounded: false,
            });
        }
    }

    return destTypeArgs.length === srcTypeArgs.length;
}

// Given a tuple type and a slice expression, determines the resulting
// type if it can be determined. If not, it returns undefined.
export function getSlicedTupleType(
    evaluator: TypeEvaluator,
    tupleType: ClassType,
    sliceNode: SliceNode
): Type | undefined {
    // We don't handle step values.
    if (sliceNode.d.stepValue || !tupleType.priv.tupleTypeArgs) {
        return undefined;
    }

    const tupleTypeArgs = tupleType.priv.tupleTypeArgs;
    const startValue = getTupleSliceParam(evaluator, sliceNode.d.startValue, 0, tupleTypeArgs);
    const endValue = getTupleSliceParam(evaluator, sliceNode.d.endValue, tupleTypeArgs.length, tupleTypeArgs);

    if (startValue === undefined || endValue === undefined || endValue < startValue) {
        return undefined;
    }

    const slicedTypeArgs = tupleTypeArgs.slice(startValue, endValue);
    return ClassType.cloneAsInstance(specializeTupleClass(tupleType, slicedTypeArgs));
}

function getTupleSliceParam(
    evaluator: TypeEvaluator,
    expression: ExpressionNode | undefined,
    defaultValue: number,
    tupleTypeArgs: TupleTypeArg[]
): number | undefined {
    let value = defaultValue;

    if (expression) {
        const valType = evaluator.getTypeOfExpression(expression).type;
        if (!isClassInstance(valType) || !ClassType.isBuiltIn(valType, 'int') || !isLiteralType(valType)) {
            return undefined;
        }

        value = valType.priv.literalValue as number;
        const unboundedIndex = tupleTypeArgs.findIndex(
            (typeArg) => typeArg.isUnbounded || isTypeVarTuple(typeArg.type)
        );

        if (value < 0) {
            value = tupleTypeArgs.length + value;
            if (unboundedIndex >= 0 && value <= unboundedIndex) {
                return undefined;
            } else if (value < 0) {
                return 0;
            }
        } else {
            if (unboundedIndex >= 0 && value > unboundedIndex) {
                return undefined;
            } else if (value > tupleTypeArgs.length) {
                return tupleTypeArgs.length;
            }
        }
    }

    return value;
}
