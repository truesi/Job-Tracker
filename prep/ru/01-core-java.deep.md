# Core Java: подробно

Здесь разделы краткого конспекта разобраны глубже. Каждый раздел заканчивается ссылками на первоисточники (JLS, JEP, javadoc).

## Объекты, равенство, строки

### Контракт equals/hashCode
`equals` должен быть **рефлексивным**, **симметричным**, **транзитивным** и **согласованным**, а `x.equals(null)` должен возвращать `false`. `hashCode` должен возвращать одно и то же значение, пока не меняются поля, участвующие в `equals`, а равные объекты обязаны иметь равные hash-коды.

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

- **Ловушка симметрии**: наследник, добавляющий значимое поле (`ColorPoint extends Point`), не может соблюсти контракт. `point.equals(colorPoint)` истинно, а `colorPoint.equals(point)` ложно. С `instanceof` ломается симметрия, с `getClass() != o.getClass()` ломается принцип подстановки Лисков. Лучше композиция, `final` классы или records.
- **Как это использует HashMap**: hash = `h ^ (h >>> 16)` (подмешивает старшие биты), индекс bucket = `(n - 1) & hash`, внутри bucket сравнивается hash, потом `==`, потом `equals`. Плохой `hashCode` (например, константа) превращает каждый поиск в перебор одного bucket.

### String pool, константы и неизменяемость
С Java 7 пул находится в обычной куче, поэтому его чистит GC. Литералы и **compile-time константы** интернируются автоматически:

```java
String a = "ab";
String b = "a" + "b";        // constant expression, folded by javac: same object as a
String part = "a";
String c = part + "b";       // computed at runtime: new object
final String fin = "a";
String d = fin + "b";        // fin is a constant variable, so this is folded too
System.out.println((a == b) + " " + (a == c) + " " + (a == d));  // true false true
```

- **Compact strings** (Java 9): строка только из Latin-1 хранится по байту на символ в `byte[]`, иначе в UTF-16.
- **String deduplication** в G1 (`-XX:+UseStringDeduplication`) делит общие массивы между равными строками. `==` от этого не становится true.
- Неизменяемость даёт: кэшированный `hashCode`, безопасные ключи map, потокобезопасность без блокировок и безопасность (имена классов, пути к файлам и URL нельзя подменить после проверки).

### Boxing, кэши и NPE в тернарном операторе
- JLS 5.1.7 требует, чтобы упакованные значения в диапазоне -128..127 (плюс `boolean` и `char` до `\u007f`) были одним объектом. Верхнюю границу для `Integer` можно поднять через `-XX:AutoBoxCacheMax`. У `Byte`, `Short`, `Long` и `Character` тоже есть кэши; у `Float` и `Double` нет.
- `new Integer(...)` объявлен deprecated for removal. Обёртки являются *value-based классами*: не синхронизируйся на них и не полагайся на их identity.
- Классическая ловушка: условное выражение с веткой `Integer` и веткой `int` имеет тип `int`, поэтому `Integer` распаковывается:

```java
Map<String, Integer> m = new HashMap<>();
Integer x = flag ? m.get("missing") : 0;   // NPE when flag is true: m.get(...) is unboxed
```

Подробнее: [Object javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Object.html) · [JLS 5.1.7 Boxing](https://docs.oracle.com/javase/specs/jls/se21/html/jls-5.html#jls-5.1.7) · [JLS 15.25 Conditional operator](https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.25) · [JEP 254 Compact Strings](https://openjdk.org/jeps/254) · [JEP 280 Indify String Concatenation](https://openjdk.org/jeps/280)

## Методы и параметры

### Передача по значению, точно
Переменная вызывающего кода и параметр это два разных слота с копиями одной и той же ссылки. Поэтому метод `swap(a, b)` в Java написать нельзя, а `list.add(...)` внутри метода виден вызывающему.

### Выбор перегрузки идёт в три фазы (JLS 15.12.2)
1. Без boxing и varargs (только расширение типов).
2. С boxing/unboxing.
3. С varargs.

Побеждает первая фаза, нашедшая подходящий метод, а внутри неё выбирается **самый специфичный** метод.

```java
static void m(long x)    { System.out.println("long"); }
static void m(Integer x) { System.out.println("Integer"); }
static void m(int... x)  { System.out.println("varargs"); }

m(5);   // long: widening (phase 1) beats boxing (phase 2), which beats varargs (phase 3)
```

### Overriding и dynamic dispatch
- Виртуальные вызовы диспетчеризуются по классу объекта в рантайме. `private`, `static` и конструкторы не виртуальные; `final` методы виртуальные, но их нельзя переопределить.
- **Поля не полиморфны**: они разрешаются по объявленному типу:

```java
class A { String name = "A"; String name() { return name; } }
class B extends A { String name = "B"; @Override String name() { return name; } }

A a = new B();
System.out.println(a.name + " " + a.name());   // A B
```

- **Никогда не вызывай переопределяемый метод из конструктора.** Переопределение выполнится раньше инициализаторов полей наследника:

```java
class Base { Base() { init(); } void init() { } }
class Child extends Base {
    private String value = "set";
    @Override void init() { System.out.println(value); }   // prints null
}
```

Подробнее: [JLS 15.12.2 Compile-time method selection](https://docs.oracle.com/javase/specs/jls/se21/html/jls-15.html#jls-15.12.2) · [JLS 8.4.8 Inheritance, overriding and hiding](https://docs.oracle.com/javase/specs/jls/se21/html/jls-8.html#jls-8.4.8)

## Классы и ООП

### Абстрактный класс или интерфейс?
- **Интерфейс** для возможности или контракта, общего для несвязанных классов (`Comparable`, `Closeable`). Default-методы появились в основном для **эволюции API**: они позволили JDK добавить `Collection.stream()`, не сломав все реализации.
- **Абстрактный класс** для общего состояния и шаблона (`AbstractList`, паттерн template method), когда наследники тесно связаны.
- Правила конфликта default-методов: (1) метод класса побеждает default интерфейса; (2) более специфичный интерфейс побеждает менее специфичный; (3) иначе класс обязан переопределить метод.

```java
interface A { default String hi() { return "A"; } }
interface B extends A { default String hi() { return "B"; } }
class C implements A, B { }

new C().hi();   // "B": B is more specific than A, no conflict
```

### Вложенные классы
- **Static nested** класс не связан с экземпляром внешнего класса.
- **Inner** (не static) класс держит неявную ссылку на внешний экземпляр: частая утечка памяти, когда внутренний объект (listener, callback, задача) живёт дольше внешнего.
- Лямбды и анонимные классы захватывают только **effectively final** локальные переменные. Лямбда захватывает `this`, только если использует его. Анонимный класс, созданный в методе экземпляра, раньше всегда держал внешний экземпляр; начиная с JDK 18 javac убирает эту ссылку, если класс её не использует.

### Когда инициализируется класс (JLS 12.4.1)
Класс инициализируется при: создании экземпляра, вызове static метода, присваивании static поля, чтении static поля, которое **не является constant variable**, некоторых вызовах reflection, инициализации наследника. Чтение compile-time константы инициализацию не запускает, потому что javac подставляет значение:

```java
class Holder {
    static { System.out.println("init"); }
    static final int CONST = 42;         // constant variable: inlined into the caller
    static final Integer BOXED = 42;     // not a constant variable (not primitive/String)
}

System.out.println(Holder.CONST);   // 42, no "init"
System.out.println(Holder.BOXED);   // init, then 42
```

Инициализация класса ленивая и потокобезопасная (JVM держит init lock), и именно на этом держится **holder idiom** для ленивых синглтонов.

### Неизменяемость как надо
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

Подробнее: [JLS 12.4 Initialization of classes](https://docs.oracle.com/javase/specs/jls/se21/html/jls-12.html#jls-12.4) · [JLS 9.4.1 Inheritance and overriding in interfaces](https://docs.oracle.com/javase/specs/jls/se21/html/jls-9.html#jls-9.4.1) · Effective Java, Item 17 "Minimize mutability"

## Исключения

### Checked или unchecked?
Checked исключения для ситуаций, из которых вызывающий может разумно восстановиться (нет файла). Unchecked для ошибок программиста (null-аргумент, нарушенный инвариант). На практике фреймворки склоняются к unchecked: Spring переводит `SQLException` в unchecked иерархию `DataAccessException`, потому что слой сервисов редко может сделать с ним что-то полезное.

### Что на самом деле происходит с return и finally
Значение `return` вычисляется и сохраняется **до** выполнения `finally`:

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

### Детали try-with-resources
- Ресурсы закрываются в обратном порядке объявления, **до** выполнения `catch` или `finally` этого же оператора.
- `null`-ресурс допустим: его просто не закрывают.
- Исключение из `close()` добавляется через `addSuppressed` к основному. Если тело отработало успешно, исключение `close()` летит наружу само по себе.

### Про производительность
- Основная стоимость исключения в `fillInStackTrace`. Исключения для управления потоком выполнения медленные.
- JIT может бросать **заранее созданное исключение без стектрейса** для неявных NPE и похожих исключений в горячем коде (`OmitStackTraceInFastThrow`, включено по умолчанию). Если в логах `NullPointerException` без стектрейса, причина в этом; запускай с `-XX:-OmitStackTraceInFastThrow`.

Подробнее: [JLS 14.20 try statement](https://docs.oracle.com/javase/specs/jls/se21/html/jls-14.html#jls-14.20) · [JLS 14.20.3 try-with-resources](https://docs.oracle.com/javase/specs/jls/se21/html/jls-14.html#jls-14.20.3) · [JLS 11 Exceptions](https://docs.oracle.com/javase/specs/jls/se21/html/jls-11.html)

## Generics

### Последствия erasure
- `List<String>` и `List<Integer>` в рантайме один и тот же класс: `ArrayList.class`.
- Нельзя перегрузить `m(List<String>)` и `m(List<Integer>)`: оба стираются в `m(List)` (ошибка компиляции "same erasure").
- **Bridge-методы**: когда класс реализует `Comparable<Money>`, javac генерирует `compareTo(Object)`, который делает каст и вызывает `compareTo(Money)`.
- **Heap pollution**: generic varargs создают `T[]` стёртого типа. `@SafeVarargs` обещает, что метод не злоупотребляет этим массивом.
- Raw types (`List` без `<>`) полностью отключают проверки дженериков. Они существуют только для совместимости с кодом до Java 5.

### Wildcards в реальных сигнатурах
```java
// Collections
public static <T> void copy(List<? super T> dest, List<? extends T> src)

// sort works for Apple even if only Fruit implements Comparable<Fruit>
public static <T extends Comparable<? super T>> void sort(List<T> list)
```

### Как вернуть информацию о типе в рантайме
Erasure удаляет аргументы типов у *объектов*, но generic-сигнатуры классов, полей и методов сохраняются в class-файле. **Super type token** это анонимный наследник, который их фиксирует:

```java
List<User> users = mapper.readValue(json, new TypeReference<List<User>>() { });   // Jackson
restTemplate.exchange(url, GET, null, new ParameterizedTypeReference<List<User>>() { });   // Spring
```

Подробнее: [JLS 4.6 Type erasure](https://docs.oracle.com/javase/specs/jls/se21/html/jls-4.html#jls-4.6) · [Java Tutorial: Generics](https://docs.oracle.com/javase/tutorial/java/generics/index.html) · Effective Java, Item 31 "Use bounded wildcards to increase API flexibility"

## Современная Java (8 → 21)

### Как выполняются стримы
Стрим это конвейер стадий, который запускается только терминальной операцией. Элементы проходят конвейер **по одному** (вертикально), а short-circuiting операции останавливаются раньше:

```java
Stream.of("a", "b", "c")
      .map(s -> { System.out.print("map " + s + "; "); return s.toUpperCase(); })
      .filter(s -> { System.out.print("filter " + s + "; "); return !s.equals("B"); })
      .findFirst();
// prints: map a; filter A;
```

- Операции с состоянием (`sorted`, `distinct`) должны увидеть все элементы, прежде чем что-то передать дальше.
- **Parallel streams** работают на общем `ForkJoinPool` (parallelism = ядра - 1). Блокирующий I/O внутри них голодит все остальные параллельные стримы в JVM. Они полезны только для больших CPU-bound задач, которые легко делятся (массивы, `ArrayList`, но не `LinkedList` и не I/O).
- `Stream.toList()` (Java 16) возвращает неизменяемый список; `Collectors.toList()` ничего не гарантирует (сейчас это `ArrayList`).

```java
Map<String, Long> countByCity = users.stream()
    .collect(Collectors.groupingBy(User::city, Collectors.counting()));

Map<Boolean, List<User>> activeSplit = users.stream()
    .collect(Collectors.partitioningBy(User::active));

Map<String, User> byEmail = users.stream()
    .collect(Collectors.toMap(User::email, u -> u, (first, second) -> first, LinkedHashMap::new));
```

### Optional
Задуман как тип возврата, который говорит "результата может не быть". Используй цепочки `map`/`flatMap`/`filter`/`orElseGet`/`orElseThrow`. Избегай `get()` без проверки, полей типа `Optional` (он не `Serializable`) и параметров типа `Optional`.

### Records
```java
public record Range(int from, int to) {
    public Range {                          // compact constructor: validation, normalization
        if (from > to) throw new IllegalArgumentException("from > to");
    }
}
```
Records неизменяемы только **поверхностно**: компонент типа `List` всё ещё можно изменить, если не скопировать его через `List.copyOf` в compact-конструкторе.

### Sealed типы + pattern matching
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
Новый наследник `Shape` превращает каждый неисчерпывающий switch в ошибку компиляции, и в этом весь смысл: это современная альтернатива паттерну Visitor.

Подробнее: [java.util.stream package summary](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/stream/package-summary.html) · [JEP 395 Records](https://openjdk.org/jeps/395) · [JEP 409 Sealed Classes](https://openjdk.org/jeps/409) · [JEP 440 Record Patterns](https://openjdk.org/jeps/440) · [JEP 441 Pattern Matching for switch](https://openjdk.org/jeps/441)

## Разное

### compareTo, согласованный с equals
Сортированные коллекции используют `compareTo`, хеш-коллекции используют `equals`/`hashCode`. Когда они расходятся, расходятся и коллекции:

```java
var a = new BigDecimal("1.0");
var b = new BigDecimal("1.00");
System.out.println(a.equals(b));                       // false: scale differs
System.out.println(a.compareTo(b));                    // 0
System.out.println(new HashSet<>(List.of(a, b)).size());   // 2
System.out.println(new TreeSet<>(List.of(a, b)).size());   // 1
```

### Ловушки Comparator
`(x, y) -> x - y` переполняется на больших значениях разного знака. Используй `Integer.compare(x, y)` или `Comparator.comparingInt(...)`.

### Сериализация и клонирование
- Встроенная сериализация Java это риск безопасности (gadget-цепочки при десериализации). Лучше JSON или Protobuf; если без неё никак, фильтруй классы через `ObjectInputFilter`.
- Без явного `serialVersionUID` JVM вычисляет его из структуры класса, поэтому любое изменение ломает совместимость.
- `clone()` делает поверхностную копию, а `Cloneable` это неудачный дизайн. Лучше конструкторы копирования или static-фабрики.

Подробнее: [BigDecimal javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/math/BigDecimal.html) · Effective Java, Items 13 (clone) и 85 (alternatives to serialization)

## Источники
- [Java Language Specification, SE 21](https://docs.oracle.com/javase/specs/jls/se21/html/index.html): главный арбитр в любом вопросе "что выведет этот код".
- [Java SE 21 API docs](https://docs.oracle.com/en/java/javase/21/docs/api/index.html)
- [dev.java Learn](https://dev.java/learn/): официальные туториалы по современным возможностям Java.
- [Индекс JEP](https://openjdk.org/jeps/0): обоснование каждой фичи начиная с Java 8.
- Joshua Bloch, *Effective Java*, 3-е издание: книга, из которой взята большая часть вопросов по core Java.
