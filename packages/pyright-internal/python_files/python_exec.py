import sys
from types import ModuleType


if __name__ == "__main__":
  code = sys.stdin.read()
  compiled = compile(code, 'python_exec.py', 'exec')
  module = ModuleType('python_exec_module')
  exec(compiled, module.__dict__)
  result = module.main()
  print(result)
