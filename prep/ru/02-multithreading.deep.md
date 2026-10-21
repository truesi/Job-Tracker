# Многопоточность и Java Memory Model: подробно

Здесь разделы краткого конспекта разобраны глубже. Два самых полезных источника по теме: книга *Java Concurrency in Practice* и статьи Алексея Шипилёва о JMM, ссылки ниже.

## Потоки

### Сколько стоят platform threads
Platform thread соответствует потоку ОС один к одному. Он резервирует стек (по умолчанию 1 МБ на 64-битном Linux, задаётся `-Xss`), а переключение между потоками делает ядро ОС. Практический предел несколько тысяч потоков, поэтому серверы используют пулы, и поэтому появились virtual threads.

### Как читать thread dump
Снимается через `jstack <pid>` или `jcmd <pid> Thread.print`. Как там выглядят состояния:

| В дампе | Состояние | Значение |
|---|---|---|
| `waiting to lock <0x...>` | BLOCKED | ждёт монитор `synchronized` |
| `in Object.wait()` | WAITING / TIMED_WAITING | ждёт `notify` |
| `parking to wait for <0x...>` | WAITING / TIMED_WAITING | ждёт лок, condition или очередь из `j.u.c` |
| `Found one Java-level deadlock` | | JVM нашла цикл мониторов/локов и печатает его |

Три дампа с интервалом в несколько секунд показывают, какие потоки реально застряли, а какие оказались там случайно.

### Исключения в потоках
- Непойманное исключение убивает только свой поток и попадает в его `UncaughtExceptionHandler` (по умолчанию печатается в stderr).
- В `ExecutorService` исключение из задачи, переданной в `submit()`, **сохраняется в `Future`**. Если никто не вызовет `get()`, оно молча потеряется. `execute()` отправляет его в handler.
- Приоритеты потоков это подсказки планировщику ОС, на Linux их в основном игнорируют. Не полагайся на них для корректности.

Подробнее: [Thread.State javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.State.html) · [jcmd manual](https://docs.oracle.com/en/java/javase/21/docs/specs/man/jcmd.html)

## Прерывание

### Воркер, который правильно обрабатывает прерывание
```java
public void run() {
    while (!Thread.currentThread().isInterrupted()) {
        try {
            Task task = queue.take();          // blocking, interruptible
            process(task);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt(); // restore the flag, so the loop condition sees it
        }
    }
}
```

- `Thread.interrupted()` (static) **возвращает и сбрасывает** флаг; `isInterrupted()` только читает его.
- Некоторые блокировки не прерываются: ожидание входа в `synchronized` и классическое чтение из сокета в `java.io`. Сокет закрывают из другого потока; для локов есть `ReentrantLock.lockInterruptibly()`.
- Отмена в executor-ах это прерывание: `future.cancel(true)` прерывает выполняющуюся задачу, а `executor.shutdownNow()` прерывает все воркеры. Задачу, которая игнорирует прерывание, отменить нельзя.

Подробнее: [Thread.interrupt javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.html#interrupt()) · Java Concurrency in Practice, глава 7 "Cancellation and Shutdown"

## synchronized

### Как работают мониторы
Состояние лока хранится в заголовке объекта. Неконкурентный лок берётся через CAS (lightweight locking); при конкуренции он *раздувается* (inflation) до полноценного монитора с очередью ожидающих потоков. Biased locking, старую оптимизацию для локов из одного потока, отключили в JDK 15 (JEP 374) и позже удалили.

### synchronized vs ReentrantLock
| | `synchronized` | `ReentrantLock` |
|---|---|---|
| Освобождение | автоматически, даже при исключении | вручную: `unlock()` в `finally` |
| Попытка / таймаут | нет | `tryLock()`, `tryLock(timeout)` |
| Прерываемое ожидание | нет | `lockInterruptibly()` |
| Честность | нет | опционально `new ReentrantLock(true)` |
| Условия | один wait set на объект | много `Condition` на один лок |

По умолчанию бери `synchronized`; `ReentrantLock` нужен, когда требуется одна из его дополнительных возможностей.

### На чём блокироваться
Блокируйся на `private final Object lock = new Object()`. Блокировка на `this` позволяет чужому коду захватить твой лок. **Никогда** не блокируйся на строковых литералах или упакованных значениях: они интернированы или закэшированы, и несвязанный код может делить с тобой тот же лок.

### wait/notify: ограниченный буфер
```java
class BoundedBuffer<T> {
    private final Deque<T> items = new ArrayDeque<>();
    private final int capacity;

    BoundedBuffer(int capacity) { this.capacity = capacity; }

    synchronized void put(T item) throws InterruptedException {
        while (items.size() == capacity) wait();
        items.addLast(item);
        notifyAll();
    }

    synchronized T take() throws InterruptedException {
        while (items.isEmpty()) wait();
        T item = items.removeFirst();
        notifyAll();
        return item;
    }
}
```

Почему `notifyAll`, а не `notify`: производители и потребители ждут в одном wait set. `notify` может разбудить производителя, когда нужен был потребитель; тот снова уснёт, и в итоге могут уснуть все. В реальном коде используй `ArrayBlockingQueue` или `ReentrantLock` с отдельными условиями `notFull`/`notEmpty`.

Подробнее: [JLS 17.1 Synchronization](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.1) · [JLS 17.2 Wait sets and notification](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.2) · [JEP 374 Deprecate and disable biased locking](https://openjdk.org/jeps/374)

## volatile

### Во что он компилируется
JMM реализуется через memory barriers. На x86 чтение volatile это обычная загрузка, а после записи в volatile стоит барьер `StoreLoad` (инструкция с префиксом `lock`), поэтому запись дороже чтения. На ARM барьеры нужны в обоих случаях. JSR-133 cookbook перечисляет, где какой барьер ставится.

### Чего он не делает
- Volatile **ссылка** делает видимой только саму ссылку. Поля объекта по ссылке после последующих изменений никаких дополнительных гарантий не получают.
- Check-then-act всё равно гонка:

```java
volatile boolean initialized;

void ensureInit() {
    if (!initialized) {      // two threads can both see false
        init();              // and both run init()
        initialized = true;
    }
}
```

### Атомарные альтернативы
- `AtomicInteger.incrementAndGet()` это цикл CAS: lock-free и корректно, но все потоки конкурируют за одну ячейку памяти.
- `LongAdder` распределяет инкременты по ячейкам и суммирует их при чтении. Намного быстрее для горячих счётчиков (метрики), которые редко читают.
- `VarHandle` (Java 9) даёт явные режимы доступа к полям и элементам массивов: plain, opaque, acquire/release и volatile, плюс CAS. Именно его использует `j.u.c` внутри.

Подробнее: [JSR-133 Cookbook for compiler writers](https://gee.cs.oswego.edu/dl/jmm/cookbook.html) · [VarHandle javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/invoke/VarHandle.html) · [LongAdder javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/LongAdder.html)

## Java Memory Model: happens-before

### Зачем вообще нужна модель
У CPU есть store buffers и кэши; компиляторы и JIT переупорядочивают операции и держат значения в регистрах. JMM обещает: **если в программе нет data race, она ведёт себя как последовательно согласованная** (DRF-SC). Программы с гонками получают гораздо более слабые гарантии.

```java
// shared: int x = 0, y = 0;
// thread 1         // thread 2
x = 1;              y = 1;
int r1 = y;         int r2 = x;
// r1 == 0 && r2 == 0 is a legal outcome, and actually happens on x86 (store buffering)
```

### Piggybacking на volatile
Happens-before **транзитивно**. Всё, что записано до записи в volatile, видно потоку, который прочитал этот volatile и увидел значение:

```java
int data;                 // plain field
volatile boolean ready;

// writer thread
data = 42;
ready = true;

// reader thread
if (ready) {
    System.out.println(data);   // guaranteed to print 42
}
```

Именно так классы `j.u.c` дают видимость: `ConcurrentHashMap.put` → `get`, `BlockingQueue.put` → `take`, завершение `Future` → `get()`.

### Безопасная публикация
Объект безопасно опубликован для других потоков, если ссылка на него записана (JCiP 3.5.3):
1. в static-инициализаторе;
2. в `volatile` поле или `AtomicReference`;
3. в `final` поле правильно сконструированного объекта;
4. в поле, защищённом локом, включая добавление в потокобезопасную коллекцию.

**Утечка `this`** это ломает: регистрация listener-а, запуск потока или публикация `this` внутри конструктора позволяют другим потокам увидеть недостроенный объект, даже с `final` полями.

### Double-checked locking и holder idiom
```java
class Config {
    private static volatile Config instance;

    static Config get() {
        Config c = instance;                  // one volatile read on the fast path
        if (c == null) {
            synchronized (Config.class) {
                c = instance;
                if (c == null) instance = c = new Config();
            }
        }
        return c;
    }
}

class Lazy {
    private static class Holder {
        static final Lazy INSTANCE = new Lazy();
    }
    static Lazy get() { return Holder.INSTANCE; }   // class init is lazy and thread-safe (JLS 12.4.2)
}
```

Подробнее: [JLS 17.4 Memory Model](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html#jls-17.4) · [Шипилёв: JMM Pragmatics](https://shipilev.net/blog/2014/jmm-pragmatics/) · [Шипилёв: Close Encounters of the JMM Kind](https://shipilev.net/blog/2016/close-encounters-of-jmm-kind/) · [Шипилёв: Safe Publication and Safe Initialization](https://shipilev.net/blog/2014/safe-public-construction/) · [JSR-133 FAQ](https://www.cs.umd.edu/~pugh/java/memoryModel/jsr-133-faq.html) · [Декларация "Double-Checked Locking is Broken"](https://www.cs.umd.edu/~pugh/java/memoryModel/DoubleCheckedLocking.html)

## Проблемы конкурентности

### Deadlock: избегаем упорядочиванием
```java
void transfer(Account from, Account to, long amount) {
    Account first = from.id() < to.id() ? from : to;     // global order by id
    Account second = first == from ? to : from;
    synchronized (first) {
        synchronized (second) {
            from.withdraw(amount);
            to.deposit(amount);
        }
    }
}
```

Как обнаружить в продакшене: thread dump печатает `Found one Java-level deadlock`, а `ThreadMXBean.findDeadlockedThreads()` находит циклы программно (для health check).

### Две формы race condition
- **Check-then-act**: `if (!map.containsKey(k)) map.put(k, v)`, ленивая инициализация. Лечение: одна атомарная операция, например `ConcurrentHashMap.computeIfAbsent` или `putIfAbsent`.
- **Read-modify-write**: `count++`, `balance = balance - x`. Лечение: `AtomicLong`, `LongAdder` или лок вокруг всей последовательности.

Класс, собранный из потокобезопасных частей, сам по себе потокобезопасным не становится: два корректных вызова подряд всё равно составное действие.

### Livelock и starvation
- **Livelock**: два потока замечают конфликт, оба отступают и повторяют попытку в одном ритме, бесконечно. Лечение: случайная задержка (как в сетевых протоколах).
- **Starvation**: поток редко получает лок или CPU, например с нечестными локами при сильной конкуренции. Честные локи это лечат ценой сильной потери пропускной способности.

### Утечки через ThreadLocal
В сервере приложений значение `ThreadLocal`, чей класс загружен из веб-приложения, держит живым весь classloader этого приложения после редеплоя (потоки пула живут дольше приложения). Всегда делай `remove()` в `finally`.

Подробнее: [ThreadMXBean javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.management/java/lang/management/ThreadMXBean.html) · Java Concurrency in Practice, глава 10 "Avoiding Liveness Hazards"

## Virtual threads (Java 21)

### Как они работают
Virtual thread это continuation: когда он блокируется, его стековые фреймы переносятся в кучу, а carrier (platform thread из `ForkJoinPool` с parallelism = числу ядер) берёт другой virtual thread. Блокирующие API JDK (сокеты, локи `j.u.c`, `sleep`, `BlockingQueue`) переписаны так, чтобы *парковать* virtual thread, а не блокировать carrier.

- Файловый I/O на большинстве ОС неблокирующим не сделать: он блокирует carrier, и планировщик временно добавляет ещё один carrier для компенсации.
- Pinning виден как JFR событие `jdk.VirtualThreadPinned`. В JDK 21 также можно запустить с `-Djdk.tracePinnedThreads=full`.
- `ThreadLocal` работает, но при миллионах потоков стоит памяти. Задуманная замена `ScopedValue`: неизменяемое значение, привязанное к области выполнения, дёшево наследуется. Стал финальным в JDK 25 (JEP 506).

### Использование
```java
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    List<Future<String>> pages = urls.stream()
        .map(url -> executor.submit(() -> fetch(url)))
        .toList();
    for (Future<String> page : pages) {
        System.out.println(page.get());
    }
}   // ExecutorService.close() (Java 19+) waits for all tasks
```

В Spring Boot 3.2+ `spring.threads.virtual.enabled=true` переводит обработку запросов Tomcat и `@Async` на virtual threads.

**Когда они не помогают**: CPU-bound работа (всё равно упирается в ядра), код, который часто попадает в pinning на JDK 21–23, и узкое место дальше по цепочке: 10 000 virtual threads всё равно делят пул из 20 соединений с БД.

Подробнее: [JEP 444 Virtual Threads](https://openjdk.org/jeps/444) · [JEP 491 Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491) · [JEP 506 Scoped Values](https://openjdk.org/jeps/506) · [Oracle guide: Virtual Threads](https://docs.oracle.com/en/java/javase/21/core/virtual-threads.html)

## Источники
- [JLS глава 17: Threads and Locks](https://docs.oracle.com/javase/specs/jls/se21/html/jls-17.html): формальная модель памяти.
- [Блог Алексея Шипилёва](https://shipilev.net/): самые точные практические объяснения JMM от инженера JDK.
- [Doug Lea: JSR-133 Cookbook](https://gee.cs.oswego.edu/dl/jmm/cookbook.html): барьеры и переупорядочивания от автора `j.u.c`.
- [Oracle Java Tutorial: Concurrency](https://docs.oracle.com/javase/tutorial/essential/concurrency/index.html): основы, если что-то выше показалось слишком быстрым.
- Brian Goetz и др., *Java Concurrency in Practice*: по-прежнему главная книга, особенно главы 3 (sharing), 7 (cancellation) и 10 (liveness).
