# Collections: deep dive

This page goes deeper on the short notes, section by section. The JDK sources are very readable: `HashMap.java` starts with a long "Implementation notes" comment that's worth reading once.

## List

### ArrayList growth and costs
- Growth: `newCapacity = old + (old >> 1)` (×1.5), then `Arrays.copyOf`. Adding n elements costs O(n) in total, so O(1) amortized per add.
- When you know the size, `new ArrayList<>(n)` or `ensureCapacity(n)` avoids the copies; `trimToSize()` returns the slack.
- `remove(i)` shifts the tail with `System.arraycopy`. Removing many elements one by one in a loop is O(n²); `removeIf` does one pass, O(n).

### Why LinkedList rarely wins
Each element is a `Node` object (header + item + next + prev ≈ 24–32 bytes) scattered across the heap. Walking it means a cache miss per node, while `ArrayList` scans memory sequentially, which CPUs prefetch. Even for inserts in the middle, `ArrayList`'s `arraycopy` usually beats LinkedList's walk to the position, for sizes up to many thousands. LinkedList only wins with an iterator already positioned and many inserts there.

### Fail-fast iterators
Every structural change increments `modCount`. The iterator remembers the value and compares it in `next()`. The check is **best-effort**: removing the second-to-last element makes `hasNext()` return false before the check runs (see the quiz). Never rely on CME for correctness. The same applies to `subList`: it checks the parent's `modCount` and throws CME after a structural change to the parent.

```java
list.removeIf(s -> s.isBlank());                // the right way

for (Iterator<String> it = list.iterator(); it.hasNext(); ) {
    if (it.next().isBlank()) it.remove();       // also fine
}
```

Read more: [ArrayList javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayList.html) · [List javadoc (unmodifiable lists)](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/List.html)

## HashMap

### put, step by step
1. `hash = key.hashCode() ^ (hashCode >>> 16)`: mixes the high bits into the low ones, since only the low bits pick the bucket.
2. `index = (n - 1) & hash`: this works as a modulo only because `n` is a power of two, and it's much cheaper.
3. Empty bucket → place a new node. Otherwise walk the bucket: same hash and (`==` or `equals`) → replace the value; otherwise append.
4. If the bucket reaches 8 nodes → treeify (or resize if the table is under 64).
5. `++size > threshold` → resize.

### Resize
The table doubles. Each bucket splits into two lists: entries whose next hash bit is 0 stay at index `i`, the others move to `i + oldCap`. Java 8 keeps their relative order. Java 7 inserted at the head and reversed lists during resize, which is how two concurrent resizes could create a **cycle**, making `get` spin forever at 100% CPU.

### Why trees in buckets
With a terrible `hashCode` (or an attacker sending keys with colliding `String` hashes, "hash flooding"), all keys land in one bucket and the map degrades to O(n) per operation. A tree bin bounds it to O(log n). Tree bins order nodes by hash, then by `compareTo` if keys are `Comparable`, so make keys `Comparable` if collisions are likely.

### Useful API beyond get/put
```java
counts.merge(word, 1, Integer::sum);                          // word count
index.computeIfAbsent(city, c -> new ArrayList<>()).add(user); // multimap
cache.getOrDefault(key, DEFAULT);
map.entrySet().removeIf(e -> e.getValue() == 0);
```

### Presizing
The constructor argument is the number of **buckets**, not entries. `new HashMap<>(128)` gets 128 buckets, whose threshold is 128 × 0.75 = 96, so it resizes before reaching 128 entries. For n entries without resizing, Java 19+ has `HashMap.newHashMap(n)`, which computes `n / 0.75` for you.

### LinkedHashMap as an LRU cache
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
It's not thread-safe. For production caches use Caffeine (size and time eviction, stats, high concurrency).

Read more: [HashMap javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/HashMap.html) · [HashMap source with implementation notes](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/HashMap.java) · [LinkedHashMap javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/LinkedHashMap.html)

## TreeMap and sorted collections

### Red-black tree guarantees
Each node is red or black, the root is black, red nodes have black children, and every root-to-leaf path has the same number of black nodes. Together these keep the height ≤ 2·log₂(n + 1), so every operation is O(log n), with at most a few rotations per insert or delete.

### NavigableMap in practice
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

### Comparator consistency
A `TreeMap` treats `compare(a, b) == 0` as "same key". A comparator by `lastName` only will silently drop a second person with the same last name. Always add tie-breakers: `comparing(Person::lastName).thenComparing(Person::id)`.

For a concurrent sorted map, use `ConcurrentSkipListMap` (a skip list, lock-free, O(log n) expected).

Read more: [TreeMap javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/TreeMap.html) · [NavigableMap javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/NavigableMap.html)

## Sets

- `Set.add` returning a boolean gives one-line deduplication: `if (seen.add(id)) process(item);`.
- Set algebra: `a.retainAll(b)` (intersection), `a.addAll(b)` (union), `a.removeAll(b)` (difference). They mutate `a`, so copy it first.
- Mutable elements are dangerous: change a field used by `hashCode` and `contains` stops finding the element, while iteration still shows it.
- `EnumSet` stores up to 64 constants in a single `long` (`RegularEnumSet`), and more in a `long[]` (`JumboEnumSet`). `EnumSet.of(READ, WRITE)` is the idiomatic replacement for bit flags.

Read more: [EnumSet javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/EnumSet.html)

## Queues and Deques

### ArrayDeque
A circular array with head and tail indexes, which grows when full. All end operations are amortized O(1), with no node allocation, so it's faster than `LinkedList` as a queue and than `Stack` as a stack. It forbids `null` because `poll()` uses `null` to mean "empty".

### PriorityQueue as a binary heap
Stored in an array: the children of `i` are `2i + 1` and `2i + 2`. `offer` appends and sifts up, `poll` moves the last element to the root and sifts down, both O(log n). Building from a collection heapifies in O(n).

**Top-K pattern**, which comes up in interviews and in code:
```java
PriorityQueue<Integer> heap = new PriorityQueue<>();     // min-heap
for (int x : nums) {
    heap.offer(x);
    if (heap.size() > k) heap.poll();                    // drop the smallest
}
int kthLargest = heap.peek();                            // O(n log k) total
```
For a max-heap, use `new PriorityQueue<>(Comparator.reverseOrder())`.

Read more: [ArrayDeque javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayDeque.html) · [PriorityQueue javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/PriorityQueue.html)

## Immutability & misc

### Three levels of "unmodifiable"
```java
List<String> source = new ArrayList<>(List.of("a"));
List<String> view = Collections.unmodifiableList(source);   // read-only view
List<String> copy = List.copyOf(source);                    // immutable snapshot
source.add("b");
view.size();   // 2: sees the change
copy.size();   // 1
```
`Stream.toList()` and `Collectors.toUnmodifiableList()` also give immutable lists. `List.of` and `List.copyOf` reject `null`s; `Stream.toList()` allows them.

### Randomized order in Set.of / Map.of
Their iteration order depends on a salt chosen at JVM startup, so it differs from run to run. That's deliberate: code (and tests) that depend on hash order break immediately, not after a JDK upgrade.

### TimSort and broken comparators
TimSort finds already-sorted runs and merges them: O(n) on sorted input, O(n log n) worst case, stable. If a comparator violates its contract (not transitive, or `compare(a, b) != -compare(b, a)`), it may throw `IllegalArgumentException: Comparison method violates its general contract!`. Classic causes are subtraction-based comparators that overflow, and comparators reading mutable state.

### Sequenced collections (Java 21)
New interfaces `SequencedCollection`, `SequencedSet` and `SequencedMap` give one API for collections with a defined order: `getFirst()`, `getLast()`, `addFirst()`, `addLast()`, `removeFirst()`, `removeLast()`, `reversed()`; for maps also `firstEntry()`, `pollLastEntry()`, `sequencedKeySet()`. Before that, the "last element" of a `LinkedHashSet` needed a full iteration.

Read more: [JEP 431 Sequenced Collections](https://openjdk.org/jeps/431) · [Collections javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Collections.html)

## Sources
- [Java Tutorial: Collections](https://docs.oracle.com/javase/tutorial/collections/index.html): interfaces, implementations and algorithms in one place.
- [OpenJDK sources, java.util](https://github.com/openjdk/jdk/tree/master/src/java.base/share/classes/java/util): read `HashMap`, `ArrayList` and `ArrayDeque` once; they're short and well commented.
- Joshua Bloch, *Effective Java*: items 10–14 (equals, hashCode, compareTo) explain most collection bugs.
