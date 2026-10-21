# GC и память JVM: подробно

Здесь разделы краткого конспекта разобраны глубже. Руководство Oracle по тюнингу GC и цикл Шипилёва "JVM Anatomy Quarks" покрывают почти всё здесь ещё подробнее.

## Области памяти JVM

### Сколько стоит объект
На 64-битной JVM со сжатыми ссылками (по умолчанию для куч меньше ~32 ГБ):
- **Заголовок**: 8-байтовое mark word (hash-код, возраст для GC, состояние лока) + 4-байтовый указатель на класс.
- **Поля**, затем выравнивание до кратного 8 байтам.

Поэтому `new Object()` занимает 16 байт, `Integer` 16 байт, а пустой `ArrayList` ~24 байта плюс его массив. Выше ~32 ГБ сжатые oops отключаются, и каждая ссылка вырастает до 8 байт, так что куча в 33 ГБ может вместить *меньше*, чем в 31 ГБ. Реальные раскладки смотри через JOL (Java Object Layout).

**Compact object headers** уменьшают заголовок до 8 байт: экспериментально в JDK 24 (JEP 450) и как продакшен-фича в JDK 25 (JEP 519). Это экономит 10–20% кучи в приложениях с большим количеством объектов.

### Память процесса в контейнере
Лимит контейнера должен вместить намного больше, чем кучу:

`RSS ≈ heap + metaspace + потоки × размер стека + code cache + direct buffers + структуры GC + native библиотеки`

Если `-Xmx` слишком близок к лимиту, Kubernetes убивает под с **OOMKilled** без всякого Java `OutOfMemoryError`. Обычная практика: `-XX:MaxRAMPercentage=70..75` и замеры через **Native Memory Tracking**: запускай с `-XX:NativeMemoryTracking=summary` и выполняй `jcmd <pid> VM.native_memory summary`.

Подробнее: [JOL (Java Object Layout)](https://github.com/openjdk/jol) · [JEP 519 Compact Object Headers](https://openjdk.org/jeps/519) · [Troubleshooting guide](https://docs.oracle.com/en/java/javase/21/troubleshoot/index.html)

## Основы сборки мусора

### Minor GC по шагам
1. Eden заполняется, аллокация не удаётся.
2. Stop the world. Roots = фреймы стека, static поля, плюс **грязные карты** (старые объекты, которые недавно получили ссылку на молодой объект).
3. Живые объекты из Eden и Survivor "from" копируются в Survivor "to", их возраст увеличивается. Объекты старше порога (или не влезающие в Survivor) продвигаются в старое поколение.
4. Eden и "from" теперь полностью пусты; Survivor-ы меняются ролями.

Стоимость пропорциональна **живым** объектам, а не мусору. Поэтому много короткоживущего мусора это дёшево, а кэш, который держит много объектов средней продолжительности жизни, дорог: их копируют несколько раз, а потом продвигают.

### Конкурентная разметка
Конкурентные сборщики размечают, пока приложение продолжает менять ссылки. Трёхцветная абстракция: белый (ещё не видели), серый (видели, поля не просмотрены), чёрный (готово). Опасность: приложение кладёт белый объект в чёрный и убирает последний путь к нему через серые, и тогда живой объект будет ошибочно освобождён. Это предотвращают барьеры: G1 использует **SATB** (snapshot-at-the-beginning) pre-write барьеры; ZGC использует **load barriers** при чтении ссылок.

### Safepoints
Фазам STW нужно, чтобы каждый поток стоял в **safepoint** (месте, где JVM точно знает расположение каждой ссылки). JIT вставляет проверки safepoint при возврате из методов и на обратных переходах циклов. Длинный цикл с `int` счётчиком ("counted loop") раньше не имел проверки, и один поток мог задержать паузу на секунды. Современные JDK режут такие циклы на части (strip mining), чтобы проверки оставались. В логах GC смотри "time to safepoint" отдельно от работы GC.

### Что вызывает full GC
Promotion failure (старое поколение не может принять выживших), заполненный Metaspace, явный `System.gc()`, evacuation failure в G1 или humongous-аллокация, которой не хватает места. Full GC в G1 или Parallel уплотняет всю кучу в режиме stop-the-world; частые full GC всегда стоит расследовать.

Подробнее: [HotSpot GC tuning guide](https://docs.oracle.com/en/java/javase/21/gctuning/index.html) · [JVM Anatomy Quarks](https://shipilev.net/jvm/anatomy-quarks/)

## Сборщики

| Сборщик | Флаг | Паузы | Подходит для |
|---|---|---|---|
| Serial | `-XX:+UseSerialGC` | STW, один поток | крошечные кучи, 1 CPU, CLI-утилиты |
| Parallel | `-XX:+UseParallelGC` | STW, много потоков | batch-задачи, максимум пропускной способности |
| G1 | по умолчанию / `-XX:+UseG1GC` | в основном короткие, по цели | обычные сервисы, кучи 4–64 ГБ |
| ZGC | `-XX:+UseZGC` | < 1 мс | чувствительные к задержкам, большие кучи |
| Shenandoah | `-XX:+UseShenandoahGC` | < 10 мс, конкурентное уплотнение | чувствительные к задержкам (в сборках OpenJDK, где он есть) |

### G1 подробнее
- Куча это ~2048 одинаковых регионов; каждый в любой момент Eden, Survivor, Old, Humongous или свободный.
- **Remembered sets** у каждого региона записывают входящие ссылки, поэтому любой набор регионов можно эвакуировать отдельно.
- **Young collections** эвакуируют регионы Eden и Survivor. Когда старое поколение превышает порог IHOP (сначала 45%, затем адаптивно), G1 запускает **конкурентную разметку**, а затем **mixed collections**, которые эвакуируют ещё и старые регионы с наибольшим количеством мусора: отсюда "Garbage First".
- Цель паузы (`MaxGCPauseMillis`) определяет, сколько регионов войдёт в каждую сборку. Слишком низкое значение уменьшает молодое поколение и учащает GC.
- Тревожные признаки в логах: `to-space exhausted` / evacuation failure (некуда копировать выживших) и `Pause Full`. Лечение: больше запаса памяти, раньше начинать разметку, найти источник аллокаций.

### ZGC подробнее
- **Colored pointers**: служебные биты в каждой ссылке говорят, для какой фазы GC она актуальна.
- **Load barriers**: когда приложение загружает ссылку, барьер проверяет цвет и, если объект перемещён, сразу исправляет ссылку (self-healing). Это и позволяет перемещать объекты конкурентно.
- Generational ZGC появился в JDK 21 (JEP 439), стал режимом ZGC по умолчанию в JDK 23 (JEP 474), а негенерационный режим удалили в JDK 24 (JEP 490).
- Цена: часть пропускной способности и CPU уходит на барьеры и конкурентные потоки, и нужен запас памяти: если аллокации обгоняют конкурентную сборку, потоки останавливаются ("allocation stall").

### Как читать логи GC
```
-Xlog:gc*:file=gc.log:time,uptime,level,tags:filecount=5,filesize=20m
```
Смотри на время пауз (p99, а не среднее), частоту GC, заполненность старого поколения после GC (растёт ли базовый уровень?) и скорость аллокаций. Инструменты вроде GCeasy или JDK Mission Control превращают логи в графики.

Подробнее: [G1 tuning guide](https://docs.oracle.com/en/java/javase/21/gctuning/garbage-first-g1-garbage-collector1.html) · [ZGC guide](https://docs.oracle.com/en/java/javase/21/gctuning/z-garbage-collector.html) · [OpenJDK ZGC project](https://openjdk.org/projects/zgc/) · [JEP 439 Generational ZGC](https://openjdk.org/jeps/439) · [JEP 474 ZGC generational mode by default](https://openjdk.org/jeps/474)

## Ссылки

### Reference queues
Soft, weak и phantom ссылки можно зарегистрировать в `ReferenceQueue`. Когда GC очищает ссылку, она попадает в очередь, и поток очистки может её оттуда забрать. Так `WeakHashMap` вычищает устаревшие записи.

### Cleaner вместо finalize
```java
public final class NativeBuffer implements AutoCloseable {
    private static final Cleaner CLEANER = Cleaner.create();

    private final Cleaner.Cleanable cleanable;

    public NativeBuffer(long address) {
        this.cleanable = CLEANER.register(this, new Release(address));
    }

    @Override
    public void close() {
        cleanable.clean();                        // deterministic path: try-with-resources
    }

    // Must not reference NativeBuffer, or the buffer could never become unreachable
    private record Release(long address) implements Runnable {
        @Override public void run() { freeNative(address); }   // runs at most once
    }
}
```
Cleaner это **страховка** на случай, если кто-то забыл `close()`, а не основной механизм.

### Почему finalize был плохой идеей
Объектам с `finalize()` нужно минимум два цикла GC, чтобы освободиться, финализаторы выполняются в одном низкоприоритетном потоке (медленный блокирует все остальные), порядок не определён, а `finalize` может сохранить `this` куда-нибудь и воскресить объект. JEP 421 (JDK 18) объявил финализацию deprecated for removal.

Подробнее: [java.lang.ref package](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ref/package-summary.html) · [Cleaner javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ref/Cleaner.html) · [JEP 421 Deprecate Finalization for Removal](https://openjdk.org/jeps/421)

## Утечки памяти в Java

### Порядок диагностики
1. **Подтвердить**: использование старого поколения *после* full GC растёт часами (поднимающийся базовый уровень пилы). Высокое использование само по себе не утечка.
2. **Снять дамп**: `jcmd <pid> GC.heap_dump /tmp/heap.hprof` или пусть JVM сделает это сама: `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps`. Два дампа с интервалом делают рост очевидным.
3. **Разобрать** в Eclipse MAT: отчёт *Leak Suspects*, затем *Dominator Tree* по retained heap, затем *Path to GC Roots* (без weak/soft ссылок) для подозрительного объекта.
4. **Чинить владельца**, а не симптом: добавить вытеснение, удалить listener, очистить ThreadLocal.

### Утечки, которые встречаются в реальных сервисах
```java
// a "cache" that only grows
private static final Map<String, Report> CACHE = new HashMap<>();

// a ThreadLocal never cleared on a pool thread
private static final ThreadLocal<UserContext> CTX = new ThreadLocal<>();
```
- Долгая batch-задача с одним JPA `EntityManager`: persistence context держит каждую загруженную сущность. Лечение: `flush()` + `clear()` каждые N строк.
- Рост Metaspace: классы, генерируемые в рантайме (Groovy-скрипты, компилируемые на каждый запрос, прокси, создаваемые в цикле), или старые classloader-ы, которые остались живы после редеплоя.
- Неограниченные очереди перед медленным потребителем: формально не утечка, но кучу заполняют так же.

### Профилирование аллокаций
Высокая нагрузка на GC без утечки означает слишком много аллокаций. Источник находится через JFR (`jcmd <pid> JFR.start duration=60s filename=rec.jfr`, затем представления аллокаций в JDK Mission Control) или через async-profiler в режиме `alloc`.

Подробнее: [Eclipse MAT](https://eclipse.dev/mat/) · [JDK Mission Control](https://www.oracle.com/java/technologies/jdk-mission-control.html) · [async-profiler](https://github.com/async-profiler/async-profiler)

## JIT и загрузка классов

### Tiered compilation
| Уровень | Что выполняется |
|---|---|
| 0 | интерпретатор, собирает профиль |
| 1–3 | код, скомпилированный C1, с разной степенью профилирования |
| 4 | код, скомпилированный C2, полностью оптимизированный по профилю |

C2 оптимизирует **спекулятивно** по профилю: если в точке вызова встречался только один класс, он инлайнит метод этого класса за дешёвой проверкой типа. Когда допущение ломается (загрузился новый наследник, сработала "невозможная" ветка), код **деоптимизируется** обратно в интерпретатор и позже перекомпилируется. Поэтому бенчмаркам нужен прогрев (используй JMH), и поэтому старт медленный; с этим борются CDS-архивы, CRaC и AOT cache из проекта Leyden (JEP 483, JDK 24).

### Inlining и escape analysis
Inlining это мать всех оптимизаций: он позволяет JIT видеть сквозь границы методов. Маленькие методы (байткод ≤ 35 байт) всегда кандидаты; горячие до 325 байт. Затем escape analysis работает уже на заинлайненном коде:

```java
int lengthSquared(int x, int y) {
    Point p = new Point(x, y);      // never leaves this method once inlined:
    return p.x() * p.x() + p.y() * p.y();   // the JIT keeps x and y in registers, no allocation
}
```

### Фазы загрузки классов (JVMS глава 5)
1. **Загрузка**: найти байты и создать объект `Class`.
2. **Линковка**: *verification* (байткод типобезопасен), *preparation* (static поля получают значения по умолчанию), *resolution* (символьные ссылки становятся прямыми, часто лениво).
3. **Инициализация**: static-инициализаторы и присваивания static полей выполняются один раз, под локом, при первом активном использовании.

Класс можно выгрузить, только когда его загрузчик становится недостижимым, поэтому классы application class loader остаются загруженными навсегда. Fat jar-ы Spring Boot используют свой загрузчик для чтения вложенных jar; серверы приложений используют по загрузчику на веб-приложение, отсюда утечки при редеплое.

Подробнее: [JVMS chapter 5: Loading, Linking, and Initializing](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-5.html) · [JEP 483 Ahead-of-Time Class Loading & Linking](https://openjdk.org/jeps/483) · [JMH](https://github.com/openjdk/jmh)

## Источники
- [HotSpot Virtual Machine Garbage Collection Tuning Guide](https://docs.oracle.com/en/java/javase/21/gctuning/index.html): официальное руководство по каждому сборщику.
- [Алексей Шипилёв: JVM Anatomy Quarks](https://shipilev.net/jvm/anatomy-quarks/): короткие статьи, каждая про один механизм JVM.
- [Java Virtual Machine Specification SE 21](https://docs.oracle.com/javase/specs/jvms/se21/html/index.html)
- Scott Oaks, *Java Performance*, 2-е издание: GC, JIT и профилирование, очень практично.
