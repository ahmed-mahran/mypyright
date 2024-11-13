import { assert, fail } from '../common/debug';
import { DiagnosticAddendum } from '../common/diagnostic';
import { DiagnosticRule } from '../common/diagnosticRules';
import { DiagnosticSink } from '../common/diagnosticSink';
import { convertOffsetsToRange } from '../common/positionUtils';
import { ExpressionNode, isExpressionNode, ParseNode, ParseNodeType } from '../parser/parseNodes';
import { ParseOptions, Parser } from '../parser/parser';
import { pythonExecTypeMap } from '../pythonExec';
import { getFileInfo, setFileInfo } from './analyzerNodeInfo';
import { ConstraintTracker } from './constraintTracker';
import { printExpression } from './parseTreeUtils';
import { ParseTreeWalker } from './parseTreeWalker';
import { EvalFlags, TypeEvaluator, TypeResult } from './typeEvaluatorTypes';
import {
    AnyType,
    ClassType,
    combineTypes,
    isAnyOrUnknown,
    isAnyUnknownOrObject,
    isClass,
    isTypeSame,
    isTypeVarTuple,
    isUnion,
    isUnknown,
    TupleTypeArg,
    Type,
    TypeBase,
    TypeFlags,
    TypeVarKind,
    TypeVarType,
    UnionableType,
    UnknownType,
    Variance,
} from './types';
import {
    convertToInstance,
    convertToInstantiable,
    getTypeVarArgsRecursive,
    InferenceContext,
    isLiteralLikeType,
    isNoneInstance,
    isTupleClass,
    isTupleGradualForm,
    mapSubtypes,
    specializeTupleClass,
} from './typeUtils';

export namespace MyPyrightExtensions {
    export const printTypeMapResult: boolean = false;

    const enum TupleCreationFlags {
        None = 0,

        TypeArgsExplicit = 1 << 0,

        Unpacked = 1 << 1,

        Map = 1 << 2,
    }

    function createTupleTypeInstance(
        evaluator: TypeEvaluator,
        tupleTypeArgs: TupleTypeArg[],
        flags = TupleCreationFlags.None
    ) {
        const tupleClass = evaluator.getTupleClassType();
        if (tupleClass) {
            const isTypeArgsExplicit: boolean | undefined =
                (flags & TupleCreationFlags.TypeArgsExplicit) !== 0 ? true : undefined;
            const isUnpacked: boolean | undefined = (flags & TupleCreationFlags.Unpacked) !== 0 ? true : undefined;
            const isMap: boolean | undefined = (flags & TupleCreationFlags.Map) !== 0 ? true : undefined;
            const tuple = ClassType.cloneAsInstance(
                specializeTupleClass(tupleClass, tupleTypeArgs, isTypeArgsExplicit, isUnpacked),
                /* includeSubclasses */ false
            );
            tuple.priv.isMapTuple = isMap;
            return tuple;
        }

        fail("Couldn't get a tuple class type from evaluator");
    }

    function getTypeClassType(evaluator: TypeEvaluator) {
        const typeClass = evaluator.getTypeClassType();
        if (typeClass) {
            return ClassType.cloneAsInstance(typeClass);
        }

        fail("Couldn't get a tuple class type from evaluator");
    }

    export function handleTypeForGetTypeOfExpression(
        evaluator: TypeEvaluator,
        typeResult: TypeResult,
        node: ExpressionNode,
        flags = EvalFlags.None,
        constraints: ConstraintTracker | undefined,
        inferenceContext?: InferenceContext
    ) {
        let returnType: Type = typeResult.type;
        if (returnType && isClass(returnType) && returnType.shared.moduleName === 'mypyright_extensions') {
            const diag = function () {
                if (!typeResult.expectedTypeDiagAddendum) {
                    typeResult.expectedTypeDiagAddendum = new DiagnosticAddendum();
                }
                typeResult.expectedTypeDiagAddendum.addTextRange(node);
                typeResult.typeErrors = true;
                return typeResult.expectedTypeDiagAddendum;
            };

            switch (returnType.shared.name) {
                case 'Map':
                    returnType = handleMap(evaluator, returnType, flags, diag);
                    break;
            }
        }

        typeResult.type = returnType;
        return typeResult;
    }

    // Map[type, int, T, *Ts]  ==== tuple[type[int], type[T], *Ts: type]
    // Map[type, int]  ==== tuple[type[int]]
    // Map[type, T]  ==== tuple[type[T]]
    // Map[type, *Ts]  ==== tuple[*Ts: type]
    function handleMap(
        evaluator: TypeEvaluator,
        type: ClassType,
        flags = EvalFlags.None,
        diag: () => DiagnosticAddendum
    ): Type {
        function setProperFlags<T extends Type>(type: T): T {
            if ((flags & EvalFlags.InstantiableType) !== 0) {
                type.flags |= TypeFlags.Instantiable;
                type.flags &= ~TypeFlags.Instance;
            } else {
                type.flags |= TypeFlags.Instance;
                type.flags &= ~TypeFlags.Instantiable;
            }
            return type;
        }

        if (type.priv.typeArgs) {
            let rawMap = type.priv.typeArgs[0];
            // Strip all map tuples to properly support nested Maps
            // Map[Map[F1, Map[F2, ...]], ...] ==> Map[F1[F2[...]], ...]
            while (
                isClass(rawMap) &&
                !!rawMap.priv.isMapTuple &&
                rawMap.priv.tupleTypeArgs &&
                rawMap.priv.tupleTypeArgs.length === 1
            ) {
                rawMap = rawMap.priv.tupleTypeArgs[0].type;
            }
            const map = MapType.fromMappedType(evaluator, setFlagMapped(rawMap));
            if (map) {
                const mapArg = type.priv.typeArgs[1];
                if (isTypeVarTuple(mapArg) && !!mapArg.priv.isUnpacked) {
                    return setProperFlags(
                        setFlagMapped(
                            createTupleTypeInstance(
                                evaluator,
                                [{ type: convertToMappedType(evaluator, map, mapArg), isUnbounded: false }],
                                TupleCreationFlags.Map
                            )
                        )
                    );
                } else if (isClass(mapArg) && isTupleClass(mapArg)) {
                    return setProperFlags(
                        setFlagMapped(
                            createTupleTypeInstance(
                                evaluator,
                                (convertToMappedType(evaluator, map, mapArg) as ClassType).priv.tupleTypeArgs ?? [],
                                TupleCreationFlags.Map
                            )
                        )
                    );
                }
            } else {
                diag().addMessage(`Cannot create a Map from ${evaluator.printType(type)}`);
            }
        }
        return type;
    }

    export function createBoundForTypeVar(
        evaluator: TypeEvaluator,
        typeVar: TypeVarType,
        boundType: Type | undefined
    ): Type | undefined {
        if (!!boundType && isTypeVarTuple(typeVar)) {
            const isIterTupleClass = isClass(boundType) && isTupleClass(boundType) && isIterTuple(boundType);
            if (!isTypeVarTuple(boundType) && !isIterTupleClass) {
                const tuple = createTupleTypeInstance(
                    evaluator,
                    [{ type: boundType, isUnbounded: true }],
                    TupleCreationFlags.Unpacked
                );
                if (isMappedType(boundType)) {
                    setFlagMapped(tuple);
                }
                return tuple;
            } else if (isIterTupleClass && !boundType.priv.isUnpacked) {
                return ClassType.cloneForUnpacked(boundType);
            } else if (isTypeVarTuple(boundType) && !boundType.priv.isUnpacked) {
                return TypeVarType.cloneForUnpacked(boundType, boundType.priv.isInUnion);
            }
        }
        return boundType;
    }

    export function convertToMappedType(evaluator: TypeEvaluator, map: MapType, type?: Type): Type {
        //TODO if type is Union, return map of Union or Union of maps?
        // Now we return map of Union because it is simplier and doesn't
        // seem to be wrong.

        if (type && isTypeVarTuple(type)) {
            const clone = TypeBase.cloneType(type);
            const mappedBoundType = convertToMappedType(
                evaluator,
                map,
                isMappedType(clone) ? clone.shared.mappedBoundType : clone.shared.boundType
            );
            clone.shared.mappedBoundType = createBoundForTypeVar(evaluator, clone, mappedBoundType);
            if (clone.priv.freeTypeVar) {
                const mappedFreeTypeVar = convertToMappedType(evaluator, map, clone.priv.freeTypeVar);
                if (isTypeVarTuple(mappedFreeTypeVar)) {
                    clone.priv.freeTypeVar = mappedFreeTypeVar;
                }
            }
            if (clone.priv.subscript) {
                const mappedSubscript = convertToMappedType(evaluator, map, clone.priv.subscript.base);
                if (isTypeVarTuple(mappedSubscript)) {
                    clone.priv.subscript.base = mappedSubscript;
                }
            }
            return setFlagMapped(clone);
        } else if (type && isClass(type) && isTupleClass(type) && isIterTuple(type)) {
            const clone = TypeBase.cloneType(type);
            clone.priv.tupleTypeArgs = type.priv.tupleTypeArgs?.map((arg) => ({
                type: convertToMappedType(evaluator, map, arg.type),
                isUnbounded: arg.isUnbounded,
                isOptional: arg.isOptional,
            }));
            return setFlagMapped(clone);
        } else {
            return setFlagMapped(map.specialize(type));
        }
    }

    export class MapType {
        outer: Type;
        inner?: MapType;

        constructor(outer: Type, inner?: MapType) {
            this.outer = outer;
            this.inner = inner;
        }

        get type(): Type {
            return MapType.mapToType(this);
        }

        specialize(arg?: Type): Type {
            return MapType.specialize(this, arg);
        }

        linearize(): Type[] {
            return MapType.linearize(this);
        }
    }

    export namespace MapType {
        export function fromMappedType(evaluator: TypeEvaluator, type: Type): MapType | undefined {
            assert(isMappedType(type), `Type ${evaluator.printType(type)} is not a mapped type!`);

            function _from(type: Type): MapType | undefined {
                if (!isMappedType(type)) {
                    return undefined;
                }

                if (TypeBase.isInstantiable(type) && !TypeBase.isInstance(type)) {
                    return new MapType(
                        getTypeClassType(evaluator),
                        _from(TypeBase.cloneTypeAsInstance(type, /* cache */ false))
                    );
                } else if (isClass(type) && isEffectivelyGenericClassType(type)) {
                    const mapArg = firstOptional(type.priv.tupleTypeArgs)?.type ?? firstOptional(type.priv.typeArgs);
                    const innerMap = mapArg ? _from(mapArg) : undefined;
                    return new MapType(specializeMapClassType(type), innerMap);
                }

                return undefined;
            }

            return _from(type);
        }

        export function fromLineage(lineage: Type[]): MapType | undefined {
            let map: MapType | undefined = undefined;
            for (let i = lineage.length - 1; i >= 0; i--) {
                map = new MapType(lineage[i], map);
            }
            return map;
        }

        export function isMapTypeSame(map1: MapType, map2: MapType): boolean {
            return (
                isTypeSame(map1.outer, map2.outer) &&
                ((!map1.inner && !map2.inner) ||
                    (!!map1.inner && !!map2.inner && isMapTypeSame(map1.inner, map2.inner)))
            );
        }

        export function mapToType(map: MapType): Type {
            return map.inner ? specializeMapType(map.outer, mapToType(map.inner)) : TypeBase.cloneType(map.outer);
        }

        export function specialize(map: MapType, arg?: Type): Type {
            return specializeMapType(map.outer, map.inner ? specialize(map.inner, arg) : arg);
        }

        export function combine(maps: MapType[]): MapType | undefined {
            const inners = maps.map((map) => map.inner).filter((inner) => inner !== undefined);
            if (inners.length !== maps.length && inners.length > 0) {
                inners.push(new MapType(newUnknownType()));
            }

            return new MapType(
                combineTypes(maps.map((map) => map.outer)),
                inners.length > 0 ? combine(inners) : undefined
            );
        }

        export function linearize(map: MapType): Type[] {
            const maps: Type[] = [];
            const _linearize = function (map: MapType): void {
                maps.push(map.outer);
                if (map.inner) {
                    _linearize(map.inner);
                }
            };
            _linearize(map);
            return maps;
        }

        /**
         * Removes suffixMap from map keeping only the outer most map. If map and
         * suffixMap are the same, returns undefined. If suffixMap is not a suffix
         * of map, returns map.
         */
        export function pruneSuffix(map: MapType, suffixMap: MapType) {
            const mapLineage = map.linearize();
            const suffixLineage = suffixMap.linearize();
            let i = mapLineage.length - 1;
            let j = suffixLineage.length - 1;
            while (i >= 0 && j >= 0 && isTypeSame(mapLineage[i], suffixLineage[j])) {
                i--;
                j--;
            }
            if (i >= 0 && j < 0) {
                return MapType.fromLineage(mapLineage.slice(0, i + 1));
            } else if (i < 0 && j < 0) {
                return undefined;
            } else {
                return map;
            }
        }
    }

    export interface MapSpec {
        map: MapType;
        arg?: Type;
    }

    interface InternalMapSpec {
        map?: MapType;
        arg?: Type;
    }

    export function deconstructMappedType1(evaluator: TypeEvaluator, type: Type): MapSpec {
        assert(isMappedType(type), `Type ${evaluator.printType(type)} is not a mapped type!`);

        function _deconstructMappedSubtypes<T, R extends Type>(
            ts: T[] | undefined,
            getMappedType: (mappedT: T) => Type,
            getUnmappedT: (unmapped: Type | undefined, mappedT: T) => T | undefined,
            combineArgs: (args: T[]) => R
        ) {
            const deconstructions =
                ts?.map((t) => {
                    const { map, arg } = _deconstructMappedType(getMappedType(t));
                    return { map, arg, mappedT: t };
                }) ?? [];
            const concreteArgs = deconstructions.map((d) => getUnmappedT(d.arg, d.mappedT)).filter((a) => !!a) as T[];
            const hasErrors =
                // at least one map is empty
                deconstructions.some((d) => !d.map);
            if (hasErrors) {
                return {};
            }
            const concreteMaps = deconstructions.map((d) => d.map).filter((m) => !!m);
            const map = MapType.combine(concreteMaps);
            const arg = unsetFlagMapped(combineArgs(concreteArgs));
            return { map, arg };
        }

        function _deconstructMappedType(type: Type): InternalMapSpec {
            if (isMappedType(type)) {
                if (TypeBase.isInstantiable(type) && !TypeBase.isInstance(type)) {
                    const { map, arg } = _deconstructMappedType(unsetFlagMapped(convertToInstance(type)));
                    return { map: new MapType(getTypeClassType(evaluator), map), arg };
                } else if (isClass(type) && isEffectivelyGenericClassType(type)) {
                    if (isTupleClass(type) && isIterTuple(type)) {
                        return _deconstructMappedSubtypes(
                            type.priv.tupleTypeArgs,
                            (a) => a.type,
                            (arg, a) => ({
                                type: arg ?? AnyType.create(),
                                isUnbounded: a.isUnbounded,
                                isOptional: a.isOptional,
                            }),
                            (args) => {
                                const arg = ClassType.cloneAsInstance(specializeTupleClass(type, args));
                                arg.priv.isEmptyContainer = args.length === 0;
                                return arg;
                            }
                        );
                    }

                    const firstArg = isTupleClass(type)
                        ? firstOptional(type.priv.tupleTypeArgs)?.type
                        : firstOptional(type.priv.typeArgs);
                    const internalMapSpec = firstArg ? _deconstructMappedType(TypeBase.cloneType(firstArg)) : undefined;
                    return {
                        map: new MapType(specializeMapType(type), internalMapSpec?.map),
                        arg: internalMapSpec?.arg,
                    };
                } else if (isTypeVarTuple(type)) {
                    //TODO handle constraints maybe?
                    const clone = unsetFlagMapped(TypeBase.cloneType(type));
                    if (clone.priv.freeTypeVar) {
                        const { arg } = _deconstructMappedType(clone.priv.freeTypeVar);
                        if (!!arg && isTypeVarTuple(arg)) {
                            clone.priv.freeTypeVar = arg;
                        }
                    }
                    if (clone.priv.subscript) {
                        const { arg } = _deconstructMappedType(clone.priv.subscript.base);
                        if (!!arg && isTypeVarTuple(arg)) {
                            clone.priv.subscript.base = arg;
                        }
                    }
                    if (clone.shared.mappedBoundType) {
                        const { map, arg } = _deconstructMappedType(clone.shared.mappedBoundType);
                        clone.shared.boundType = !!arg && !isTupleGradualForm(arg) ? arg : undefined;
                        return { map, arg: clone };
                    } else {
                        return {};
                    }
                } else if (isUnion(type)) {
                    return _deconstructMappedSubtypes(
                        type.priv.subtypes,
                        (t) => t,
                        // e.g. some mapped classes are not specialized like (Type),
                        // in this case we get undefined arg, but for Union we assume
                        // arg is Any
                        (arg, t) => (arg ?? AnyType.create()) as UnionableType | undefined,
                        combineTypes
                    );
                } else {
                    return {
                        map: new MapType(specializeMapType(type)),
                    };
                }
            } else {
                return {
                    map: isAnyOrUnknown(type) ? new MapType(newUnknownType()) : undefined,
                    arg: TypeBase.cloneType(type),
                };
            }
        }

        const internalMapSpec = _deconstructMappedType(type);
        assert(!!internalMapSpec.map, `Cannot get a map for type ${evaluator.printType(type)}!`);
        return { map: internalMapSpec.map, arg: internalMapSpec.arg };
    }

    export function deconstructMappedType2(
        evaluator: TypeEvaluator,
        type: Type,
        baseMap: MapType,
        isTypeDest: boolean
    ): MapSpec | undefined {
        function _deconstructMappedSubtypes<T, R extends Type>(
            ts: T[] | undefined,
            getMappedType: (mappedT: T) => Type,
            getUnmappedT: (unmapped: Type | undefined, mappedT: T) => T | undefined,
            combineArgs: (args: T[]) => R,
            baseMap?: MapType
        ) {
            const deconstructions =
                ts?.map((t) => {
                    const deconstruction = _deconstructMappedType2(getMappedType(t), baseMap);
                    if (deconstruction) {
                        return { map: deconstruction.map, arg: deconstruction.arg, mappedT: t };
                    } else {
                        return undefined;
                    }
                }) ?? [];

            const concreteMaps: MapType[] = [];
            const concreteArgs: T[] = [];
            deconstructions.forEach((d) => {
                if (d !== undefined) {
                    if (d.map) {
                        concreteMaps.push(d.map);
                    }
                    const unmappedT = getUnmappedT(d.arg, d.mappedT);
                    if (unmappedT) {
                        concreteArgs.push(unmappedT);
                    }
                }
            });
            const hasErrors =
                // at least one map is empty
                deconstructions.some((d) => !d?.map) ||
                //// at least one arg is empty but not all
                //(deconstructions.some((d) => !d?.arg) && !deconstructions.every((d) => !d?.arg)) ||
                concreteMaps.length !== deconstructions.length;
            if (hasErrors) {
                return undefined;
            }
            const map = MapType.combine(concreteMaps);
            const arg = unsetFlagMapped(combineArgs(concreteArgs));
            return map ? { map, arg } : undefined;
        }

        function _deconstructMappedType2(type: Type, baseMap?: MapType): InternalMapSpec | undefined {
            if (baseMap) {
                if (
                    ((TypeBase.isInstantiable(type) && !TypeBase.isInstance(type)) ||
                        (isClass(type) && isLiteralLikeType(type))) &&
                    isClass(baseMap.outer) &&
                    ClassType.isBuiltIn(baseMap.outer, 'type')
                ) {
                    const innerMapSpec = _deconstructMappedType2(
                        TypeBase.isInstantiable(type) ? convertToInstance(type) : TypeBase.cloneType(type),
                        baseMap.inner
                    );
                    return innerMapSpec
                        ? { map: new MapType(getTypeClassType(evaluator), innerMapSpec.map), arg: innerMapSpec.arg }
                        : undefined;
                } else if (isClass(type) && isEffectivelyGenericClassType(type)) {
                    if (
                        isTupleClass(type) &&
                        (!isClass(baseMap.outer) ||
                            !isTupleClass(baseMap.outer) ||
                            (baseMap.outer.priv.tupleTypeArgs?.length ?? 1) !==
                                (type.priv.tupleTypeArgs?.length ?? 1) ||
                            (baseMap.outer.priv.tupleTypeArgs ?? []).some(
                                (arg, i) => i > 0 && !isTypeSame(arg.type, (type.priv.tupleTypeArgs ?? [])[i].type)
                            ))
                    ) {
                        return _deconstructMappedSubtypes(
                            type.priv.tupleTypeArgs,
                            (a) => a.type,
                            (arg, a) => ({
                                type: arg ?? AnyType.create(),
                                isUnbounded: a.isUnbounded,
                                isOptional: a.isOptional,
                            }),
                            (args) => {
                                const arg = ClassType.cloneAsInstance(specializeTupleClass(type, args));
                                arg.priv.isEmptyContainer = args.length === 0;
                                return arg;
                            },
                            baseMap
                        );
                    } else if (
                        isClass(baseMap.outer) &&
                        (isTypeDest
                            ? ClassType.isDerivedFrom(baseMap.outer, type)
                            : ClassType.isDerivedFrom(type, baseMap.outer))
                    ) {
                        const arg = isTupleClass(type)
                            ? firstOptional(type.priv.tupleTypeArgs)?.type
                            : firstOptional(type.priv.typeArgs);
                        const innerMapSpec = arg
                            ? _deconstructMappedType2(TypeBase.cloneType(arg), baseMap.inner)
                            : { map: baseMap.inner };
                        return innerMapSpec
                            ? { map: new MapType(specializeMapType(type), innerMapSpec.map), arg: innerMapSpec.arg }
                            : undefined;
                    }
                } else if (isTypeVarTuple(type)) {
                    //TODO handle constraints maybe?

                    const clone = unsetFlagMapped(TypeBase.cloneType(type));
                    if (clone.priv.freeTypeVar) {
                        const freeTypeVarMapSpec = _deconstructMappedType2(clone.priv.freeTypeVar, baseMap);
                        if (!!freeTypeVarMapSpec?.arg && isTypeVarTuple(freeTypeVarMapSpec.arg)) {
                            clone.priv.freeTypeVar = freeTypeVarMapSpec.arg;
                        }
                    }
                    if (clone.priv.subscript) {
                        const subscriptMapSpec = _deconstructMappedType2(clone.priv.subscript.base, baseMap);
                        if (!!subscriptMapSpec?.arg && isTypeVarTuple(subscriptMapSpec.arg)) {
                            clone.priv.subscript.base = subscriptMapSpec.arg;
                        }
                    }
                    const boundType = isMappedType(type) ? type.shared.mappedBoundType : type.shared.boundType;
                    if (boundType) {
                        const innerMapSpec = _deconstructMappedType2(boundType, baseMap);
                        return innerMapSpec ? { map: innerMapSpec.map, arg: clone } : undefined;
                    } else {
                        if (isMappedType(type)) {
                            clone.shared.mappedBoundType = setFlagMapped(baseMap.type);
                        } else {
                            clone.shared.boundType = unsetFlagMapped(baseMap.type);
                        }
                        return { map: baseMap, arg: clone };
                    }
                } else if (isUnion(type)) {
                    return _deconstructMappedSubtypes(
                        type.priv.subtypes,
                        (t) => t,
                        // e.g. some mapped classes are not specialized like (Type),
                        // in this case we get undefined arg, but for Union we assume
                        // arg is Any
                        (arg, t) => (arg ?? AnyType.create()) as UnionableType | undefined,
                        combineTypes,
                        baseMap
                    );
                } else if (isAnyUnknownOrObject(type) || isNoneInstance(type) || isAnyUnknownOrObject(baseMap.outer)) {
                    return { map: baseMap, arg: unsetFlagMapped(TypeBase.cloneType(type)) };
                }
            } else {
                return { arg: unsetFlagMapped(type) };
            }
            return undefined;
        }

        const internalMapSpec = _deconstructMappedType2(type, baseMap);
        return internalMapSpec && internalMapSpec.map
            ? { map: internalMapSpec.map, arg: internalMapSpec.arg }
            : undefined;
    }

    export function deconstructMutualMappedTypes(
        evaluator: TypeEvaluator,
        destType: Type,
        srcType: Type
    ): { destMapSpec: MapSpec; srcMapSpec: MapSpec } | undefined {
        if (isMappedType(destType)) {
            const destMapSpec = deconstructMappedType1(evaluator, destType);
            const srcMapSpec = deconstructMappedType2(evaluator, srcType, destMapSpec.map, /*isTypeDest*/ false);
            return srcMapSpec ? { destMapSpec, srcMapSpec } : undefined;
        } else if (isMappedType(srcType)) {
            const srcMapSpec = deconstructMappedType1(evaluator, srcType);
            const destMapSpec = deconstructMappedType2(evaluator, destType, srcMapSpec.map, /*isTypeDest*/ true);
            return destMapSpec ? { destMapSpec, srcMapSpec } : undefined;
        }

        // should not happen
        fail('Either type should be mapped or a base map should be provided!');
    }

    export function isMappedType(type: Type): boolean {
        return (type.flags & TypeFlags.Mapped) !== 0;
    }

    export function isMappedTypeVar(typeVar: TypeVarType): boolean {
        const isMapped = isMappedType(typeVar);
        if (!isTypeVarTuple(typeVar) && isMapped && TypeBase.isInstantiable(typeVar)) {
            return TypeBase.getInstantiableMappedDepth(typeVar) > TypeBase.getInstantiableDepth(typeVar);
        }
        return isMapped;
    }

    export function setFlagMapped<T extends Type>(type: T): T {
        if (!isUnknown(type)) {
            if (isMappedType(type) && TypeBase.isInstantiable(type)) {
                TypeBase.setInstantiableMappedDepth(type, TypeBase.getInstantiableMappedDepth(type) + 1);
            }
            type.flags |= TypeFlags.Mapped;
        }
        return type;
    }

    export function unsetFlagMapped<T extends Type>(type: T): T {
        if (type.props?.instantiableMappedDepth === undefined || type.props?.instantiableMappedDepth === 0) {
            type.flags &= ~TypeFlags.Mapped;
        } else {
            const instantiableMappedDepth = TypeBase.getInstantiableMappedDepth(type) - 1;
            TypeBase.setInstantiableMappedDepth(type, instantiableMappedDepth);
            if (instantiableMappedDepth <= 0) {
                type.flags &= ~TypeFlags.Mapped;
            }
        }
        return type;
    }

    // Can be a Map type, i.e. first argument to Map[,]?
    export function isEffectivelyGenericClassType(type: ClassType): boolean {
        return (
            ClassType.isBuiltIn(type, 'type') ||
            type.shared.typeParams.length > 0 ||
            // ClassType.isPseudoGenericClass(type) ||
            (!!type.priv.typeArgs && type.priv.typeArgs.length > 0)
        );
    }

    export function specializeMapClassType(map: ClassType, type?: Type): ClassType {
        function replaceFirst<T>(ts: T[] | undefined, clone: (t: T) => T, replace: (t: T | undefined) => T): T[] {
            return ts && ts.length > 0 ? ts.map((t, i) => (i === 0 ? replace(t) : clone(t))) : [replace(undefined)];
        }

        let mapped;
        if (ClassType.isBuiltIn(map, 'tuple')) {
            mapped = specializeTupleClass(
                map,
                replaceFirst(
                    map.priv.tupleTypeArgs,
                    (a) => ({
                        type: TypeBase.cloneType(a.type),
                        isUnbounded: a?.isUnbounded ?? false,
                        isOptional: a?.isOptional,
                    }),
                    (a) => ({
                        type: type ?? newUnknownType(),
                        isUnbounded: a?.isUnbounded ?? false,
                        isOptional: a?.isOptional,
                    })
                )
            );
            mapped.priv.isUnpacked &&= !!map.priv.tupleTypeArgs && map.priv.tupleTypeArgs.length > 0;
            // if there is no argument (!type) and tuple has only one argument to specialize (tupleTypeArgs?.length === 1)
            // then let's set it to undefined so as not to propagate useless types (e.g. Unknown)
            if (!type && mapped.priv.tupleTypeArgs?.length === 1) {
                mapped.priv.tupleTypeArgs = undefined;
            }
        } else {
            mapped = ClassType.specialize(
                map,
                replaceFirst(map.priv.typeArgs, TypeBase.cloneType, (_) => type ?? newUnknownType()),
                undefined,
                undefined
            );
            // if there is no argument (!type) and class has only one argument to specialize (typeArgs?.length === 1)
            // then let's set it to undefined so as not to propagate useless types (e.g. Unknown)
            if (!type && mapped.priv.typeArgs?.length === 1) {
                mapped.priv.typeArgs = undefined;
            }
        }

        return ClassType.cloneAsInstance(mapped);
    }

    export function specializeMapType(map: Type, type?: Type): Type {
        return mapSubtypes(map, (subtypeOfMap) => {
            if (isClass(subtypeOfMap)) {
                if (ClassType.isBuiltIn(subtypeOfMap, 'type') && !!type) {
                    return convertToInstantiable(TypeBase.cloneType(type));
                } else if (isEffectivelyGenericClassType(subtypeOfMap)) {
                    return specializeMapClassType(subtypeOfMap, type ? TypeBase.cloneType(type) : undefined);
                }
            }
            return TypeBase.cloneType(subtypeOfMap);
        });
    }

    function isIterTuple(type: ClassType) {
        return !!type.priv.isMapTuple || !!type.priv.isUnpacked;
    }

    export function printTypeVar(evaluator: TypeEvaluator, type: TypeVarType) {
        return `${evaluator.printType(type)}${printTypeVarBound(evaluator, type)}`;
    }

    export function printTypeVarBound(evaluator: TypeEvaluator, type: TypeVarType) {
        const boundType = isMappedType(type) ? type.shared.mappedBoundType : type.shared.boundType;
        return boundType ? `: ${evaluator.printType(boundType)}` : '';
    }

    export function firstOptional<T>(ts: T[] | undefined): T | undefined {
        return ts?.find((_, i) => i === 0);
    }

    function newUnknownType() {
        // return TypeBase.cloneType(UnknownType.create());
        return UnknownType.create();
    }

    export function isSubscriptable(classType: ClassType): boolean {
        return (
            classType.shared.fullName === 'mypyright_extensions.subscriptable' ||
            classType.shared.fullName === 'mypyright_extensions.subscriptablefunction' ||
            classType.shared.fullName === 'mypyright_extensions.subscriptablemethod' ||
            classType.shared.fullName === 'mypyright_extensions.subscriptableclassmethod'
        );
    }

    function typeVarToPythonDeclarationSyntax(typeVar: TypeVarType, toPythonSyntax: (type: Type) => string) {
        switch (typeVar.shared.kind) {
            case TypeVarKind.TypeVar:
                // (name, *constraints, bound=None, covariant=False, contravariant=False, infer_variance=False, default=typing.NoDefault)
                return (
                    `${typeVar.shared.name}=TypeVar('${typeVar.shared.name}',` +
                    `${
                        typeVar.shared.constraints.length > 0
                            ? `${typeVar.shared.constraints.map((c) => toPythonSyntax(c))},`
                            : ''
                    }` +
                    `${typeVar.shared.boundType ? `bound=${toPythonSyntax(typeVar.shared.boundType)},` : ''}` +
                    `${typeVar.shared.declaredVariance === Variance.Covariant ? 'covariant=True,' : ''}` +
                    `${typeVar.shared.declaredVariance === Variance.Contravariant ? 'contravariant=True,' : ''}` +
                    `${typeVar.shared.declaredVariance === Variance.Auto ? 'infer_variance=True,' : ''}` +
                    `${
                        typeVar.shared.isDefaultExplicit ? `default=${toPythonSyntax(typeVar.shared.defaultType)}` : ''
                    }` +
                    `)`
                );
            case TypeVarKind.TypeVarTuple:
                // (name, *, default=typing.NoDefault)
                return (
                    `${typeVar.shared.name}=TypeVarTuple('${typeVar.shared.name}',` +
                    `${
                        typeVar.shared.isDefaultExplicit ? `default=${toPythonSyntax(typeVar.shared.defaultType)}` : ''
                    }` +
                    `)`
                );
            case TypeVarKind.ParamSpec:
                // (name, *, bound=None, covariant=False, contravariant=False, default=typing.NoDefault)
                return (
                    `${typeVar.shared.name}=ParamSpec('${typeVar.shared.name}',` +
                    `${typeVar.shared.boundType ? `bound=${toPythonSyntax(typeVar.shared.boundType)},` : ''}` +
                    `${typeVar.shared.declaredVariance === Variance.Covariant ? 'covariant=True,' : ''}` +
                    `${typeVar.shared.declaredVariance === Variance.Contravariant ? 'contravariant=True,' : ''}` +
                    `${
                        typeVar.shared.isDefaultExplicit ? `default=${toPythonSyntax(typeVar.shared.defaultType)}` : ''
                    }` +
                    `)`
                );
        }
    }

    export function generateTypeMapPythonCode(type: Type, toPythonSyntax: (type: Type) => string) {
        //TODO this is vulnerable to deprecation of PEP 484 (TypeVar), PEP 612 (ParamSpec),
        // and PEP 646 (TypeVarTuple) in favor of PEP 695 (Type Parameter Syntax).
        const typeVars = getTypeVarArgsRecursive(type);
        let sawTypeVar = false;
        let sawTypeVarTuple = false;
        let sawParamSpec = false;
        const typeVarsDecls = typeVars
            .map((typeVar) => {
                switch (typeVar.shared.kind) {
                    case TypeVarKind.TypeVar:
                        sawTypeVar = true;
                        break;
                    case TypeVarKind.TypeVarTuple:
                        sawTypeVarTuple = true;
                        break;
                    case TypeVarKind.ParamSpec:
                        sawParamSpec = true;
                        break;
                }
                return typeVarToPythonDeclarationSyntax(typeVar, toPythonSyntax);
            })
            .join(';');

        const typingImports = [
            sawTypeVar ? 'TypeVar' : undefined,
            sawTypeVarTuple ? 'TypeVarTuple' : undefined,
            sawParamSpec ? 'ParamSpec' : undefined,
        ].filter((i) => i !== undefined);

        return [
            typingImports.length > 0 ? `from typing import ${typingImports.join(',')}` : '',
            typeVarsDecls,
            `_mypyright_type_map_t=${toPythonSyntax(type)}`,
        ]
            .filter((line) => line.length > 0)
            .join(';');
    }

    function toPythonSyntax(evaluator: TypeEvaluator, t: Type) {
        return evaluator.printType(
            //TODO when do you need to convert to instance instead?
            TypeBase.isInstantiable(t) ? TypeBase.cloneTypeAsInstance(t, /* cache */ false) : t,
            { enforcePythonSyntax: true }
        );
    }

    export function applyTypeMap(evaluator: TypeEvaluator, node: ParseNode, type: Type): Type {
        let result = type;

        if (
            isClass(type) &&
            type.shared.declaration &&
            type.shared.baseClasses.some(
                (baseType) => isClass(baseType) && baseType.shared.fullName === 'mypyright_extensions.TypeMap'
            ) &&
            // make sure we are applying the type map in the context of the correct node
            // e.g. don't apply to a name node while the parent is an index node with
            // type arguments.
            type.shared.declaration?.node !== node &&
            isExpressionNode(node) &&
            ((type.shared.typeParams.length > 0 && node.nodeType === ParseNodeType.Index) ||
                (type.shared.typeParams.length === 0 && node.nodeType === ParseNodeType.Name) ||
                !(node.nodeType === ParseNodeType.Index || node.nodeType === ParseNodeType.Name))
        ) {
            const typeMapExpr = toPythonSyntax(evaluator, type);
            if (evaluator.typeMapRecursionSet.has(typeMapExpr)) {
                // Guard against recursive type mapping; Map[T] => V => Map[V] => T ...
                // If the type map returns a type which itself is a type map that returns
                // maybe itself or a previously returned type, we need to detect this
                // recursion.
                return result;
            }

            const typeMapDeclFileInfo = getFileInfo(type.shared.declaration.node);
            const typeMapCallResult = pythonExecTypeMap(
                typeMapExpr,
                `{'${type.shared.name}':'${typeMapDeclFileInfo.fileUri.getFilePath()}'}`
            );
            if (typeMapCallResult.status) {
                const parser = new Parser();

                const parseOptions = new ParseOptions();
                parseOptions.isStubFile = false;
                parseOptions.pythonVersion = typeMapDeclFileInfo.executionEnvironment.pythonVersion;
                parseOptions.reportErrorsForParsedStringContents = true;

                const parsingDiag = new DiagnosticSink();
                const parseResults = parser.parseSourceFile(typeMapCallResult.output, parseOptions, parsingDiag);

                if (parsingDiag.getErrors().length > 0) {
                    parsingDiag
                        .getErrors()
                        .forEach((error) =>
                            evaluator.addDiagnostic(
                                (error.getRule() as DiagnosticRule) || DiagnosticRule.reportGeneralTypeIssues,
                                'TypeMap result parse error in `' + parseResults.text + '`: ' + error.message,
                                node
                            )
                        );
                } else {
                    evaluator.typeMapRecursionSet.add(typeMapExpr);
                    parseResults.parserOutput.parseTree.parent = node.parent;
                    setFileInfo(parseResults.parserOutput.parseTree, getFileInfo(node));

                    // Take place as a sibling to the subject node in original parse tree.
                    // Subtree at impersonator node should mimic same text range of subject node
                    // so that all errors are reporter on text range of subject node.
                    function impersonateNode(other: ParseNode) {
                        const subjectNode = node;
                        other.parent = subjectNode.parent;
                        class NodeImpersonator extends ParseTreeWalker {
                            override visit(node: ParseNode): boolean {
                                (node as any).start = subjectNode.start;
                                (node as any).length = subjectNode.length;
                                return true;
                            }
                        }
                        new NodeImpersonator().walk(other);
                    }

                    let typeChanged = false;
                    const firstNode = parseResults.parserOutput.parseTree.d.statements[0];
                    if (firstNode.nodeType === ParseNodeType.Class) {
                        impersonateNode(firstNode);
                        const typeResult = evaluator.getTypeOfClass(firstNode);
                        if (typeResult) {
                            result = typeResult.classType;
                            typeChanged = true;
                        }
                    } else if (firstNode.nodeType === ParseNodeType.StatementList) {
                        const expressionNode = firstNode.d.statements[0];
                        if (isExpressionNode(expressionNode)) {
                            impersonateNode(expressionNode);
                            const typeResult = evaluator.getTypeOfExpression(expressionNode);
                            if (!typeResult.typeErrors) {
                                result = typeResult.type;
                                typeChanged = true;
                            }
                        }
                    }

                    if (typeChanged) {
                        // TODO what other inheritable context info do we need to migrate from original type?
                        // Any recursive data to apply to subtypes?
                        result.flags = type.flags;
                        if (type.props?.instantiableDepth !== undefined) {
                            TypeBase.setInstantiableDepth(result, type.props?.instantiableDepth);
                        }
                        if (type.props?.instantiableMappedDepth !== undefined) {
                            TypeBase.setInstantiableMappedDepth(result, type.props?.instantiableMappedDepth);
                        }

                        if (printTypeMapResult) {
                            const fileInfo = getFileInfo(node);
                            const range = convertOffsetsToRange(node.start, node.start + node.length, fileInfo.lines);
                            const lineNum = (range.start.line + 1).toString();
                            console.log(
                                `${printExpression(node)} (${lineNum}): ${evaluator.printType(
                                    type
                                )} ==> ${evaluator.printType(result)}`
                            );
                        }
                    }

                    evaluator.typeMapRecursionSet.delete(typeMapExpr);
                }
            } else if (typeMapCallResult.error) {
                const diag = new DiagnosticAddendum();
                diag.addMessage(typeMapCallResult.error);
                evaluator.addDiagnostic(DiagnosticRule.reportGeneralTypeIssues, diag.getString(), node);
            }
        }

        return result;
    }
}
