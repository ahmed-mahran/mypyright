import argparse
import os
import sys
import traceback
from types import ModuleType


def exec_map_type(type_map: str, type_map_expr: str, exec_module: ModuleType):
  return getattr(exec_module, type_map).map_type(type_map_expr)

parser = argparse.ArgumentParser(
                    prog='Python Exec',
                    description='Executes python code')

parser.add_argument('-f', '--file')           # file being analyzed to be imported as a module
parser.add_argument('-m', '--map-type', dest='map_type_args', nargs=2)

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

    sys.path.append(os.path.dirname(os.path.abspath(args.file)))

    exec_module = ModuleType('python_exec_module')
    with open(args.file) as f:
      code = compile(f.read(), args.file, 'exec')
      exec(code, exec_module.__dict__)

    code = sys.stdin.read()

    if args.map_type_args is not None:
      result = exec_map_type(args.map_type_args[0], args.map_type_args[1], exec_module)
      stdout_old.write(result)
      stdout_old.flush()
  except Exception as e:
    stderr_old.write(traceback.format_exc())
    stderr_old.flush()
    raise e
