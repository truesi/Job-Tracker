# java.util.concurrent

## Executors и пулы потоков
- `execute(Runnable)` запускает задачу без результата: исключение уходит в uncaught handler потока. `submit()` возвращает `Future`: исключение сохраняется там и теряется, если никто не вызовет `get()`.
- `shutdown()`: не принимать новые задачи, доделать очередь. `shutdownNow()`: прервать выполняющиеся задачи и вернуть стоящие в очереди. Затем `awaitTermination(...)`. С Java 19 `close()` (try-with-resources) делает shutdown + ожидание.
- Параметры **ThreadPoolExecutor**: `corePoolSize`, `maximumPoolSize`, `keepAliveTime`, `workQueue`, `threadFactory`, `RejectedExecutionHandler`.
- Новая задача идёт так: свободный core-поток → **очередь** → дополнительные потоки до max → отказ. С неограниченной очередью `maximumPoolSize` никогда не достигается.
- `newFixedThreadPool`: неограниченная `LinkedBlockingQueue`, при перегрузке задачи копятся до OOM. `newCachedThreadPool`: `SynchronousQueue` и неограниченное число потоков.
- Политики отказа: `AbortPolicy` (по умолчанию, бросает `RejectedExecutionException`), `CallerRunsPolicy` (задачу выполняет отправляющий поток: естественный backpressure), `DiscardPolicy`, `DiscardOldestPolicy`.
- Размер пула: CPU-bound ≈ число ядер; I/O-bound ≈ ядра × (1 + время ожидания / время вычислений).
- `scheduleAtFixedRate` держит частоту (запуски не перекрываются; опоздавший запуск стартует сразу); `scheduleWithFixedDelay` ждёт фиксированную паузу после окончания каждого запуска. Исключение в периодической задаче молча отменяет все будущие запуски.
- **ForkJoinPool**: work-stealing, для рекурсивного "разделяй и властвуй" (`RecursiveTask`). Его общий пул выполняет parallel streams и вызовы `CompletableFuture.*Async` без executor-а.

## Future и CompletableFuture
- `Future.get()` блокирует; `cancel(true)` прерывает выполняющуюся задачу.
- `CompletableFuture.supplyAsync(supplier)` выполняется в общем `ForkJoinPool`. Для блокирующего I/O всегда передавай свой executor.
- `thenApply` = map (синхронное преобразование), `thenCompose` = flatMap (функция возвращает другой `CompletableFuture`), `thenCombine` = объединить два независимых future, `allOf`/`anyOf` = ждать многих.
- Ошибки: `exceptionally` (восстановиться), `handle` (результат или исключение, вызывается всегда), `whenComplete` (побочный эффект, результат не меняет). `orTimeout`/`completeOnTimeout` с Java 9.
- Не-async колбэки `then*` выполняются в потоке, завершившем предыдущую стадию, или в потоке вызывающего, если она уже завершена. Варианты `*Async` уходят в executor.
- `join()` бросает unchecked `CompletionException`; `get()` бросает checked `ExecutionException` и `InterruptedException`.
- `cancel(true)` у `CompletableFuture` **не** прерывает выполняющееся вычисление.

## Локи
- `ReentrantLock`: всегда `lock()` перед `try` и `unlock()` в `finally`. Плюсы относительно `synchronized`: `tryLock()`, таймауты, `lockInterruptibly()`, честность, несколько `Condition`.
- `ReentrantReadWriteLock`: много читателей или один писатель. **Повышения нет**: попытка взять write lock, держа read lock, даёт deadlock. Понижение (write → read) разрешено.
- `StampedLock`: оптимистичное чтение (`tryOptimisticRead()` + `validate(stamp)`), очень быстро для данных, которые в основном читают. Не reentrant, без условий.
- Все они построены на `AbstractQueuedSynchronizer` (AQS): `int` состояние плюс очередь запаркованных потоков.

## Атомики
- `AtomicInteger`, `AtomicLong`, `AtomicReference`: lock-free обновления через **CAS** (`compareAndSet`). `incrementAndGet`, `updateAndGet`, `accumulateAndGet`; функция обновления может повторяться, поэтому у неё не должно быть побочных эффектов.
- **Проблема ABA**: значение меняется A → B → A, и CAS проходит, хотя состояние менялось. `AtomicStampedReference` добавляет штамп версии.
- `LongAdder`: распределённые счётчики, намного лучше `AtomicLong` при сильной конкуренции на запись. `sum()` не атомарный снимок.

## Синхронизаторы
- `CountDownLatch(n)`: потоки ждут, пока `countDown()` не вызовут n раз. Одноразовый.
- `CyclicBarrier(n)`: n потоков ждут друг друга в точке, с опциональным действием барьера. Многоразовый.
- `Semaphore(n)`: n разрешений, ограничивает одновременный доступ к ресурсу.
- `Phaser`: многоразовый барьер с динамическим числом участников и фазами. `Exchanger`: два потока обмениваются объектами.

## Конкурентные коллекции
- **ConcurrentHashMap**: без `null` ключей и значений. Чтение lock-free; запись делает CAS в пустой bin или блокирует только первый узел этого bin (Java 8+). Итераторы слабо согласованные и никогда не бросают `ConcurrentModificationException`.
- Составные действия делай атомарными методами: `putIfAbsent`, `computeIfAbsent`, `compute`, `merge`. `containsKey` + `put` это гонка.
- `size()` при конкурентных обновлениях только оценка.
- `Collections.synchronizedMap`: один лок на всё, итерацию нужно синхронизировать вручную.
- `CopyOnWriteArrayList`: копирует массив при каждой записи, итераторы видят снимок. Для списков, которые в основном читают, например listeners.
- **BlockingQueue**: `ArrayBlockingQueue` (ограниченная, один лок), `LinkedBlockingQueue` (опционально ограниченная, отдельные локи на put/take), `SynchronousQueue` (без ёмкости, прямая передача), `PriorityBlockingQueue`, `DelayQueue`. `put`/`take` блокируют; `offer`/`poll` могут ждать с таймаутом.
- `ConcurrentLinkedQueue`: lock-free, неблокирующая. `ConcurrentSkipListMap`: сортированная конкурентная map.
