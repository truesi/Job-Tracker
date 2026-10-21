# Коллекции

## List
- **ArrayList**: на основе массива. `get(i)` O(1), `add` амортизированно O(1), вставка/удаление в середине O(n) (сдвиг). Растёт в 1.5 раза. `new ArrayList<>()` выделяет массив на 10 элементов лениво, при первом `add`.
- **LinkedList**: двусвязные узлы. O(1) на концах и через итератор, O(n) для `get(i)`, плохая локальность кэша и в несколько раз больше памяти на элемент. `ArrayList` или `ArrayDeque` почти всегда выигрывают.
- `Arrays.asList(...)`: view фиксированного размера поверх массива (`set` работает, `add`/`remove` бросают `UnsupportedOperationException`). `List.of(...)`: полностью неизменяемый, без null.
- Изменение списка внутри for-each → `ConcurrentModificationException` (fail-fast итераторы проверяют `modCount`). Используй `iterator.remove()` или `removeIf`.
- `List<Integer>.remove(1)` удаляет элемент по **индексу** 1. Чтобы удалить значение, используй `remove(Integer.valueOf(1))`.
- `subList` это view; структурные изменения родительского списка делают его невалидным.

## HashMap
- Массив bucket-ов. Индекс = `(n - 1) & (h ^ (h >>> 16))`, где `n` степень двойки. Коллизии хранятся связным списком; bucket с ≥ 8 элементами становится красно-чёрным деревом, если в таблице ≥ 64 bucket-а (обратно в список при ≤ 6).
- Ёмкость по умолчанию 16, load factor 0.75: таблица удваивается, когда размер превышает 12. Resize стоит O(n).
- Допускается один `null` ключ (хранится в bucket 0) и сколько угодно `null` значений.
- Не потокобезопасна: конкурентные `put` могут терять записи. В Java 7 конкурентный resize мог даже дать бесконечный цикл.
- Порядок итерации не определён и может поменяться после resize. **LinkedHashMap** хранит порядок вставки или порядок доступа (LRU-кэш через `removeEldestEntry`).
- Предварительный размер под `n` элементов: `HashMap.newHashMap(n)` (Java 19). `new HashMap<>(n)` задаёт число bucket-ов, а не элементов, и может сделать resize раньше, чем наберётся `n`.

## TreeMap и сортированные коллекции
- Красно-чёрное дерево: `get`/`put`/`remove` O(log n), ключи отсортированы по `compareTo` или `Comparator`.
- API `NavigableMap`: `floorKey`, `ceilingKey`, `lowerKey`, `higherKey`, `headMap`, `tailMap`, `subMap`, `firstEntry`, `pollFirstEntry`.
- `null` ключ при естественном порядке бросает NPE.
- Уникальность определяется `compareTo` (== 0), а не `equals`. Несогласованный компаратор молча склеивает "разные" ключи.

## Множества
- `HashSet` это `HashMap` с фиктивным значением; `LinkedHashSet` хранит порядок вставки; `TreeSet` это `TreeMap`.
- `EnumSet` это битовый вектор, а `EnumMap` массив по `ordinal()`: самый быстрый и компактный выбор для enum-ключей.
- `add` возвращает `false`, если элемент уже был: удобно для дедупликации.

## Очереди и деки
- **ArrayDeque**: кольцевой массив, лучший универсальный стек и очередь (быстрее `Stack` и `LinkedList`). Без `null`.
- **PriorityQueue**: бинарная куча. `offer`/`poll` O(log n), `peek` O(1). Её итератор **не** отсортирован; порядок даёт только повторный `poll`.
- `Stack` наследует `Vector` (synchronized, legacy). Используй `Deque` с `push`/`pop`.

## Неизменяемость и разное
- `List.of`/`Set.of`/`Map.of` (Java 9): неизменяемые, без `null`. `Set.of` и `Map.of` бросают исключение на дубликатах, а порядок их итерации меняется от запуска к запуску JVM.
- `Collections.unmodifiableList(list)` это **view** только для чтения: изменения исходного списка видны через него. `List.copyOf` делает настоящую неизменяемую копию.
- `List.sort`/`Collections.sort` используют TimSort: стабильная, O(n log n), быстрая на почти отсортированных данных.
- Sequenced collections в Java 21: `getFirst()`, `getLast()`, `addFirst()`, `reversed()` у `List`, `Deque`, `LinkedHashSet`, `LinkedHashMap`...
- `WeakHashMap`: записи исчезают, когда ключ больше недостижим по сильным ссылкам. `IdentityHashMap`: сравнивает ключи через `==`.
- Шпаргалка по Big-O: `ArrayList.contains` O(n), `HashSet.contains` O(1) в среднем, `TreeSet.contains` O(log n).
