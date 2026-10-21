# Core Java

## Objects, equality, strings
- `==` compares references for objects and values for primitives. `equals()` compares logical equality.
- **equals/hashCode contract**: equal objects must have equal hash codes. Equal hash codes don't imply equal objects. Override both or neither.
- Don't put mutable fields into `hashCode()` of an object used as a `HashMap` key or `HashSet` element. Change the field and the entry is lost in the wrong bucket.
- **String is immutable**: safe to share between threads, hash code is cached, safe as a map key, enables the string pool.
- String literals are interned in the pool. `new String("a")` always creates a new object, and `intern()` returns the pooled instance.
- Concatenation in a loop: use `StringBuilder`. A single `a + b + c` expression is compiled to `invokedynamic` (`StringConcatFactory`, Java 9+).
- **Integer cache**: `Integer.valueOf` (and so autoboxing) caches -128..127. `Integer a = 128, b = 128; a == b` is `false`.
- Unboxing `null` throws `NullPointerException`, e.g. `int x = map.get(key);`.
- `Long.valueOf(1).equals(1)` is `false`: an `Integer` is never equal to a `Long`.

## Methods and parameters
- Java is **always pass-by-value**. For objects the *reference* is copied: you can mutate the object, but reassigning the parameter doesn't affect the caller.
- **Overloading** is resolved at compile time by static types; the most specific signature wins (`m(null)` picks `String` over `Object`).
- **Overriding** is resolved at runtime (dynamic dispatch). Static methods are *hidden*, not overridden: the declared type decides.
- An override can't reduce visibility or throw broader checked exceptions; it may narrow the return type (covariant return).

## Classes and OOP
- Access: `private` < package-private < `protected` (package + subclasses) < `public`.
- `final` class: can't be extended. `final` method: can't be overridden. `final` variable: assigned once, but the object it points to can still be mutable.
- **Abstract class vs interface**: an abstract class has state, constructors and single inheritance. An interface has no instance state, a class can implement many, and it has `default`/`static` (Java 8) and `private` (Java 9) methods.
- Two interfaces with the same `default` method: the class must override it (it can call `A.super.m()`), otherwise it's a compile error.
- **Initialization order**: parent static → child static (once, on class init) → parent instance initializers + constructor → child instance initializers + constructor.
- **Immutable class recipe**: `final` class, `private final` fields, no setters, defensive copies of mutable inputs and outputs, `this` doesn't escape the constructor.

## Exceptions
- `Throwable` → `Error` (don't catch: OOM, StackOverflow) and `Exception`. `RuntimeException` and its subclasses are unchecked; other exceptions are checked and must be caught or declared.
- `finally` always runs, except on `System.exit()`, a JVM crash or a killed thread. `return` inside `finally` overrides the try's return *and* swallows exceptions: never do it.
- **try-with-resources**: works with any `AutoCloseable`, closes resources in reverse order. If the body and `close()` both throw, the body's exception propagates and `close()`'s is attached via `getSuppressed()`.

## Generics
- **Type erasure**: generic types don't exist at runtime. No `new T()`, no `instanceof List<String>`, no `T[]` creation; the compiler inserts casts and bridge methods.
- Generics are **invariant**: `List<String>` is not a `List<Object>`. Arrays are **covariant**: `Object[] a = new String[1]; a[0] = 1;` compiles and throws `ArrayStoreException`.
- **PECS** (Producer Extends, Consumer Super): read from `List<? extends T>`, write to `List<? super T>`.

## Modern Java (8 → 21)
- **Lambdas** + functional interfaces: `Function`, `Supplier`, `Consumer`, `Predicate`, `BiFunction`, and method references.
- **Streams**: lazy, nothing runs without a terminal operation, and a stream is single-use. `map` is 1:1, `flatMap` is 1:N. `Collectors.toMap` throws `IllegalStateException` on a duplicate key unless you pass a merge function.
- **Optional**: for return types, not fields or parameters. `orElse(x)` evaluates `x` eagerly; `orElseGet(supplier)` only when empty.
- `var` (10), text blocks (15), records (16), pattern matching for `instanceof` (16), sealed classes (17), pattern matching for `switch` (21), virtual threads (21).
- **Records**: final class, `private final` fields, generated constructor/accessors/`equals`/`hashCode`/`toString`. They can't extend a class or declare extra instance fields, but can implement interfaces and have a compact constructor for validation.
- **Sealed** types: `permits` lists the allowed subclasses, so `switch` over them can be exhaustive without `default`.

## Odds and ends
- `Comparable.compareTo` defines natural order; `Comparator` defines external orders (`Comparator.comparing(...).thenComparing(...)`).
- Serialization: `serialVersionUID` for version compatibility, `transient` fields are skipped.
- `char + int` is numeric: `'a' + 1 == 98`, but `"" + 'a' + 1` is `"a1"`.
