# Collections

## List
- **ArrayList**: backed by an array. `get(i)` O(1), `add` amortized O(1), insert/remove in the middle O(n) (shifting). Grows by 1.5×. `new ArrayList<>()` allocates the 10-slot array lazily, on the first `add`.
- **LinkedList**: doubly linked nodes. O(1) at the ends and via an iterator, O(n) `get(i)`, poor cache locality and several times the memory per element. `ArrayList` or `ArrayDeque` almost always win.
- `Arrays.asList(...)`: fixed-size view of the array (`set` works, `add`/`remove` throw `UnsupportedOperationException`). `List.of(...)`: fully immutable, no nulls.
- Modifying a list inside a for-each loop → `ConcurrentModificationException` (fail-fast iterators check `modCount`). Use `iterator.remove()` or `removeIf`.
- `List<Integer>.remove(1)` removes **index** 1. To remove the value use `remove(Integer.valueOf(1))`.
- `subList` is a view; structural changes to the parent list invalidate it.

## HashMap
- An array of buckets. Index = `(n - 1) & (h ^ (h >>> 16))`, where `n` is a power of two. Collisions go into a linked list; a bucket with ≥ 8 entries becomes a red-black tree if the table has ≥ 64 buckets (back to a list at ≤ 6).
- Default capacity 16, load factor 0.75: the table doubles when size exceeds 12. Resizing is O(n).
- One `null` key (stored in bucket 0) and any number of `null` values are allowed.
- Not thread-safe: concurrent `put`s can lose entries. In Java 7 a concurrent resize could even produce an infinite loop.
- Iteration order is unspecified and can change after a resize. **LinkedHashMap** keeps insertion order, or access order (an LRU cache via `removeEldestEntry`).
- Presizing for `n` elements: `HashMap.newHashMap(n)` (Java 19). `new HashMap<>(n)` sets buckets, not entries, and may still resize before reaching `n`.

## TreeMap and sorted collections
- Red-black tree: `get`/`put`/`remove` O(log n), keys sorted by `compareTo` or a `Comparator`.
- `NavigableMap` API: `floorKey`, `ceilingKey`, `lowerKey`, `higherKey`, `headMap`, `tailMap`, `subMap`, `firstEntry`, `pollFirstEntry`.
- A `null` key throws NPE with natural ordering.
- Uniqueness is decided by `compareTo` (== 0), not `equals`. An inconsistent comparator silently merges "different" keys.

## Sets
- `HashSet` is a `HashMap` with a dummy value; `LinkedHashSet` keeps insertion order; `TreeSet` is a `TreeMap`.
- `EnumSet` is a bit vector and `EnumMap` an array indexed by `ordinal()`: the fastest and most compact choice for enum keys.
- `add` returns `false` if the element was already there, handy for deduplication.

## Queues and Deques
- **ArrayDeque**: a circular array, the best general stack and queue (faster than `Stack` and `LinkedList`). No `null`s.
- **PriorityQueue**: a binary heap. `offer`/`poll` O(log n), `peek` O(1). Its iterator is **not** sorted; only repeated `poll` gives order.
- `Stack` extends `Vector` (synchronized, legacy). Use `Deque` with `push`/`pop`.

## Immutability & misc
- `List.of`/`Set.of`/`Map.of` (Java 9): immutable, no `null`s. `Set.of` and `Map.of` throw on duplicates, and their iteration order is randomized per JVM run.
- `Collections.unmodifiableList(list)` is a read-only **view**: changes to the original show through. `List.copyOf` makes a real immutable copy.
- `List.sort`/`Collections.sort` use TimSort: stable, O(n log n), fast on nearly sorted data.
- Java 21 sequenced collections: `getFirst()`, `getLast()`, `addFirst()`, `reversed()` on `List`, `Deque`, `LinkedHashSet`, `LinkedHashMap`...
- `WeakHashMap`: entries disappear once the key isn't strongly reachable. `IdentityHashMap`: compares keys with `==`.
- Big-O cheat sheet: `ArrayList.contains` O(n), `HashSet.contains` O(1) average, `TreeSet.contains` O(log n).
