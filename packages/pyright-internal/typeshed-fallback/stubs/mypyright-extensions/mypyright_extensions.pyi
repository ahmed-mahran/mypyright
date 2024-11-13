from abc import ABC
import ast
from types import ModuleType, NoneType
from typing import TYPE_CHECKING, Callable, Protocol, Self, Type

if TYPE_CHECKING:
  from typing import type_check_only

class _MyPyright(ABC):
  ...

@type_check_only
class Map[F, *Ts](_MyPyright):
  ...

class _SubscriptableFunctionSingle[T, **P, R](Protocol):
  def __call__(self, tp: Type[T], /, *args: P.args, **kwargs: P.kwargs) -> R: ...

class _SubscriptableFunctionVariadic[*Ts, **P, R](Protocol):
  def __call__(self, tp: Map[Type, *Ts], /, *args: P.args, **kwargs: P.kwargs) -> R: ...

class _SubscriptableMethodSingle[Owner, T, **P, R](Protocol):
  def __call__(self, instance: Owner, tp: Type[T], /, *args: P.args, **kwargs: P.kwargs) -> R: ...

class _SubscriptableMethodVariadic[Owner, *Ts, **P, R](Protocol):
  def __call__(self, instance: Owner, tp: Map[Type, *Ts], /, *args: P.args, **kwargs: P.kwargs) -> R: ...

class _SubscriptableClassMethodSingle[Owner, T, **P, R](Protocol):
  def __call__(self, owner: Type[Owner], tp: Type[T], /, *args: P.args, **kwargs: P.kwargs) -> R: ...

class _SubscriptableClassMethodVariadic[Owner, *Ts, **P, R](Protocol):
  def __call__(self, owner: Type[Owner], tp: Map[Type, *Ts], /, *args: P.args, **kwargs: P.kwargs) -> R: ...

class subscriptable[Owner, T, *Ts, **P, R]:
  def __init__(
      self,
      fn: (
        _SubscriptableFunctionVariadic[*Ts, P, R] |
        _SubscriptableFunctionSingle[T, P, R] |
        _SubscriptableMethodVariadic[Owner, *Ts, P, R] |
        _SubscriptableMethodSingle[Owner, T, P, R] |
        _SubscriptableClassMethodVariadic[Owner, *Ts, P, R] |
        _SubscriptableClassMethodSingle[Owner, T, P, R]
      )
  ) -> None: ...
  
  def __get__(self, instance: Owner | None, owner: Type[Owner]) -> Self: ...

  def __getitem__(self, tp: Map[Type, *Ts] | Type[T]) -> Callable[P, R]: ...
  
  def __call__(self, tp: Map[Type, *Ts] | Type[T], *args: P.args, **kwargs: P.kwargs) -> R: ...

class subscriptablefunction[T, *Ts, **P, R]:
  def __init__(self, fn: _SubscriptableFunctionVariadic[*Ts, P, R] | _SubscriptableFunctionSingle[T, P, R]) -> None: ...

  def __getitem__(self, tp: Map[Type, *Ts] | Type[T]) -> Callable[P, R]: ...

  def __call__(self, tp: Map[Type, *Ts] | Type[T], *args: P.args, **kwargs: P.kwargs) -> R: ...

class subscriptablemethod[Owner, T, *Ts, **P, R]:
  def __init__(self, fn: _SubscriptableMethodVariadic[Owner, *Ts, P, R] | _SubscriptableMethodSingle[Owner, T, P, R]) -> None: ...

  def __get__(self, instance: Owner, owner: Type[Owner]) -> Self: ...

  def __getitem__(self, tp: Map[Type, *Ts] | Type[T]) -> Callable[P, R]: ...

  def __call__(self, tp: Map[Type, *Ts] | Type[T], *args: P.args, **kwargs: P.kwargs) -> R: ...

class subscriptableclassmethod[Owner, T, *Ts, **P, R]:
  def __init__(self, fn: _SubscriptableClassMethodVariadic[Owner, *Ts, P, R] | _SubscriptableClassMethodSingle[Owner, T, P, R]) -> None: ...

  def __get__(self, instance: NoneType, owner: Type[Owner]) -> Self: ...

  def __getitem__(self, tp: Map[Type, *Ts] | Type[T]) -> Callable[P, R]: ...

  def __call__(self, tp: Map[Type, *Ts] | Type[T], *args: P.args, **kwargs: P.kwargs) -> R: ...

#################################################################################################
def print_type(tp: type) -> str: ...

class TypeAsFunction[T, Result]:
  base: type[T] | ast.expr
  args: list[TypeAsFunction[T, Result]]
  result: Result | None = None

  def __init__(self, base: type[T] | ast.expr, args: list[TypeAsFunction[T, Result]] | None = None, result: Result | None = None): ...

  def __repr__(self): ...

class SymbolTable[T]:
  symbol_table: dict[str, str]
  reference_table: dict[str, type[T]]
  processed_files: set[str]
  module: ModuleType

  def __init__(self, symbol_table: str | dict[str, str]) -> None: ...

  def resolve_reference(self, reference: str) -> type[T] | None: ...

def resolve_types[T, Result](
    expr: ast.expr,
    symbol_table: SymbolTable[T],
    default_result: Result | None = None
  ) -> TypeAsFunction[T, Result]: ...

def parse_type_expr(type_expr: str) -> ast.expr: ...

class TypeMap[*Params](ABC):
  @staticmethod
  def map_type(type_expr: str) -> str: ...
