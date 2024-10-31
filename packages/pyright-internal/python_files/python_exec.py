import argparse
import os
import sys
import traceback
from types import ModuleType

from mypyright_extensions import map_type


def exec_map_type(type_map: str, exec_module: ModuleType):
  compiled = compile(type_map, 'map_type.py', 'exec')
  exec(compiled, exec_module.__dict__)
  return map_type(exec_module._mypyright_type_map_t)

parser = argparse.ArgumentParser(
                    prog='Python Exec',
                    description='Executes python code')

parser.add_argument('-f', '--file')           # file being analyzed to be imported as a module
parser.add_argument('-m', '--map-type', dest='command', action='store_const', const='map-type')

def indent(code: str) -> str:
  return '\n'.join(['\t' + line for line in code.splitlines()])

if __name__ == "__main__":
  stdout_old = sys.stdout
  stderr_old = sys.stderr
  sys.stderr = sys.stdout = open(os.devnull, 'w')

  try:
    args = parser.parse_args()

    sys.path.append(os.path.dirname(os.path.abspath(args.file)))

    exec_module = ModuleType('python_exec_module')
    with open(args.file) as f:
      code = compile(f.read(), args.file, 'exec')
      exec(code, exec_module.__dict__)

    code = sys.stdin.read()

    if args.command == 'map-type':
      result = exec_map_type(code, exec_module)
      stdout_old.write(result)
      stdout_old.flush()
  except Exception as e:
    stderr_old.write(traceback.format_exc())
    stderr_old.flush()
    raise e
