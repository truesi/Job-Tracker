# Core Java: deep dive

This page goes deeper on the short notes, section by section. Each section ends with links to the primary sources (JLS, JEPs, javadoc).

## Objects, equality, strings

### The equals/hashCode contract
`equals` must be **reflexive**, **symmetric**, **transitive** and **consistent**, and `x.equals(null)` must be `false`. `hashCode` must return the same value while the fields used by `equals` don't change, and equal objects must have equal hash codes.

```java
@Override
public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof Money m)) return false;
    return amount == m.amount && Objects.equals(currency, m.currency);
}

@Override
public int hashCode() {
    return Objects.hash(amount, currency);
}
```

- **Symmetry trap**: a subclass that adds a value field (`ColorPoint extends Point`) can't keep the contract. `point.equals(colorPoint)` is true while `colorPoint.equals(point)` is false. With `instanceof` you break symmetry; with `getClass() != o.getClass()` you break Liskov substitution. Prefer composition, `final` classes or records.
- **How HashMap uses it**: hash = `h ^ (h >>> 16)` (spreads high bits), bucket index = `(n - 1) & hash`, then within the bucket it compares the hash, then `==`, then `equals`. A bad `hashCode` (e.g. a constant) turns every lookup into a scan of one bucket.

### String pool, constants and immutability
The pool has been in the regular heap since Java 7, so it's garbage-collected. Literals and **compile-time constants** are interned automatically:

```java
String a = "ab";
String b = "a" + "b";        // constant expression, folded by javac: same object as a
String part = "a";
String c = part + "b";       // computed at runtime: new object
final String fin = "a";
String d = fin + "b";        // fin is a constant variable, so this is folded too
System.out.println((a == b) + " " + (a == c) + " " + (a == d));  // true false true
```

- **Compact strings** (Java 9): a Latin-1-only string is stored as one byte per char in a `byte[]`, otherwise UTF-16.
- **String deduplication** in G1 (`-XX:+UseStringDeduplication`) shares the backing arrays of equal strings. It doesn't make `==` true.
- Immutability gives: cached `hashCode`, safe map keys, thread safety without locks, and security (class names, file paths and URLs can't be changed after validation).

### Boxing, caches and the ternary NPE
- JLS 5.1.7 requires boxed values in -128..127 (plus `boolean`, and `char` up to `\u007f`) to be identical. `Integer`'s upper bound can be raised with `-XX:AutoBoxCacheMax`. `Byte`, `Short`, `Long` and `Character` have caches too; `Float` and `Double` don't.
- `new Integer(...)` is deprecated for removal. Wrappers are *value-based classes*, so don't synchronize on them or rely on their identity.
- A classic trap: a conditional expression with an `Integer` and an `int` branch has type `int`, so the `Integer` is unboxed:

```java
Map<String, Integer> m = new HashMap<>();
Integer x = flag ? m.get("missing") : 0;   // NPE when flag is true: m.get(...) is unboxed
```

Read more: [Object javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Object.html) · [JLS 5.1.7 Boxing](https://docs.oracle.com/javase/specs/jls/se21/html/jls-5.html#jls-5.1.7) · [JLS 15.25 Conditional operator](https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.25) · [JEP 254 Compact Strings](https://openjdk.org/jeps/254) · [JEP 280 Indify String Concatenation](https://openjdk.org/jeps/280)

## Methods and parameters

### Pass-by-value, precisely
The caller's variable and the parameter are two separate slots holding copies of the same reference. That's why a `swap(a, b)` method can't be written in Java, while `list.add(...)` inside a method is visible to the caller.

### Overload resolution happens in three phases (JLS 15.12.2)
1. Without boxing and varargs (widening only).
2. With boxing/unboxing.
3. With varargs.

The first phase that finds an applicable method wins, and then the **most specific** method of that phase is chosen.

```java
static void m(long x)    { System.out.println("long"); }
static void m(Integer x) { System.out.println("Integer"); }
static void m(int... x)  { System.out.println("varargs"); }

m(5);   // long: widening (phase 1) beats boxing (phase 2), which beats varargs (phase 3)
```

### Overriding and dynamic dispatch
- Virtual calls are dispatched by the runtime class. `private`, `static` and constructors are not virtual; `final` methods are, but can't be overridden.
- **Fields are not polymorphic**; they're resolved by the declared type:

```java
class A { String name = "A"; String name() { return name; } }
class B extends A { String name = "B"; @Override String name() { return name; } }

A a = new B();
System.out.println(a.name + " " + a.name());   // A B
```

- **Never call an overridable method from a constructor.** The override runs before the subclass's field initializers:

```java
class Base { Base() { init(); } void init() { } }
class Child extends Base {
    private String value = "set";
    @Override void init() { System.out.println(value); }   // prints null
}
```

Read more: [JLS 15.12.2 Compile-time method selection](https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.12.2) · [JLS 8.4.8 Inheritance, overriding and hiding](https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html#jls-8.4.8)

## Classes and OOP

### Abstract class or interface?
- Use an **interface** for a capability or contract that unrelated classes share (`Comparable`, `Closeable`). Default methods exist mainly for **API evolution**: they let the JDK add `Collection.stream()` without breaking every implementation.
- Use an **abstract class** for shared state and a template (`AbstractList`, template method pattern), when subclasses are closely related.
- Default method conflict rules: (1) a class method beats an interface default; (2) a more specific interface beats a less specific one; (3) otherwise the class must override.

```java
interface A { default String hi() { return "A"; } }
interface B extends A { default String hi() { return "B"; } }
class C implements A, B { }

new C().hi();   // "B": B is more specific than A, no conflict
```

### Nested classes
- A **static nested** class has no link to the outer instance.
- An **inner** (non-static) class holds an implicit reference to the outer instance, a common memory leak when the inner object (a listener, a callback, a task) outlives the outer one.
- Lambdas and anonymous classes capture only **effectively final** locals. A lambda captures `this` only if it uses it. An anonymous class created in an instance method used to hold the outer instance always; since JDK 18 javac drops that reference when the class doesn't use it.

### When a class is initialized (JLS 12.4.1)
A class is initialized on: creating an instance, calling a static method, assigning a static field, reading a static field that is **not a constant variable**, some reflection calls, initializing a subclass. Reading a compile-time constant doesn't trigger it, because javac inlines the value:

```java
class Holder {
    static { System.out.println("init"); }
    static final int CONST = 42;         // constant variable: inlined into the caller
    static final Integer BOXED = 42;     // not a constant variable (not primitive/String)
}

System.out.println(Holder.CONST);   // 42, no "init"
System.out.println(Holder.BOXED);   // init, then 42
```

Class initialization is lazy and thread-safe (the JVM holds an init lock), which is exactly what the **holder idiom** for lazy singletons relies on.

### Immutability, done properly
```java
public final class Order {
    private final List<String> items;

    public Order(List<String> items) {
        this.items = List.copyOf(items);   // defensive copy, also rejects nulls
    }

    public List<String> items() {
        return items;                       // already unmodifiable, safe to return
    }
}
```

Read more: [JLS 12.4 Initialization of classes](https://docs.oracle.com/javase/specs/jls/se21/html/jls-12.html#jls-12.4) · [JLS 9.4.1 Inheritance and overriding in interfaces](https://docs.oracle.com/javase/specs/jls/se21/html/jls-9.html#jls-9.4.1) · Effective Java, Item 17 "Minimize mutability"

## Exceptions

### Checked or unchecked?
Checked exceptions are for conditions a caller can reasonably recover from (a missing file). Unchecked ones are for programming errors (a null argument, a broken invariant). In practice, frameworks lean unchecked: Spring translates `SQLException` into the unchecked `DataAccessException` hierarchy, because a service layer rarely can do anything useful with it.

### What actually happens with return and finally
The value of a `return` is evaluated and saved **before** `finally` runs:

```java
static int f() {
    int x = 1;
    try {
        return x;      // 1 is saved here
    } finally {
        x = 2;         // doesn't change the saved value
    }
}
// f() returns 1. With a mutable object, a change to its fields in finally would be visible.
```

### try-with-resources details
- Resources are closed in reverse order of declaration, **before** any `catch` or `finally` of the same statement runs.
- A `null` resource is fine: it's just not closed.
- An exception from `close()` is added via `addSuppressed` to the primary exception. If the body succeeded, the `close()` exception propagates on its own.

### Performance notes
- Most of an exception's cost is `fillInStackTrace`. Exceptions for control flow are slow.
- The JIT may throw a **preallocated exception without a stack trace** for implicit NPEs and similar exceptions in hot code (`OmitStackTraceInFastThrow`, on by default). If logs show `NullPointerException` with no trace, this is why; run with `-XX:-OmitStackTraceInFastThrow`.

Read more: [JLS 14.20 try statement](https://docs.oracle.com/javase/specs/jls/se21/html/jls-14.html#jls-14.20) · [JLS 14.20.3 try-with-resources](https://docs.oracle.com/javase/specs/jls/se21/html/jls-14.html#jls-14.20.3) · [JLS 11 Exceptions](https://docs.oracle.com/javase/specs/jls/se21/html/jls-11.html)

## Generics

### Erasure consequences
- `List<String>` and `List<Integer>` are the same class at runtime: `ArrayList.class`.
- You can't overload `m(List<String>)` and `m(List<Integer>)`: both erase to `m(List)` (compile error, "same erasure").
- **Bridge methods**: when a class implements `Comparable<Money>`, javac generates `compareTo(Object)` that casts and delegates to `compareTo(Money)`.
- **Heap pollution**: generic varargs create a `T[]` of the erased type. `@SafeVarargs` promises the method doesn't misuse it.
- Raw types (`List` without `<>`) switch off generic checks completely. They exist only for pre-Java-5 compatibility.

### Wildcards in real signatures
```java
// Collections
public static <T> void copy(List<? super T> dest, List<? extends T> src)

// sort works for Apple even if only Fruit implements Comparable<Fruit>
public static <T extends Comparable<? super T>> void sort(List<T> list)
```

### Getting type information back at runtime
Erasure removes type arguments from *objects*, but generic signatures of classes, fields and methods are stored in the class file. A **super type token** is an anonymous subclass that captures them:

```java
List<User> users = mapper.readValue(json, new TypeReference<List<User>>() { });   // Jackson
restTemplate.exchange(url, GET, null, new ParameterizedTypeReference<List<User>>() { });   // Spring
```

Read more: [JLS 4.6 Type erasure](https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html#jls-4.6) · [Java Tutorial: Generics](https://docs.oracle.com/javase/tutorial/java/generics/index.html) · Effective Java, Item 31 "Use bounded wildcards to increase API flexibility"

## Modern Java (8 → 21)

### How streams execute
A stream is a pipeline of stages that runs only when a terminal operation is called. Elements flow through the pipeline **one at a time** (vertically), and short-circuiting operations stop early:

```java
Stream.of("a", "b", "c")
      .map(s -> { System.out.print("map " + s + "; "); return s.toUpperCase(); })
      .filter(s -> { System.out.print("filter " + s + "; "); return !s.equals("B"); })
      .findFirst();
// prints: map a; filter A;
```

- Stateful operations (`sorted`, `distinct`) must see all elements before passing anything on.
- **Parallel streams** run on the common `ForkJoinPool` (parallelism = cores - 1). Blocking I/O inside them starves every other parallel stream in the JVM. They help only for large, CPU-bound, easily split workloads (arrays, `ArrayList`, not `LinkedList` or I/O).
- `Stream.toList()` (Java 16) returns an unmodifiable list; `Collectors.toList()` makes no guarantees (currently an `ArrayList`).

```java
Map<String, Long> countByCity = users.stream()
    .collect(Collectors.groupingBy(User::city, Collectors.counting()));

Map<Boolean, List<User>> activeSplit = users.stream()
    .collect(Collectors.partitioningBy(User::active));

Map<String, User> byEmail = users.stream()
    .collect(Collectors.toMap(User::email, u -> u, (first, second) -> first, LinkedHashMap::new));
```

### Optional
Designed as a return type that says "there may be no result". Chain with `map`/`flatMap`/`filter`/`orElseGet`/`orElseThrow`. Avoid `get()` without a check, `Optional` fields (it isn't `Serializable`) and `Optional` parameters.

### Records
```java
public record Range(int from, int to) {
    public Range {                          // compact constructor: validation, normalization
        if (from > to) throw new IllegalArgumentException("from > to");
    }
}
```
Records are only **shallowly** immutable: a `List` component can still be mutated unless you copy it with `List.copyOf` in the compact constructor.

### Sealed types + pattern matching
```java
sealed interface Shape permits Circle, Square { }
record Circle(double r) implements Shape { }
record Square(double side) implements Shape { }

static double area(Shape shape) {
    return switch (shape) {
        case Circle(double r) -> Math.PI * r * r;          // record pattern (Java 21)
        case Square s -> s.side() * s.side();
    };                                                     // exhaustive: no default needed
}
```
Adding a new `Shape` makes every non-exhaustive switch a compile error, which is the point: it's the modern alternative to the Visitor pattern.

Read more: [java.util.stream package summary](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/stream/package-summary.html) · [JEP 395 Records](https://openjdk.org/jeps/395) · [JEP 409 Sealed Classes](https://openjdk.org/jeps/409) · [JEP 440 Record Patterns](https://openjdk.org/jeps/440) · [JEP 441 Pattern Matching for switch](https://openjdk.org/jeps/441)

## Odds and ends

### compareTo consistent with equals
Sorted collections use `compareTo`, hash collections use `equals`/`hashCode`. When the two disagree, the collections disagree:

```java
var a = new BigDecimal("1.0");
var b = new BigDecimal("1.00");
System.out.println(a.equals(b));                       // false: scale differs
System.out.println(a.compareTo(b));                    // 0
System.out.println(new HashSet<>(List.of(a, b)).size());   // 2
System.out.println(new TreeSet<>(List.of(a, b)).size());   // 1
```

### Comparator pitfalls
`(x, y) -> x - y` overflows for large values of different signs. Use `Integer.compare(x, y)` or `Comparator.comparingInt(...)`.

### Serialization and cloning
- Java native serialization is a security risk (deserialization gadget chains). Prefer JSON or Protobuf; if you must use it, filter classes with `ObjectInputFilter`.
- Without an explicit `serialVersionUID` the JVM computes one from the class structure, so any change breaks compatibility.
- `clone()` is shallow and `Cloneable` is a broken design. Prefer copy constructors or static factories.

Read more: [BigDecimal javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/math/BigDecimal.html) · Effective Java, Items 13 (clone) and 85 (alternatives to serialization)

## Sources
- [Java Language Specification, SE 21](https://docs.oracle.com/javase/specs/jls/se21/html/index.html): the authority on every "what does this print" question.
- [Java SE 21 API docs](https://docs.oracle.com/en/java/javase/21/docs/api/index.html)
- [dev.java Learn](https://dev.java/learn/): official tutorials for modern Java features.
- [JEP index](https://openjdk.org/jeps/0): the design rationale for every feature since Java 8.
- Joshua Bloch, *Effective Java*, 3rd edition: the book behind most core Java interview questions.
