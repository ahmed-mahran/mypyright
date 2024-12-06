import argparse
import ast
from inspect import isclass
import os
import sys
import traceback
from typing import Any, NotRequired, TypedDict, cast
from mypyright_extensions import (
  This,
  TypeAsFunction,
  TypeRefinementPredicate,
  TypeRefinementResult,
  refine,
  subscriptablefunction,
  SymbolTable,
  TypeMap,
  parse_type_expr,
  parse_str_dict,
  resolve_types,
)


@subscriptablefunction
def parse_symbol_table[T](tp: type[T], symbol_table_expr: str, resolved: dict[str, type[T]] | None = None) -> SymbolTable[T]:
  return SymbolTable(symbol_table_expr, resolved)


@subscriptablefunction
def parse_typevar_table[T, R](result_type: type[R], typevar_table_expr: str, symbol_table: SymbolTable[T]) -> dict[str, TypeAsFunction[T, R] | None]:
  typevar_table = parse_str_dict(typevar_table_expr)
  def parse_resolve_type(tp: str):
    return resolve_types(parse_type_expr(tp), symbol_table, result_type)
  return dict([
      (typevar_name, (None if typevar_annotation_expr == 'None' else parse_resolve_type(typevar_annotation_expr)))
      for typevar_name, typevar_annotation_expr in typevar_table.items()
    ])

def exec_map_type(type_map_expr: str, symbol_table_expr: str):
  type_map = parse_type_expr(type_map_expr)
  symbol_table = parse_symbol_table[TypeMap](symbol_table_expr)
  type_map_fn = resolve_types(type_map, symbol_table, Any)
  if isclass(type_map_fn.base) and issubclass(type_map_fn.base, TypeMap):
    return type_map_fn.base.map_type(type_map_expr)

class RefineTypeArgs(TypedDict):
  type: str
  assumptions: NotRequired[list[str]]
  tests: list[str]

def exec_refine_type(args: RefineTypeArgs, symbol_table_expr: str, typevar_bound_table_expr: str):
  type_expr_str = args.get('type')
  assumption_predicates_expr_str = args.get('assumptions')
  test_predicates_expr_str = args.get('tests')

  symbol_table = parse_symbol_table[TypeRefinementPredicate](symbol_table_expr, {'This': This})
  typevar_bound_table = parse_typevar_table[TypeRefinementResult](typevar_bound_table_expr, symbol_table)

  def parse_predicate(pred: str):
    return resolve_types(parse_type_expr(pred), symbol_table, TypeRefinementResult)

  return refine(
    parse_type_expr(type_expr_str),
    None,
    [parse_predicate(test) for test in test_predicates_expr_str],
    [parse_predicate(assumption) for assumption in assumption_predicates_expr_str] if assumption_predicates_expr_str is not None else None,
    typevar_bound_table,
    {},
  ).result

parser = argparse.ArgumentParser(
                    prog='Python Exec',
                    description='Executes python code')

parser.add_argument('--symbol-table')
parser.add_argument('--typevar-table')
parser.add_argument('-m', '--map-type', dest='map_type_args', nargs=1)
parser.add_argument('-r', '--refine-type', dest='refine_type_args', nargs=1)

def indent(code: str) -> str:
  return '\n'.join(['\t' + line for line in code.splitlines()])

if __name__ == "__main__":
  stdout_old = sys.stdout
  stderr_old = sys.stderr
  # sys.stderr = sys.stdout = open(os.devnull, 'w')
  sys.stdout = stderr_old
  sys.stderr = open(os.devnull, 'w')

  try:
    args = parser.parse_args()

    if args.map_type_args is not None:
      result = exec_map_type(args.map_type_args[0], args.symbol_table)
      if result is not None:
        stdout_old.write(result)
        stdout_old.flush()

    elif args.refine_type_args is not None:
      result = exec_refine_type(cast(RefineTypeArgs, ast.literal_eval(args.refine_type_args[0])), args.symbol_table, args.typevar_table)
      if result is not None:
        stdout_old.write(str(result.status))
        stdout_old.flush()

  except Exception as e:
    stderr_old.write(traceback.format_exc())
    stderr_old.flush()
    raise e
