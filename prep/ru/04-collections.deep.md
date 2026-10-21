# Коллекции: подробно

Здесь разделы краткого конспекта разобраны глубже. Исходники JDK читаются очень легко: `HashMap.java` начинается с длинного комментария "Implementation notes", который стоит прочитать хотя бы раз.

## List

### Рост ArrayList и его цена
- Рост: `newCapacity = old + (old >> 1)` (×1.5), затем `Arrays.copyOf`. Добавление n элементов стоит в сумме O(n), то есть O(1) амортизированно на один add.
- Если размер известен, `new ArrayList<>(n)` или `ensureCapacity(n)` избавляют от копирований; `trimToSize()` возвращает лишнее.
- `remove(i)` сдвигает хвост через `System.arraycopy`. Удаление многих элементов по одному в цикле это O(n²); `removeIf` делает один проход, O(n).

### Почему LinkedList редко выигрывает
Каждый элемент это объект `Node` (заголовок + item + next + prev ≈ 24–32 байта), разбросанный по куче. Обход означает промах кэша на каждом узле, а `ArrayList` сканирует память последовательно, что CPU хорошо предзагружает. Даже при вставке в середину `arraycopy` в `ArrayList` обычно обгоняет проход LinkedList до нужной позиции, на размерах до многих тысяч. LinkedList выигрывает, только когда итератор уже стоит на месте и туда идёт много вставок.

### Fail-fast итераторы
Каждое структурное изменение увеличивает `modCount`. Итератор запоминает значение и сравнивает его в `next()`. Проверка работает **по возможности**: удаление предпоследнего элемента приводит к тому, что `hasNext()` вернёт false раньше проверки (см. квиз). Никогда не полагайся на CME для корректности. То же для `subList`: он проверяет `modCount` родителя и бросает CME после структурного изменения родителя.

```java
list.removeIf(s -> s.isBlank());                // the right way

for (Iterator<String> it = list.iterator(); it.hasNext(); ) {
    if (it.next().isBlank()) it.remove();       // also fine
}
```

Подробнее: [ArrayList javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayList.html) · [List javadoc (unmodifiable lists)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/List.html)

## HashMap

### put по шагам
1. `hash = key.hashCode() ^ (hashCode >>> 16)`: подмешивает старшие биты в младшие, ведь bucket выбирают только младшие.
2. `index = (n - 1) & hash`: работает как остаток от деления только потому, что `n` степень двойки, и намного дешевле.
3. Пустой bucket → положить новый узел. Иначе пройти по bucket: тот же hash и (`==` или `equals`) → заменить значение; иначе добавить в конец.
4. Если в bucket набралось 8 узлов → превратить в дерево (или сделать resize, если таблица меньше 64).
5. `++size > threshold` → resize.

### Resize
Таблица удваивается. Каждый bucket делится на два списка: элементы, у которых следующий бит hash равен 0, остаются на индексе `i`, остальные переезжают на `i + oldCap`. Java 8 сохраняет их относительный порядок. Java 7 вставляла в голову и переворачивала списки при resize, и именно так два конкурентных resize могли создать **цикл**, на котором `get` крутился вечно со 100% CPU.

### Зачем деревья в bucket-ах
При ужасном `hashCode` (или если атакующий шлёт ключи с коллизиями хешей `String`, "hash flooding") все ключи попадают в один bucket, и map деградирует до O(n) на операцию. Tree bin ограничивает это O(log n). Узлы дерева упорядочены по hash, затем по `compareTo`, если ключи `Comparable`, поэтому делай ключи `Comparable`, если коллизии вероятны.

### Полезный API помимо get/put
```java
counts.merge(word, 1, Integer::sum);                          // word count
index.computeIfAbsent(city, c -> new ArrayList<>()).add(user); // multimap
cache.getOrDefault(key, DEFAULT);
map.entrySet().removeIf(e -> e.getValue() == 0);
```

### Предварительный размер
Аргумент конструктора это число **bucket-ов**, а не элементов. `new HashMap<>(128)` получает 128 bucket-ов с порогом 128 × 0.75 = 96, поэтому делает resize, не дойдя до 128 элементов. Для n элементов без resize в Java 19+ есть `HashMap.newHashMap(n)`, который сам считает `n / 0.75`.

### LinkedHashMap как LRU-кэш
```java
class LruCache<K, V> extends LinkedHashMap<K, V> {
    private final int maxSize;

    LruCache(int maxSize) {
        super(16, 0.75f, true);              // accessOrder = true: get() moves an entry to the end
        this.maxSize = maxSize;
    }

    @Override
    protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
        return size() > maxSize;             // evict the least recently used
    }
}
```
Не потокобезопасен. Для продакшен-кэшей используй Caffeine (вытеснение по размеру и времени, статистика, высокая конкурентность).

Подробнее: [HashMap javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/HashMap.html) · [Исходник HashMap с implementation notes](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/HashMap.java) · [LinkedHashMap javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/LinkedHashMap.html)

## TreeMap и сортированные коллекции

### Гарантии красно-чёрного дерева
Каждый узел красный или чёрный, корень чёрный, у красных узлов чёрные дети, и на каждом пути от корня до листа одинаковое число чёрных узлов. Вместе это держит высоту ≤ 2·log₂(n + 1), поэтому каждая операция O(log n), с несколькими поворотами максимум на вставку или удаление.

### NavigableMap на практике
```java
NavigableMap<Integer, Double> taxRate = new TreeMap<>(Map.of(
    0, 0.10,
    10_000, 0.20,
    50_000, 0.30));
taxRate.floorEntry(23_000).getValue();     // 0.20: the bracket that applies

NavigableMap<Instant, Price> history = ...;
history.floorEntry(t);                     // the price valid at time t
history.subMap(from, true, to, false);     // a time window, as a live view
```

### Согласованность компаратора
`TreeMap` считает `compare(a, b) == 0` "тем же ключом". Компаратор только по `lastName` молча выкинет второго человека с той же фамилией. Всегда добавляй уточняющие поля: `comparing(Person::lastName).thenComparing(Person::id)`.

Для конкурентной сортированной map используй `ConcurrentSkipListMap` (skip list, lock-free, O(log n) в среднем).

Подробнее: [TreeMap javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/TreeMap.html) · [NavigableMap javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/NavigableMap.html)

## Множества

- Boolean, который возвращает `Set.add`, даёт дедупликацию в одну строку: `if (seen.add(id)) process(item);`.
- Алгебра множеств: `a.retainAll(b)` (пересечение), `a.addAll(b)` (объединение), `a.removeAll(b)` (разность). Они меняют `a`, поэтому сначала скопируй.
- Изменяемые элементы опасны: поменяй поле, участвующее в `hashCode`, и `contains` перестанет находить элемент, хотя итерация его показывает.
- `EnumSet` хранит до 64 констант в одном `long` (`RegularEnumSet`), больше в `long[]` (`JumboEnumSet`). `EnumSet.of(READ, WRITE)` это идиоматичная замена битовых флагов.

Подробнее: [EnumSet javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/EnumSet.html)

## Очереди и деки

### ArrayDeque
Кольцевой массив с индексами головы и хвоста, который растёт при заполнении. Все операции на концах амортизированно O(1), без создания узлов, поэтому как очередь он быстрее `LinkedList`, а как стек быстрее `Stack`. Запрещает `null`, потому что `poll()` использует `null` как "пусто".

### PriorityQueue как бинарная куча
Хранится в массиве: дети `i` находятся в `2i + 1` и `2i + 2`. `offer` добавляет в конец и поднимает элемент вверх, `poll` переносит последний элемент в корень и опускает его вниз, оба O(log n). Построение из коллекции делает heapify за O(n).

**Паттерн Top-K**, который встречается и на собеседованиях, и в коде:
```java
PriorityQueue<Integer> heap = new PriorityQueue<>();     // min-heap
for (int x : nums) {
    heap.offer(x);
    if (heap.size() > k) heap.poll();                    // drop the smallest
}
int kthLargest = heap.peek();                            // O(n log k) total
```
Для max-кучи используй `new PriorityQueue<>(Comparator.reverseOrder())`.

Подробнее: [ArrayDeque javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayDeque.html) · [PriorityQueue javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/PriorityQueue.html)

## Неизменяемость и разное

### Три уровня "неизменяемости"
```java
List<String> source = new ArrayList<>(List.of("a"));
List<String> view = Collections.unmodifiableList(source);   // read-only view
List<String> copy = List.copyOf(source);                    // immutable snapshot
source.add("b");
view.size();   // 2: sees the change
copy.size();   // 1
```
`Stream.toList()` и `Collectors.toUnmodifiableList()` тоже дают неизменяемые списки. `List.of` и `List.copyOf` отклоняют `null`; `Stream.toList()` их допускает.

### Случайный порядок в Set.of / Map.of
Порядок итерации зависит от соли, выбираемой при старте JVM, поэтому меняется от запуска к запуску. Это сделано намеренно: код (и тесты), зависящий от порядка хешей, ломается сразу, а не после обновления JDK.

### TimSort и сломанные компараторы
TimSort находит уже отсортированные участки и сливает их: O(n) на отсортированном входе, O(n log n) в худшем случае, стабильная. Если компаратор нарушает контракт (не транзитивен, или `compare(a, b) != -compare(b, a)`), сортировка может бросить `IllegalArgumentException: Comparison method violates its general contract!`. Классические причины: компараторы на вычитании с переполнением и компараторы, читающие изменяемое состояние.

### Sequenced collections (Java 21)
Новые интерфейсы `SequencedCollection`, `SequencedSet` и `SequencedMap` дают единый API для коллекций с определённым порядком: `getFirst()`, `getLast()`, `addFirst()`, `addLast()`, `removeFirst()`, `removeLast()`, `reversed()`; для map ещё `firstEntry()`, `pollLastEntry()`, `sequencedKeySet()`. Раньше для "последнего элемента" `LinkedHashSet` нужна была полная итерация.

Подробнее: [JEP 431 Sequenced Collections](https://openjdk.org/jeps/431) · [Collections javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Collections.html)

## Источники
- [Java Tutorial: Collections](https://docs.oracle.com/javase/tutorial/collections/index.html): интерфейсы, реализации и алгоритмы в одном месте.
- [Исходники OpenJDK, java.util](https://github.com/openjdk/jdk/tree/master/src/java.base/share/classes/java/util): прочитай `HashMap`, `ArrayList` и `ArrayDeque` хотя бы раз, они короткие и хорошо прокомментированы.
- Joshua Bloch, *Effective Java*: items 10–14 (equals, hashCode, compareTo) объясняют большинство багов с коллекциями.
