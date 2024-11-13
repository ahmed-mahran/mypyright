import argparse
from inspect import isclass
import os
import sys
import traceback
from mypyright_extensions import (
  subscriptablefunction,
  SymbolTable,
  TypeMap,
  parse_type_expr,
  resolve_types,
)


@subscriptablefunction
def parse_symbol_table[T](tp: type[T], symbol_table_expr: str) -> SymbolTable[T]:
  return SymbolTable(symbol_table_expr)

def exec_map_type(type_map_expr: str, symbol_table_expr: str):
  type_map = parse_type_expr(type_map_expr)
  symbol_table = parse_symbol_table[TypeMap](symbol_table_expr)
  type_map_fn = resolve_types(type_map, symbol_table)
  if isclass(type_map_fn.base) and issubclass(type_map_fn.base, TypeMap):
    return type_map_fn.base.map_type(type_map_expr)

parser = argparse.ArgumentParser(
                    prog='Python Exec',
                    description='Executes python code')

parser.add_argument('-s', '--symbol-table')
parser.add_argument('-m', '--map-type', dest='map_type_args', nargs=1)

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
  except Exception as e:
    stderr_old.write(traceback.format_exc())
    stderr_old.flush()
    raise e
