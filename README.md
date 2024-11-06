![MyPyright](https://github.com/ahmed-mahran/mypyright/blob/main/docs/img/MyPyrightLarge.png)

[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/mashin.mypyright?logo=visual%20studio%20code)
](https://marketplace.visualstudio.com/items?itemName=mashin.mypyright)
[![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/mashin.mypyright?logo=visual%20studio%20code)
](https://marketplace.visualstudio.com/items?itemName=mashin.mypyright)

# Static Type Checker for Tensors

This is a fork of [Pyright](https://github.com/microsoft/pyright) with added features beyond accepted [typing PEPs](https://peps.python.org/topic/typing/) to support [typed tensors](https://github.com/ahmed-mahran/typedtensor).

___

# What is extra?

- [Multiple Unpackings of Type Arguments](#multiple-unpackings-of-type-arguments)
- [Type Transformations of Variadic Type Variables](#type-transformations-of-variadic-type-variables)
- [Subscriptable Functions](#subscriptable-functions)
- [Static Type Programming (Type Macros)](#static-type-programming-type-macros)
  - [Static Type Transformations (Type Maps)](#static-type-transformations-type-maps)

___

# Multiple Unpackings of Type Arguments

[PEP-646](https://peps.python.org/pep-0646/#multiple-unpackings-in-a-tuple-not-allowed) did not allow multiple unpackings of tuples or type var tuples in tuple type arguments. E.g. only one unpacking may appear in a tuple:

```python
x: Tuple[int, *Ts, str, *Ts2]  # Error
y: Tuple[int, *Tuple[int, ...], str, *Tuple[str, ...]]  # Error
```

However, this is not true for any generic class specializations (at least in Pyright):

```python
class MyGenericClass[*Ps]: ...

x: MyGenericClass[int, *Ts, str, *Ts2]  # Ok
def fn(y: MyGenericClass[int, *Tuple[int, ...], str, *Tuple[str, ...]]): ...  # Ok
```

However, the matching logic of type arguments lists with multiple unpackings of tuples or type var tuples doesn't work as expected or, more precisely, doesn't take into consideration having more than one unpacking.

That's for a valid reason; matching can be ambigious. E.g. if in one hand you have a variable of type `tuple[*As, *Bs]` being assigned a value of type `tuple[int, int]`, then there are more than one valid matching solution:

- `*As = *tuple[int, int]` and `*Bs = *tuple[()]`
- `*As = *tuple[int]` and `*Bs = *tuple[int]`
- `*As = *tuple[()]` and `*Bs = *tuple[int, int]`

It is not clear though why multiple unpackings of determinate tuples is not allowed. E.g. the following has no ambiguity issues however is not allowed:

```python
y: Tuple[int, *Tuple[int, str, float], str, *Tuple[str, ...]]  # Error
y: Tuple[int, *Tuple[int, str, float], str, *Tuple[str, int]]  # Error
```

Also, there are applications where multiple variadic matching is required. Typed tensor operations is a great example, see [typedtensor](https://github.com/ahmed-mahran/typedtensor?tab=readme-ov-file#multiple-variadic-generics).

MyPyright implements a generic matching logic of type arguments lists and allows to have multiple unpackings of determinate and indeterminate tuples as well as type var tuples. MyPyright solves the ambiguity issue by making the matching eager, i.e. the variadic entry matches the maximum number of entries it could match. There are possible other solutions:

- Report error for ambigious cases only.
- Implement lazy matching.
- Have a type checker configuration to choose different ambiguity resolution stratigies, e.g.: error, lazy or eager.
- Add a typing extension to choose the resolution strategy.
- Add a typing extension implementing regex-like quantifiers.

The following examples show how MyPyright handles different cases with multiple unpackings:

```python
class Singular1: ...
class Repeated1: ...
class Singular2: ...
class Repeated2: ...

def a(param: tuple[Singular1, *tuple[Repeated1, ...], Singular2, *tuple[Repeated2, ...]]): ...

def valid1() -> tuple[Singular1, Singular2]: ...
a(valid1()) # Ok

def valid2() -> tuple[Singular1, *tuple[Repeated1, ...], Singular2]: ...
a(valid2()) # Ok

def valid3() -> tuple[Singular1, *tuple[Repeated1, ...], Singular2, *tuple[Repeated2, ...]]: ...
a(valid3()) # Ok

def valid4() -> tuple[Singular1, Repeated1, Singular2, Repeated2]: ...
a(valid4()) # Ok

def invalid1() -> tuple[Singular1]: ...
a(invalid1()) # Error

def invalid2() -> tuple[Repeated2, Singular1, Singular2]: ...
a(invalid2()) # Error

def invalid3() -> tuple[Singular1, Singular2, Repeated1, Repeated2]: ...
a(invalid3()) # Error

class Mark1: ...
class Mark2: ...

def b[*A, *B](param: tuple[Mark1, *A, Mark2, *B]) -> tuple[tuple[*A], tuple[*B]]: ...

def b1() -> tuple[Mark1, Mark2]: ...
reveal_type(b(b1())) # tuple[tuple[()], tuple[()]]

def b2() -> tuple[Mark1, *tuple[int, ...], Mark2]: ...
reveal_type(b(b2())) # tuple[tuple[int, ...], tuple[()]]

def b3() -> tuple[Mark1, *tuple[int, ...], Mark2, *tuple[str, ...]]: ...
reveal_type(b(b3())) # tuple[tuple[int, ...], tuple[str, ...]]

def b4() -> tuple[Mark1, int, Mark2, str]: ...
reveal_type(b(b4())) # tuple[tuple[int], tuple[str]]

def b5() -> tuple[Mark1, Mark2, Mark2, Mark2, Mark2, str]: ...
reveal_type(b(b5())) # tuple[tuple[Mark2, Mark2, Mark2], tuple[str]]

def b6() -> tuple[Mark1, Mark2, Mark2, Mark2, Mark2]: ...
reveal_type(b(b6())) # tuple[tuple[Mark2, Mark2, Mark2], tuple[()]]
```

## Subscripted Variadic Type Variables

Variadic generics [PEP-646](https://peps.python.org/pep-0646/) doesn't handle [splitting](https://typing.readthedocs.io/en/latest/spec/generics.html#typevartuples-cannot-be-split). Consider the following pattern:

```python
def vvs[V, *Vs](vvsparam: tuple[V, *Vs]) -> tuple[V, *Vs]:
  return vvsparam

def dsd[*Ds, D](dsdparam: tuple[*Ds, D]) -> tuple[*Ds, D]:
  _x = vvs(dsdparam)
  reveal_type(_x)  # MyPyright: tuple[Ds[0]@dsd, *Ds[1:]@dsd, D@dsd]
                   #   Pyright: tuple[Union[*Ds@dsd], D@dsd]
  return _x        # Pyright: Error!
```

The problem is in calculating the type of `_x`. `vvs` function accepts parameter with type params `[V, *Vs]` however in `dsd` we are passing to `vvs` an argument with type arguments `[*Ds, D]`. We somehow need to match `[V, *Vs]` with `[*Ds, D]`, i.e. we need to determine which type value `V` and `*Vs` will be.

To further highlight the problem, let's first consider we are assiging `[D, *Ds]` to `[V, *Vs]`  instead. It is clear that `V`, a singular type var, can be assigned `D`, the corresponding singular type var, and `*Vs`, the variadic type var, can be assigned `*Ds`, the corresponding variadic type var.

Now back to the case of assiging `[*Ds, D]` to `[V, *Vs]`. We have the following possibilities:

- `*Vs` and `*Ds` could match zero types and hence effectively `V` matches `D` but this is not a **generic** assignment as we have completely ignored `*Vs`.
- `*Vs` and `*Ds` each could match one type and hence effectively `V` matches `*Ds` and `*Vs` matches `D` but how is it possible to assign `*Ds` to `V`, so this is not a **valid** assignment.
- `V` matches the first type of `*Ds`: `Ds[0]`,  and `*Vs` matches the rest of `*Ds` and `D`: `*Ds[1:], D`. This way we have got a **valid generic** assignment of `V` and `*Vs`.

  ```python
  [ V     ], [ *Vs        ]
  [ Ds[0] ], [ *Ds[1:], D ]
  ```

MyPyright detects this pattern and internally uses subscripted variadic type variables to resolve a valid and generic assignment of type variables. Note that in the above example, the sequence `Ds[0]@dsd, *Ds[1:]@dsd` is equivalent to `*Ds@dsd`. MyPyright detects that and hence `return _x` is valid as it complies with annotated return type.

Another but more complicated example:

```python
def vs[V1, V2, *Vs](x: Tuple[V1, *Vs, V2]) -> Tuple[V1, *Vs, V2]: ...
    
def ds[D1, D2, *Ds, *Ps](x: Tuple[*Ds, D1, D2, *Ps]) -> Tuple[*Ds, D1, D2, *Ps]:
  _x = vs(x) # MyPyright: Tuple[Ds[0]@ds, *Ds[1:]@ds, D1@ds, D2@ds, *Ps[:-1]@ds, Ps[-1]@ds]
             #   Pyright: Tuple[Union[*Ds@ds], D1@ds, D2@ds, Union[*Ps@ds]]
  return _x  # Pyright: Error!
```

MyPyright resolves to this assignment:

```python
[ V1    ], [ *Vs                       ], [ V2     ]
[ Ds[0] ], [ *Ds[1:], D1, D2, *Ps[:-1] ], [ Ps[-1] ]
```

Remember that matching for variadic type variables is eager, that's why `*Vs` is matching as many variables as possible.

### Subscript Variables

Another more interesting example:

```python
def vs[*Init, V1, *Mid, V2, *Tail](
  x: Tuple[*Init, V1, *Mid, V2, *Tail]
) -> Tuple[*Init, V1, *Mid, V2, *Tail]: ...
    
def ds[D1, D2, *Ds, *Ps](
  x: Tuple[*Ds, D1, D2, *Ps]
) -> Tuple[*Ds, D1, D2, *Ps]:
  _x = vs(x) # MyPyright: Tuple[*Ds@ds, D1@ds, D2@ds, *Ps[:i0]@ds, Ps[i0]@ds, *Ps[i0 + 1:i1]@ds, Ps[i1]@ds, *Ps[i1 + 1:]@ds]
             #   Pyright: Tuple[Union[*Ds@ds], D1@ds, D2@ds, *Ps@ds]
  return _x  # Pyright: Error!
```

```python
[ *Init                 ], [ V1     ], [ *Mid           ], [ V2     ], [ *Tail        ]
[ *Ds, D1, D2, *Ps[:i0] ], [ Ps[i0] ], [ *Ps[i0 + 1:i1] ], [ Ps[i1] ], [ *Ps[i1 + 1:] ]
```

It is possible for a variadic type variable to match a composition of singular and variadic type variables. In this case, singular type variables would be assigned singular indices from the variadic type variable. However, other variadic type variables would be assigned unknown length slices. Therefore, MyPyright introduces subscript variables to annotate indices and bounds of slices.

In this context, it is sufficient to know the following:

- `*Init` is assigned some slice `*Ps[:i0]` from the begining of `*Ps` until the `i0`'th index.
- `V1` is assigned an index just after the previous slice, `Ps[i0]`.
- `*Mid` is the next variadic type variable and is assigned another generic slice `*Ps[i0 + 1:i1]` starting from the next available index `i0 + 1` until the `i1`'th index.
- `V2` is the next singular type variable which is assigned the next available adjacent index to the end of `*Mid` which is the `i1`'th index.
- Finally `*Tail` is assigned the rest of `*Ps` from the next available index `i1 + 1` till the end.

___

# Type Transformations of Variadic Type Variables

This is, in short, is about allowing type hinting transformations on individual type elements of a variadic type variable.

For example, without variadic transformations:

```python
def fn[*Ts](*param: *Ts) -> Tuple[*Ts]: ...
reveal_type(fn(int, str)) # Tuple[Type[int], Type[str]]
```

There is no way to capture `int` and `str` by `*Ts` by passing as arguments class types `int` and `str`. `*Ts`, as any function parameter, always captures the types of the passed arguments. `fn(param: int)` accepts instances of `int`: `1`, `2` or `x: int`. While `fn(param: Type[int])` accepts instances of `Type[int]` which is the `int` class.

It is possible to make this distinction in case of type variables:

```python
def fn[T](param: T) -> Tuple[T]: ...
reveal_type(fn(int)) # Tuple[Type[int]]
```

The above can be re-written by applying a type transform of type `Type`:

```python
def fn[T](param: Type[T]) -> Tuple[T]: ...
reveal_type(fn(int)) # Tuple[int]
```

However, this is not currently possible with variadic generics. This is what this new feature is about.

## `Map[F, *Ts]`

Similar to [this PEP draft](https://docs.google.com/document/d/1szTVcFyLznoDT7phtT-6Fpvp27XaBw9DmbTLHrB6BE4/edit), MyPyright adds a new typing extension, `Map[F, *Ts]`, where `F` must be a generic class of at least one type parameter. The first type parameter will be specialized for each type of `*Ts`.

```python
from mypyright_extensions import Map

def fn[*Ts](*param: *Map[Type, *Ts]) -> Tuple[*Ts]: ...
reveal_type(fn(int, str)) # Tuple[int, str]
```

`Map` is transformed into a `tuple` of the tranformed types. Hence, `Map` can be treated as a `tuple`. Note that, `Map` is used for type hinting only and cannot be used to consrtuct a new tuple.

```python
def x() -> Map[Type, int, str]: ...
reveal_type(x()) # tuple[Type[int], Type[str]]
```

```python
def args_to_lists[*Ts](*args: *Ts) -> Map[List, *Ts]: ...
reveal_type(args_to_lists(1, 'a'))  # tuple[List[Literal[1]], List[Literal['a']]]
```

```python
# Equivalent to 'arg1: List[T1], arg2: List[T2], ...'
def foo[*Ts](*args: *Map[List, *Ts]) -> Tuple[*Ts]: ...
# Ts is bound to Tuple[int, str]
reveal_type(foo([1], ['a'])) # Tuple[int, str]
```

```python
# Equivalent to '-> Tuple[List[T1], List[T2], ...]'
def bar[*Ts](*args: *Ts) -> Map[List, *Ts]: ...
# Ts is bound to Tuple[float, bool]
reveal_type(bar(1.0, True)) # tuple[List[float], List[Literal[True]]]
```

```python
class Array[*Ts]: ...
class Pixels[T]: ...
class Height: ...
class Width: ...
# Array[Height, Width] -> Array[Pixels[Height], Pixels[Width]]
def add_pixel_units[*Shape](a: Array[*Shape]) -> Array[*Map[Pixels, *Shape]]: ...
reveal_type(add_pixel_units(Array[Height, Width]())) # Array[Pixels[Height], Pixels[Width]]
```

```python
def map[*Ts, R](func: Callable[[*Ts], R],
        *iterables: *Map[Iterable, *Ts]) -> Iterable[R]: ...

iter1: List[int] = [1, 2, 3,]
iter2: List[str] = ['a', 'b', 'c']
def func(a: int, b: str) -> float: ...
# Ts is bound to Tuple[int, str]
# Map[Iterable, Ts] is Iterable[int], Iterable[str]
# Therefore, iter1 must be type Iterable[int],
#        and iter2 must be type Iterable[str]
reveal_type(map(func, iter1, iter2)) # Iterable[float]
```

```python
def zip[*Ts](*iterables: *Map[Iterable, *Ts]) -> Iterator[tuple[*Ts]]: ...

l1: List[int] = [1, 2, 3]
l2: List[str] = ['a', 'b', 'c']
reveal_type(zip(l1, l2))  # Iterator[tuple[int, str]]
```

`Map` can be nested in the first argument, and in that case it is not considered as a `tuple`. This is to allow nested type transforms.

```python
class Inner[*Is]: ...
class Outer[*Os]: ...
def a() -> Map[Map[Outer, Map[Inner, Any]], int, str]: ...
def b[*Ts](x: Map[Map[Outer, Map[Inner, Any]], *Ts]) -> Outer[*Ts]: ...

reveal_type(a()) # tuple[Outer[Inner[int]], Outer[Inner[str]]]
reveal_type(b(a())) # Outer[int, str]
```

```python
class MyCont[*Items]: ...
class Dummy: ...

def a1() -> Map[Type, int, str, Dummy]: ...
def a2() -> tuple[Type[int], Type[str], Type[Dummy]]: ...
def b1[*Ts](x: Map[Type, int, str, *Ts]) -> MyCont[*Ts]: ...

reveal_type(b1(a1())) # MyCont[Dummy]
reveal_type(b1(a2())) # MyCont[Dummy]

def a3() -> tuple[tuple[int], tuple[str], tuple[Dummy]]: ...
def b2[T, *Ts](x: Map[tuple[Any], int, T, Dummy, *Ts]) -> MyCont[T, *Ts]: ...

reveal_type(b2(a3())) # MyCont[str]

def a4() -> tuple[tuple[int, float], tuple[str, float], tuple[Dummy, float]]: ...
def b4[T, *Ts](x: Map[tuple[float, float], T, *Ts]) -> MyCont[T, *Ts]: ...

reveal_type(b4(a4())) # MyCont[int, str, Dummy]
```

The following is a rather confusing example. It uses `tuple` as a type transform. Moreover, it nests `Map`s on both sides.

```python
def a1() -> Map[tuple[()], tuple[int, str], *tuple[int, str]]: ...
assert_type(a1(), tuple[tuple[tuple[int, str]], tuple[int], tuple[str]])

def a2() -> Map[tuple[()], Map[tuple[()], tuple[int, str], *tuple[int, str]]]: ...
assert_type(a2(), tuple[tuple[tuple[tuple[tuple[int, str]]], tuple[tuple[int]], tuple[tuple[str]]]])

def a3() -> Map[Map[tuple[()], Map[tuple[()], Any]], tuple[int, str], *tuple[int, str]]: ...
assert_type(a3(), tuple[tuple[tuple[tuple[int, str]]], tuple[tuple[int]], tuple[tuple[str]]])
```

Similar PEP drafts:

- [A Map Operator for Variadic Type Variables](https://docs.google.com/document/d/1szTVcFyLznoDT7phtT-6Fpvp27XaBw9DmbTLHrB6BE4/edit).
- [Type Transformations on Variadic Generics](https://discuss.python.org/t/pre-pep-considerations-and-feedback-type-transformations-on-variadic-generics/50605).

___

# Subscriptable Functions

It is common in typed tensor operations to pass dimension types as function arguments. Subscriptable functions imposes itself mainly for the following reasons:

- Type arguments are more naturally fit where type parameters are defined/expected. If you define a generic function `def fn[T](tp: Type[T])`, it feels more natural to pass a type argument such as `int` between the square brackets, i.e. `fn[int]()` instead of `fn(int)`. `cast(obj, cls)` or `cast(cls, obj)`, isn't it confusing? It is actually `cast(cls, obj)` but woulddn't `cast[cls](obj)` feel more natural? Or `obj.cast[cls]`, `obj.as[cls]`, `obj.asinstanceof[cls]` ...
- It is crucial to be able to bind certain type parameters to specific type arguments regardless from the order of function parameters. This is crucial especially in methods where `self` argument needs to be annotated using certain type parameters that appear next in method signature. Also, when multiple variadic type variables are used in `self` annotation, pre- and post-binding of a type variable can lead to different variadic type variables assignment.

Consider the following `transpose` operation which is supposed to swap two dimensions:

```python
class Tensor[*Shape]:
  def transpose[*Init, D1, *Mid, D2, *Tail](
    self: Tensor[*Init, D1, *Mid, D2, *Tail],
    d1: Type[D1],
    d2: Type[D2]
  ) -> Tensor[*Init, D2, *Mid, D1, *Tail]: ...
```

The `transpose` operation matches any tensor shape with the pattern `[*Init, D1, *Mid, D2, *Tail]`. It is only interested in the two dimensions `D1` and `D2` that will swap places in the same shape pattern to result in the shape `[*Init, D2, *Mid, D1, *Tail]`.

```python
x = Tensor[A, B, C, D]()
reveal_type(x.transpose(B, D)) # Tensor[A, B, D, C]
# Error:
# Argument of type "type[B]" cannot be assigned to parameter "d1" of type "type[C]" in function "transpose"
#  "type[B]" is not assignable to "type[C]"
```

The type checker has matched the type parameters of `self: Tensor[*Init, D1, *Mid, D2, *Tail]` first leading to the assignment: `*Init = [A, B], D1 = C, *Mid = [], D2 = D, *Tail = []`. Then by substituting these assignements in the rest of the function parameters and return type, the method signature becomes:

```python
def transpose(
  self: Tensor[*[A, B], C, *[], D, *[]],
  d1: Type[C],
  d2: Type[D]
) -> Tensor[*[A, B], D, *[], C, *[]]: ...
```

This explains the return type of `Tensor[A, B, D, C]` instead of `Tensor[A, D, C, B]`. This also explains type error in function first argument, the method expects `d1` of type `Type[C]` while the caller has passed an argument of type `Type[B]`.

This should be resolved with subscriptable functions.

```python
x = Tensor[A, B, C, D]()
reveal_type(x.transpose[B, D]()) # Tensor[A, D, C, B]
```

The type checker has matched the type parameters of `transpose` first leading to the assignment `D1 = B, D2 = D`. Then by substituting these assignements in the rest of the function parameters and return type, the method signature becomes:

```python
def transpose(
  self: Tensor[*Init, B, *Mid, D, *Tail],
  d1: Type[B],
  d2: Type[D]
) -> Tensor[*Init, D, *Mid, B, *Tail]: ...
```

Now the type checker can correctly and as intended match function parameters with arguments and infer return type. Matching arguments to parameters leads to the assignment: `*Init = [A], *Mid = [C], *Tail = []`.

## Implementation

MyPyright introduces function and method decorators as new typing extensions: `@subscriptable`, `@subscriptablefunction`, `@subscriptablemethod` and `@subscriptableclassmethod`. These convert functions/methods into objects implementing `__getitem__` dunder method. `@subscriptable` can be used with any function type or method type. Other decorators are special cases which save runtime checks performed by the general decorator `@subscriptable`.

A subscriptable function should be defined like:

```python
from mypyright_extensions import Map, subscriptable

@subscriptable
def fn1[A](tp: type[A], a: A) -> A: ...

@subscriptable
def fn2[A, B](tp: tuple[type[A], type[B]], a: A) -> tuple[A, B]: ...

@subscriptable
def fn3[A, B, *Cs](tp: Map[type, A, B, *Cs], args) -> tuple[A, B, *Cs]: ...
```

The first parameter provides runtime refied access to function type parameters. Only type parameters listed in the first function parameter can be used as subscript in function call. This gives flexibility to write generic functions that don't require all type parameters to be used as subscript at call sites. For example, the following function, `fn4`, has two type parameters `A` and `B` but only `A` can be used as subscript in call sites.

```python
@subscriptable
def fn4[A, B](tp: type[A], b: B) -> tuple[A, B]: ...

fn4[int](...) # Valid
fn4[int, str](...) # Invalid
```

The subscripted function returns a new function with the first parameter stripped. So that the caller needs to provide type arguments between the square brackets once.

```python
reveal_type(fn1[int]) # (a: int) -> int
reveal_type(fn2[int, str]) # (a: int) -> tuple[int, str]
reveal_type(fn3[int, str, int, float]) # (args: Unknown) -> tuple[int, str, int, float]
reveal_type(fn4[int]) # (b: B) -> tuple[int, B]
```

The same logic and rules apply to subscriptable methods and class methods however the type parameter must be defined first after `self` and `cls` parameters.

```python
class Tensor[*Shape]:
  @subscriptable
  def transpose[*Init, D1, *Mid, D2, *Tail](
    self: Tensor[*Init, D1, *Mid, D2, *Tail],
    tp: tuple[type[D1], type[D2]]
  ) -> Tensor[*Init, D2, *Mid, D1, *Tail]: ...

x = Tensor[A, B, C, D]()
reveal_type(x.transpose[B, D]) # () -> Tensor[A, D, C, B]
reveal_type(x.transpose[B, D]()) # Tensor[A, D, C, B]
```

### Subscriptable Overloads

`@overload` can be used to decorate subscriptable signatures.

```python
@overload
@subscriptable
def fn1[A](tp: type[A], a: A, b: None = None) -> A: ...

@overload
@subscriptable
def fn1[A, B](tp: tuple[type[A], type[B]], a: A, b: B) -> tuple[A, B]: ...

@subscriptable
def fn1[A, B](tp: tuple[type[A], type[B]] | type[A], a: A, b: B | None = None) -> tuple[A, B] | A: ...

reveal_type(fn1[int]) # (a: int, b: None = None) -> int
reveal_type(fn1[int, str]) # (a: int, b: str) -> tuple[int, str]
```

#### TBD

`subscriptable` decorators should implement dunder `__call__` method so that `@overload` can be used. However, there are two possible ways to implement `__call__` and only one should be adopted:

**1. Non-subscriptable overload:** The subscript type parameter is assumed to be `None` and the subscriptable function can be called without providing the subscript type parameter as a subscript argument or as a first call argument. If the subscriptable function doesn't define a `None` type parameter in any of its signatures, the type checker can raise an error as well as an error can be raised at runtime.

  ```python
  @overload
  @subscriptable
  def fn(tp: None, a: int) -> int: ...

  @overload
  @subscriptable
  def fn[T](tp: type[T], a: int) -> tuple[int, T]: ...

  @subscriptable
  def fn[T](tp: type[T] | None, a: int) -> tuple[int, T] | int: ...

  reveal_type(fn(1)) # int
  reveal_type(fn[str](1)) # tuple[int, str]
  ```

**2. Non-subscriptable fallback/alternative** This is to allow calling the function without providing subscript type parameters as subscript arguments but as call arguments.

  ```python
  @subscriptable
  def fn[T](tp: type[T], a: int) -> tuple[int, T]: ...

  reveal_type(fn(str, 1)) # tuple[int, str]
  reveal_type(fn[str](1)) # tuple[int, str]
  ```

### Variadic Type Variable Parameter

`TypeVarTuple` can be used as a subscriptable type parameters. This is only possible using [`Map`](#type-transformations-of-variadic-type-variables).

```python
@overload
@subscriptable
def fn2[T](tp: type[T], t: T) -> T: ...

@overload
@subscriptable
def fn2[T, *Ts](tp: Map[type, T, *Ts], t: T, *ts: *Ts) -> tuple[T, *Ts]: ...

@subscriptable
def fn2[T, *Ts](tp: Map[type, T, *Ts] | type[T], t: T, *ts: *Ts) -> tuple[T, *Ts] | T: ...

reveal_type(fn2[int]) # (t: int) -> int
reveal_type(fn2[int, str]) # (t: int, str) -> tuple[int, str]
reveal_type(fn2[int, str, float]) # (t: int, str, float) -> tuple[int, str, float]
```

## This VS [PEP 718](https://peps.python.org/pep-0718/)

[PEP 718](https://peps.python.org/pep-0718/) is also about subscriptable functions. The following are key differences:

- [PEP 718](https://peps.python.org/pep-0718/) is more native since it suggests implementing `__getitem__` method of all function types in the standard library which might have a runtime performance edge as opposed to MyPyright extensions.
- MyPyright extensions already provide refied runtime access to the type parameters while the PEP mentions this as a future extension.
- MyPyright allows partial subscriptable functions. This means that not all type parameters are required as subscript arguments. Only those defined in the first (none self or cls) parameter are required.
- Since MyPyright requires the first (none self or cls) parameter to define subscript types, it is not required to provide further function parameters that uses any of the subscript type parameters. However for some cases, in the context of [PEP 718](https://peps.python.org/pep-0718/), caller may require to provide same types twice: once as a subscript and another as a call argument which defeats the purpose of subscriptable functions.

  ```python
  @subscriptable
  def fn[T](tp: type[T]) -> T: ...
  fn[int]()

  def fn_pep718[T](tp: type[T]) -> T: ...
  fn_pep718[int](int) # Repeated use of int as subscript and call argument
  fn_pep718(int) # Caller would fallback to this
  ```

- Since MyPyright supports [transformations of variadic type variables](#type-transformations-of-variadic-type-variables), subscriptable functions are more powerful within the context of MyPyright since [`TypeVarTuple` can be used as a subscript type parameter](#variadic-type-variable-parameter).

  ```python
  def fn[*Ts](tp: Map[type, *Ts]) -> tuple[*Ts]
  reveal_type(fn[int, str]()) # tuple[int, str]

  def fn_pep718[*Ts](*args: *Ts) -> tuple[*Ts]
  reveal_type(fn_pep718[int, str](int, str)) # tuple[type[int], type[str]]
  ```

___

# Static Type Programming (Type Macros)

This is in general about programming the static type checker to allow reasoning about complex type relations. The static type checker evaluates a type annotation to produce another type expression that has a simpler form or to further restrict and narrow a given type expression.

The static type checker executes a user program at static type checking time which could be on a terminal as a side effect of executing the type checker commands, or at code edit time on the fly when the type checker is called through a language server within an IDE.

## Static Type Transformations (Type Maps)

This is about programming the static type checker to substitute a type hint with another computed type hint at static type checking time. For instance, the type checker could be programmed to transform `Add[float, int]` to a simpler form, `float`.

The computed type must be [equivalent](https://typing.readthedocs.io/en/latest/spec/glossary.html#term-equivalent) to the original type (e.g. `float` is equivalent to `Add[float, int]`). This means that both types must describe the same set of possible objects. However, the computed type could have a simpler form which result in better readability and reasoning.

The type transformation is a mapping from a domain of types to another domain of types. Since, a type is a set of objects, the domain and codomain of the mapping each is a set of sets (a set of types is a set of sets of objects). Generally, the domain is a cartesian product of sets of types and the codomain is a single set of types. For example, `tuple[T: (int, str), float]` could be seen as a mapping from `{int, str} x {float}` to the domain of tuples `{(a, b); a: int | str, b: float}`.

The mapping could define a relation between types that is not necessarily a [subtyping](https://typing.readthedocs.io/en/latest/spec/glossary.html#term-subtype) relation. For example, in `tuple[int, str]`: neither `int`, `str` nor `tuple[int, str]` can be described as subtype of one another but in fact all are disjoint types, however `tuple` has defined a cartesian product relation between `int` and `str`.

### `TypeMap[*Params]`

MyPyright introduces `TypeMap`

```python
class TypeMap[*Params]:
  @staticmethod
  def map_type(type_expr: str) -> str: ...
```

`TypeMap` is a marker interface to define the type mapping logic through implementation of `map_type` static method. `type_expr` is a string representation in python syntax of the original type expression, e.g. `Add[float, int]`. User can [parse](https://docs.python.org/3/library/ast.html#ast.parse) `type_expr` to construct an [AST](https://docs.python.org/3/library/ast.html#ast.AST). Constructing a runtime representation by [compiling](https://docs.python.org/3/library/functions.html#compile) and [evaluating](https://docs.python.org/3/library/functions.html#eval) the `type_expr` is discouraged mainly as some identifiers might be unresolvable given the scope of evaluation (e.g. type variables using the new syntax will not be in the scope of evaluation). The user then can extract type arguments on which the computed type depends. Those are the type arguments given at the map usage site, e.g. `float` and `int` in case of `Add[float, int]`. `map_type` returns a string representation in python syntax of the computed either type expression or type definition. The user can construct the type expression by string composition or by transforming the AST and converting to python syntax calling [ast.unparse()](https://docs.python.org/3/library/ast.html#ast.unparse).

### Returning a type expression

In the following example, `map_type` returns a type expression. `Add` computes the lowest bound type when adding two variables of numeric types (only `int`, `float` and `Literal` are handled). `Add[A, B]` is a type map `Add: {int, float, Literal} x {int, float, Literal} -> {int, float, Literal}`.

```python
import ast
from mypyright_extensions import TypeMap

class Add[A, B](TypeMap):
  @staticmethod
  def map_type(type_expr: str) -> str:
    tree = cast(ast.Expr, ast.parse(type_expr).body[0]).value
    match tree:
      case ast.Subscript(value=ast.Name(id='Add'), slice=ast.Tuple(elts=[a, b])):
        match (a, b):

          case (ast.Name(id='float'), _) | (_, ast.Name(id='float')):
            return 'float' # float type expression
          
          case (ast.Name(id='int'), _) | (_, ast.Name(id='int')):
            return 'int' # int type expression
          
          case _:
            current_a = a
            current_b = b
            type_depth = 0
            while True:
              match (current_a, current_b):
                case (
                  ast.Subscript(value=ast.Name(id='type'), slice=slice_a),
                  ast.Subscript(value=ast.Name(id='type'), slice=slice_b)
                  ):
                  current_a = slice_a
                  current_b = slice_b
                  type_depth += 1
                case (
                  ast.Subscript(value=ast.Name(id='Literal'), slice=ast.Constant(value=value_a)),
                  ast.Subscript(value=ast.Name(id='Literal'), slice=ast.Constant(value=value_b))
                  ):
                  return (
                    ''.join(['type['] * type_depth) +
                    f'Literal[{value_a + value_b}]' +
                    ''.join([']'] * type_depth)
                   ) # Literal type expression
                case _:
                  break
    
    return origin # the original type expression

def add[A, B](a: A, b: B) -> Add[A, B]: ...

reveal_type(add(1, 2)) # int
reveal_type(add(1.0, 2)) # float
reveal_type(add(type[Literal[1]], type[Literal[5]])) # type[type[Literal[6]]]
```

### Returning a type definition

In the following example, `Sub[T]` computes a [nominal subtype](https://typing.readthedocs.io/en/latest/spec/concepts.html#nominal-and-structural-types) of the input type `T` as `map_type` returns a definition of a new (dummy) type with type `T` as a base class. Using a type definition instead of a type expression helps defining relations of maps to certain abstract type structures. This applies in cases where the [structure](https://typing.readthedocs.io/en/latest/spec/concepts.html#nominal-and-structural-types) of the type is of significance than its [name](https://typing.readthedocs.io/en/latest/spec/concepts.html#nominal-and-structural-types).

```python
import ast
from mypyright_extensions import TypeMap

class Sub[T](TypeMap):
  @staticmethod
  def map_type(type_expr: str) -> str:
    bases = ast.unparse(cast(ast.Subscript, cast(ast.Expr, ast.parse(type_expr).body[0]).value).slice)
    name = 'Sub_' + bases.replace('[', '_').replace(']', '_').replace(',', '_').replace(' ', '')
    return f"class {name}({bases}): pass"


class DumDum: ...

def give_me_dumdum() -> DumDum: ...
def give_me_dumdum_child() -> Sub[DumDum]: ...
def consume_dumdum(x: DumDum): ...

consume_dumdum(give_me_dumdum()) # OK
consume_dumdum(give_me_dumdum_child()) # OK

reveal_type(give_me_dumdum_child()) # Sub_DumDum
```

### Function Call Analogy

Using a `TypeMap` implementation, e.g. `Add[float, T]`, as a type hint is analogous to a function call, e.g. `add(1.0, t)`. Similar to a function call where values and variables are provided as arguments within parentheses, a `TypeMap` is applied as a type hint in generics syntax where type arguments are provided within square brackets.

|               | Function             | TypeMap                  |
|---------------|----------------------|--------------------------|
|**Example**    | `add(1.0, t)`        | `Add[float, T]`          |
|**Application**| function call        | type hint                |
|**Arguments**  | values and variables | types and type variables |
|**Enclosing**  | parentheses          | square brackets          |

### TBD

The following are points for further considerations to be thoroughly investigated and looked for.

#### Marker interface or a `Protocol`

`Protocol` is the pythonic way to do it. It is enough to define a `map_type` static method to enable type mapping magic rather than needing to import and explicitly extend the marker interface `TypeMap`.

#### Type representation

Types passed in or out of `map_type` method must be in a representation that both the user and the type checker understands. The type checker must understand it because the type checker will produce arguments and process returns, and the user must understand it because the user will process arguments and produce returns. Since every one/thing in this equation understands python, representations in python syntax is a natural choice.

Constructing return types (either expressions or definitions) via composition of literal strings is not ideal but in fact is more error-prone as strings are not checked for syntax nor for type correctness and in general is not processed as a piece of code in the development environment.

On the other hand, using runtime type representations as input arguments makes it easier and natural for python user. Also, it provides refied access to lots of type information that are not available given the type expression alone (like whether an identifier refers to a type variable or an object of a specific class) and might be necessary to construct the new type. However, this poses a challenge on the static type checker to produce such representation given type expressions and definitions and could possibly lead to unnecessary code execution if the checker to depend on the interpreter.

This is in general a problem of code generation, and could be handled by consrtuction or manipulation of [ASTs](https://docs.python.org/3/library/ast.html) by directly dealing with ASTs or through a friendly [quasi-quotes](https://docs.scala-lang.org/overviews/quasiquotes/intro.html) representation.

Some extra type context information could be provided along with type expression.

#### `__class_getitem__` or `map_type`

Overriding `__class_getitem__` is indeed a plausible option. [The purpose of `__class_getitem__`](https://docs.python.org/3/reference/datamodel.html#the-purpose-of-class-getitem) is to allow type hinting of custom generic classes and using `__class_getitem__` on any class for purposes other than type hinting is discouraged. This makes it less susceptible to backward compatibility issues. However, `__class_getiem__` is expected to return `GenericAlias` object to be considered [properly defined](https://docs.python.org/3/reference/datamodel.html#class-getitem-versus-getitem).

#### Runtime

Runtime type checkers could simply opt-in by executing the type map to compute the new type.

#### Code Organization

Type checker executes `map_type` which is a python code. This requires a convention for determining a python interpreter and a working directory. Consider the following file structure:

- `edit.py`: is the file being edited or type checked which references and imports a type transformation (like `Add[A, B]`).
- `typemap.py`: is the file containing the type transformation implementation.

According to how python interpreter works, the whole python file `edit.py` must be executed and so all files of imported modules, and modules in imported modules, and so on recursively. This will lead to unnecessary code execution causing unintended behaviour and side effects at type check time as well as degrading the type checker performance.

A carefull convention must be set and followed to enforce separation and to reduce the scope of type checker executed code. Maybe a separate macros package could help the type checker in both purposes of executing and checking only macros code.

<!-- ### Static Type Predicates (Refinement Types) -->



<!-- # Publishing on VSCode Marketplace

**TL;DR** VSCode marketplace has removed the extension and locked my account without notice.

- [2024-08-22] Published first version on VSCode.

- [2024-09-11] Last successfully published version. I've received a confirmation email

  > Extension validation is complete for your extension MyPyright (mashin.mypyright). No issues were observed and the version 1.3.0 is available for use in Visual Studio Marketplace.

- [2024-09-16] I opened an issue on original repo [microsoft#9010](https://github.com/microsoft/pyright/issues/9010) with suggested approach [PR#1](https://github.com/ahmed-mahran/mypyright/pull/1).

- [2024-09-18] I found by chance that `MyPyright` extension is no longer available on VSCode marketplace and my account has got rate-limited and I no longer can open the marketplace using my account.

- [2024-09-19] I've renamed the repo from `pyright` to `mypyright` and changed all artwork just in case if it was a branding issue. Initially, I kept original branding to honor `pyright` stakeholders and maintainers.

- [2024-09-19] After emailing the support team, I received this response:

  > We have locked the extension after a thorough investigation due to security and privacy concerns. -->
