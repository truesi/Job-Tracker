# java.util.concurrent: подробно

Здесь разделы краткого конспекта разобраны глубже. Большую часть `j.u.c` написал Doug Lea, и его статьи (ссылки ниже) объясняют устройство лучше любого блога.

## Executors и пулы потоков

### Что на самом деле делает execute()
`ThreadPoolExecutor.execute` работает в три шага:
1. Запущено меньше `corePoolSize` потоков → стартовать новый поток с этой задачей (даже если другие простаивают).
2. Иначе попробовать `offer` задачу в очередь.
3. Очередь отказала (полна) → стартовать не-core поток, если не достигнут `maximumPoolSize`, иначе отказ.

Не-core потоки умирают после `keepAliveTime` простоя; core-потоки тоже, если включить `allowCoreThreadTimeOut(true)`.

Пул запросов Tomcat намеренно меняет местами шаги 2 и 3: его `TaskQueue` отказывает, пока пул ещё может расти, поэтому Tomcat сначала наращивает потоки до `maxThreads`, а потом ставит в очередь.

### Пул как в продакшене
```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    8, 32,                                         // core, max
    60, TimeUnit.SECONDS,                          // keep-alive for non-core threads
    new ArrayBlockingQueue<>(1_000),               // bounded: overload becomes visible
    Thread.ofPlatform().name("orders-", 0).factory(),  // readable names in thread dumps
    new ThreadPoolExecutor.CallerRunsPolicy());    // backpressure instead of exceptions
```

Аккуратное завершение:
```java
pool.shutdown();
if (!pool.awaitTermination(30, TimeUnit.SECONDS)) {
    pool.shutdownNow();                            // interrupt whatever is still running
}
```

### Размер пула
Из *Java Concurrency in Practice*: `потоки = ядра × целевая загрузка CPU × (1 + время ожидания / время вычислений)`. Сервису, который на каждые 10 мс CPU ждёт 90 мс HTTP, на 8 ядрах нужно ≈ 8 × (1 + 9) = 80 потоков. Лучше измерять, чем угадывать: смотри `getActiveCount()`, `getQueue().size()` и отказы (Micrometer отдаёт их как метрики `executor.*`).

### ForkJoinPool и work stealing
У каждого воркера своя deque. Свои подзадачи он кладёт и забирает LIFO (хорошая локальность кэша), а свободные воркеры воруют с другого конца, FIFO (забирают самые большие и старые куски). В общем пуле `ядра - 1` потоков. Блокирующий вызов внутри него должен идти через `ForkJoinPool.managedBlock`, чтобы пул мог добавить компенсирующий поток.

```java
class SumTask extends RecursiveTask<Long> {
    private final long[] a; private final int from, to;
    SumTask(long[] a, int from, int to) { this.a = a; this.from = from; this.to = to; }

    @Override protected Long compute() {
        if (to - from <= 10_000) {
            long s = 0;
            for (int i = from; i < to; i++) s += a[i];
            return s;
        }
        int mid = (from + to) >>> 1;
        SumTask left = new SumTask(a, from, mid);
        left.fork();                                   // push to own deque
        return new SumTask(a, mid, to).compute() + left.join();
    }
}
```

Подробнее: [ThreadPoolExecutor javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html) · [ForkJoinPool javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ForkJoinPool.html) · [Doug Lea: A Java Fork/Join Framework](https://gee.cs.oswego.edu/dl/papers/fj.pdf)

## Future и CompletableFuture

### Fan-out с таймаутами и fallback
```java
CompletableFuture<User> user = CompletableFuture
    .supplyAsync(() -> userClient.get(id), ioPool);

CompletableFuture<List<Order>> orders = CompletableFuture
    .supplyAsync(() -> orderClient.list(id), ioPool)
    .orTimeout(2, TimeUnit.SECONDS)
    .exceptionally(ex -> List.of());               // degrade instead of failing the page

Profile profile = user.thenCombine(orders, Profile::new).join();
```

### Что удивляет
- **Исключения заворачиваются.** В зависимых стадиях исключение приходит как `CompletionException`, а настоящее лежит в `getCause()`. Разворачивай перед проверкой типа.
- **В каком потоке выполняется колбэк.** `thenApply(f)` выполняет `f` в потоке, который завершил предыдущую стадию, или сразу в вызывающем потоке, если она уже завершена. Медленная `f` может оказаться на I/O-потоке HTTP-клиента. Когда это важно, используй `thenApplyAsync(f, executor)`.
- **Отмена не прерывает.** `cancel(true)` только завершает future с `CancellationException`; supplier продолжает работать.
- **`allOf` не отдаёт значения.** Он возвращает `CompletableFuture<Void>`. Результаты собирай после:

```java
List<CompletableFuture<Price>> futures = ids.stream()
    .map(id -> CompletableFuture.supplyAsync(() -> priceClient.get(id), ioPool))
    .toList();
List<Price> prices = CompletableFuture.allOf(futures.toArray(CompletableFuture[]::new))
    .thenApply(v -> futures.stream().map(CompletableFuture::join).toList())
    .join();
```

- Забытый future глотает своё исключение, как и `submit()`. Всегда заканчивай цепочку `join()`, `exceptionally` или `whenComplete` с логированием.

Подробнее: [CompletableFuture javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CompletableFuture.html) · [CompletionStage javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CompletionStage.html)

## Локи

### AQS: движок под всем этим
`AbstractQueuedSynchronizer` хранит одно `volatile int state` и FIFO-очередь запаркованных потоков. Каждый синхронизатор только определяет, что означает `state`:

| Класс | `state` означает |
|---|---|
| `ReentrantLock` | счётчик захватов владельцем (0 = свободен) |
| `Semaphore` | доступные разрешения |
| `CountDownLatch` | оставшийся счётчик |
| `ReentrantReadWriteLock` | число чтений (старшие 16 бит) и записей (младшие 16 бит) |

Захват пробует CAS по `state`; если не вышло, поток встаёт в очередь и паркуется (`LockSupport.park`). Освобождение меняет `state` и будит следующего.

### Честный и нечестный
**Нечестный** лок (по умолчанию) позволяет только что пришедшему потоку схватить свободный лок раньше потоков в очереди. Это избавляет от пробуждения запаркованного потока, поэтому пропускная способность намного выше. **Честный** лок отдаёт лок в порядке FIFO: предсказуемо, но медленнее.

### Conditions: один лок, несколько wait set
```java
final Lock lock = new ReentrantLock();
final Condition notFull = lock.newCondition();
final Condition notEmpty = lock.newCondition();

void put(T x) throws InterruptedException {
    lock.lock();
    try {
        while (count == items.length) notFull.await();
        enqueue(x);
        notEmpty.signal();        // wake one consumer, never a producer
    } finally {
        lock.unlock();
    }
}
```
Так написан `ArrayBlockingQueue`, и поэтому здесь `signal()` безопасен, а простой `notify()` нет.

### Read-write и stamped локи
```java
// downgrade: allowed
rw.writeLock().lock();
try {
    update();
    rw.readLock().lock();         // take read before releasing write
} finally {
    rw.writeLock().unlock();      // still holding read
}
```

```java
double distanceFromOrigin() {
    long stamp = sl.tryOptimisticRead();
    double cx = x, cy = y;
    if (!sl.validate(stamp)) {             // a writer got in: retry under a real lock
        stamp = sl.readLock();
        try { cx = x; cy = y; } finally { sl.unlockRead(stamp); }
    }
    return Math.hypot(cx, cy);
}
```
Read-write лок окупается, только когда чтения длинные и частые. Для коротких критических секций обычный лок или `StampedLock` обычно быстрее.

Подробнее: [AbstractQueuedSynchronizer javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/AbstractQueuedSynchronizer.html) · [StampedLock javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/locks/StampedLock.html) · [Doug Lea: The java.util.concurrent Synchronizer Framework](https://gee.cs.oswego.edu/dl/papers/aqs.pdf)

## Атомики

### Цикл CAS
```java
// what updateAndGet does, roughly
int prev, next;
do {
    prev = value.get();
    next = f.applyAsInt(prev);
} while (!value.compareAndSet(prev, next));
```
При конкуренции потоки повторяют попытки, и `f` выполняется несколько раз. Поэтому функция должна быть чистой. На x86 CAS это одна инструкция `lock cmpxchg`, а `getAndIncrement` это `lock xadd`.

### Атомарная замена неизменяемого состояния
```java
record Stats(long count, long total) {
    Stats add(long v) { return new Stats(count + 1, total + v); }
}
final AtomicReference<Stats> stats = new AtomicReference<>(new Stats(0, 0));

stats.updateAndGet(s -> s.add(latencyMs));   // two fields always consistent, no lock
```

### ABA на конкретном примере
В lock-free стеке поток 1 читает top = A (next = B) и приостанавливается. Поток 2 снимает A, снимает B и кладёт A обратно. `CAS(top, A, B)` потока 1 проходит и ставит B, узел, которого в стеке уже нет. `AtomicStampedReference` сравнивает ссылку *и* `int` штамп, который увеличивается при каждом изменении. В Java GC делает ABA реже, чем в C (узел не переиспользуется, пока на него есть ссылка), но с пулами объектов и повторной вставкой это случается.

### LongAdder и false sharing
`LongAdder` хранит базовое значение и массив `Cell`. Поток, у которого не прошёл CAS по базе, переходит на свою ячейку. Ячейки помечены `@Contended` и выровнены так, чтобы две ячейки не делили одну кэш-линию CPU. Иначе каждая запись инвалидировала бы кэш соседа (false sharing), и выигрыш бы пропал.

Подробнее: [java.util.concurrent.atomic package](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/package-summary.html) · [AtomicStampedReference javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/AtomicStampedReference.html)

## Синхронизаторы

### CountDownLatch: стартовые и финишные ворота
```java
CountDownLatch start = new CountDownLatch(1);
CountDownLatch done = new CountDownLatch(workers);

for (int i = 0; i < workers; i++) {
    pool.execute(() -> {
        try {
            start.await();          // all workers begin at the same moment
            work();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            done.countDown();       // in finally: a failed worker must still count
        }
    });
}
start.countDown();
done.await(10, TimeUnit.SECONDS);
```
Тот же приём удобен в тестах, чтобы спровоцировать гонки.

### CyclicBarrier
```java
CyclicBarrier barrier = new CyclicBarrier(4, () -> mergePartialResults());
// each of 4 threads, per iteration:
computeMyChunk();
barrier.await();   // last arriving thread runs the action, then all continue
```
Если один из ждущих потоков прерван или вышел по таймауту, барьер **ломается**, и все остальные ждущие получают `BrokenBarrierException`.

### Semaphore
Типичные применения: ограничить одновременные вызовы хрупкого внешнего сервиса или доступ к БД из virtual threads. `tryAcquire(timeout)` позволяет быстро отказать, а не стоять в очереди вечно. У семафора нет владельца: любой поток может сделать release, поэтому следи за счётом.

### Phaser
Многоразовый барьер, число участников которого может меняться (`register`/`arriveAndDeregister`). Полезен, когда число задач в фазе заранее неизвестно.

Подробнее: [CountDownLatch javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CountDownLatch.html) · [CyclicBarrier javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CyclicBarrier.html) · [Phaser javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/Phaser.html)

## Конкурентные коллекции

### Устройство ConcurrentHashMap (Java 8+)
- Таблица bin-ов, как в `HashMap`. Вставка в **пустой bin делается через CAS**; иначе писатель делает `synchronized` на первом узле bin. Писатели конкурируют, только попадая в один bin.
- Чтение вообще без локов: поля узлов `volatile`, поэтому читатель видит полностью сконструированные узлы.
- Bin с ≥ 8 узлами (при таблице ≥ 64 bin) превращается в красно-чёрное дерево, и поиск остаётся O(log n) даже при плохих хешах.
- **Resize кооперативный**: потоки, обращающиеся к map во время resize, помогают переносить bin-ы, а перенесённые bin-ы помечаются `ForwardingNode`.
- Размер хранится в ячейках-счётчиках в стиле `LongAdder`. `mappingCount()` возвращает `long`.
- В Java 7 было другое устройство: 16 `Segment`, каждый со своим `ReentrantLock` на свою часть таблицы.

### Правила computeIfAbsent
Функция выполняется при заблокированном bin, поэтому она должна быть короткой и **никогда не менять ту же map внутри себя**. Это бросает `IllegalStateException: Recursive update`, а в старых версиях давало deadlock.

```java
// per-key counters, safely
map.merge(word, 1L, Long::sum);

// per-key lazy cache
Connection c = connections.computeIfAbsent(host, this::connect);   // connect() must be quick
```

### Методы BlockingQueue
| | бросает | спецзначение | блокирует | с таймаутом |
|---|---|---|---|---|
| вставка | `add` | `offer` → false | `put` | `offer(e, t, unit)` |
| удаление | `remove` | `poll` → null | `take` | `poll(t, unit)` |
| просмотр | `element` | `peek` | | |

`ArrayBlockingQueue` использует один лок на оба конца; `LinkedBlockingQueue` использует отдельные `putLock` и `takeLock`, поэтому производители и потребители не блокируют друг друга, ценой создания узла на каждый элемент.

Подробнее: [ConcurrentHashMap javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ConcurrentHashMap.html) · [BlockingQueue javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/BlockingQueue.html)

## Источники
- [java.util.concurrent package summary](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/package-summary.html): включая гарантии согласованности памяти для каждого класса.
- [Статьи Doug Lea](https://gee.cs.oswego.edu/dl/papers/): AQS и Fork/Join от автора.
- Brian Goetz и др., *Java Concurrency in Practice*: главы 5 (building blocks), 8 (thread pools), 13 (explicit locks), 15 (atomics).
