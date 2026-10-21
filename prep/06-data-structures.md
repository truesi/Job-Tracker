# Data structures & algorithms

## Big-O
- Typical orders: O(1) < O(log n) < O(n) < O(n log n) < O(n²) < O(2ⁿ) < O(n!).
- Name both **time and space**. Distinguish worst, average and **amortized** cost (dynamic array append: O(1) amortized, O(n) at a resize).
- Comparison sorting can't beat Ω(n log n). Counting and radix sort get O(n + k) by not comparing.
- Recursion costs stack space: O(depth).

## Arrays and linked lists
- **Array**: O(1) index access, contiguous and cache-friendly; insert/delete in the middle O(n).
- **Linked list**: O(1) insert/delete once you have the node, O(n) search and index.
- Classic tasks: reverse a list, detect a cycle (Floyd's slow/fast pointers), find the middle (slow/fast), merge two sorted lists, remove the n-th node from the end (two pointers n apart).

## Stacks and queues
- **Stack** (LIFO): parentheses matching, undo, DFS, expression evaluation. A **monotonic stack** solves "next greater element" in O(n).
- **Queue** (FIFO): BFS, buffering, producer-consumer. A **deque** gives O(n) sliding-window maximum.

## Hash tables
- O(1) average lookup/insert; O(n) worst case when everything collides.
- Collisions are resolved by chaining (Java's `HashMap`) or open addressing (linear probing, used by Python's dict and many C++ maps).
- Load factor and resizing keep chains short; a good hash spreads keys uniformly.
- Typical uses: counting, deduplication, grouping, two-sum ("have I seen the complement?"), caching.

## Trees
- **BST**: O(log n) if balanced, O(n) if it degenerates (keys inserted in sorted order). In-order traversal of a BST yields sorted keys.
- Traversals: pre-order, in-order, post-order (DFS), level-order (BFS with a queue).
- Balanced trees: **AVL** (stricter balance, faster lookups), **red-black** (fewer rotations, used by `TreeMap`). **B-tree / B+tree**: wide nodes with hundreds of keys, few levels, the structure of database indexes.
- **Heap**: a complete binary tree stored in an array; min or max at the root. Insert/extract O(log n), peek O(1), heapify O(n). Priority queues, top-K, Dijkstra.
- **Trie**: prefix tree; lookup O(key length). Autocomplete, prefix search.

## Graphs
- Representation: adjacency list (sparse graphs, O(V + E) memory) or adjacency matrix (dense graphs, O(V²)).
- **BFS**: shortest path in an unweighted graph, O(V + E). **DFS**: cycle detection, connected components, topological sort.
- **Dijkstra**: shortest paths with non-negative weights, O((V + E) log V) with a heap. **Bellman-Ford**: allows negative weights, O(V·E).
- **Topological sort** (Kahn's algorithm): ordering tasks with dependencies in a DAG.
- **Union-Find** (disjoint set union): connectivity queries, Kruskal's minimum spanning tree; nearly O(1) per operation.

## Algorithm techniques
- **Two pointers** (sorted arrays, pairs), **sliding window** (subarrays and substrings), **binary search** (also "binary search on the answer").
- **Recursion + memoization** and **dynamic programming**: overlapping subproblems + optimal substructure. **Greedy**: a local choice that's provably safe. **Backtracking**: try, recurse, undo.
- Sorting: quicksort O(n log n) average, O(n²) worst, in place, not stable. Merge sort O(n log n) guaranteed, stable, O(n) extra memory. Heapsort O(n log n), in place, not stable.
- Binary search needs sorted input; compute `mid = lo + (hi - lo) / 2` to avoid int overflow.
- System-design-flavored structures: **Bloom filter** (false positives possible, no false negatives), **LRU cache** (hash map + doubly linked list), **skip list**, **consistent hashing**.
