# Data structures & algorithms: deep dive

This page goes deeper on the short notes, section by section, with Java solutions to classic interview tasks. In a live coding round, say the brute force and its complexity first, then improve it out loud.

## Big-O

### How to estimate quickly
- Nested loops over the same input: multiply. Sequential steps: add and keep the largest.
- Halving the problem each step: log n. Recursion with branching factor b and depth d: about bᵈ calls.
- **Master theorem** for `T(n) = a·T(n/b) + O(nᵈ)`: if d > log_b a → O(nᵈ); if d = log_b a → O(nᵈ log n); else O(n^(log_b a)). Merge sort: a = 2, b = 2, d = 1, so O(n log n).
- Rough feasibility for ~1 second of work: n ≤ 10⁸ for O(n), 10⁶ for O(n log n), 10⁴ for O(n²), 25 for O(2ⁿ).

### Amortized analysis
A dynamic array that doubles when full copies 1 + 2 + 4 + ... + n < 2n elements over n appends, so each append costs O(1) on average over the whole sequence. That's a worst-case guarantee for the sequence, not a probabilistic "average case".

Read more: [Big-O cheat sheet](https://www.bigocheatsheet.com/) · [Master theorem](https://en.wikipedia.org/wiki/Master_theorem_%28analysis_of_algorithms%29)

## Arrays and linked lists

### Reverse a linked list
```java
ListNode reverse(ListNode head) {
    ListNode prev = null;
    while (head != null) {
        ListNode next = head.next;
        head.next = prev;
        prev = head;
        head = next;
    }
    return prev;
}
```

### Floyd's cycle detection, and where the cycle starts
```java
ListNode cycleStart(ListNode head) {
    ListNode slow = head, fast = head;
    while (fast != null && fast.next != null) {
        slow = slow.next;
        fast = fast.next.next;
        if (slow == fast) {                 // they met inside the cycle
            slow = head;
            while (slow != fast) {          // the distance head → start equals meet → start
                slow = slow.next;
                fast = fast.next;
            }
            return slow;
        }
    }
    return null;
}
```
The same slow/fast trick finds the middle of a list (when fast reaches the end, slow is in the middle).

### Prefix sums
`prefix[i] = a[0] + ... + a[i-1]` turns any range sum into `prefix[r + 1] - prefix[l]`, O(1) after O(n) setup. Combined with a hash map it counts subarrays with sum k in O(n).

Read more: [VisuAlgo: linked lists, sorting, trees, graphs animated](https://visualgo.net/en)

## Stacks and queues

### Monotonic stack: next greater element
```java
int[] nextGreater(int[] a) {
    int[] result = new int[a.length];
    Arrays.fill(result, -1);
    Deque<Integer> stack = new ArrayDeque<>();      // indexes, values decreasing
    for (int i = 0; i < a.length; i++) {
        while (!stack.isEmpty() && a[stack.peek()] < a[i]) {
            result[stack.pop()] = a[i];
        }
        stack.push(i);
    }
    return result;
}
```
Each index is pushed and popped once: O(n). The same pattern solves "daily temperatures", "largest rectangle in histogram" and "stock span".

### Valid parentheses
```java
boolean isValid(String s) {
    Deque<Character> stack = new ArrayDeque<>();
    for (char c : s.toCharArray()) {
        switch (c) {
            case '(' -> stack.push(')');
            case '[' -> stack.push(']');
            case '{' -> stack.push('}');
            default -> { if (stack.isEmpty() || stack.pop() != c) return false; }
        }
    }
    return stack.isEmpty();
}
```

### Sliding window maximum with a deque
Keep indexes in a deque with decreasing values; drop indexes that left the window from the front and smaller values from the back. The front is always the window's maximum: O(n) total.

## Hash tables

### Chaining vs open addressing
- **Chaining**: each bucket holds a list (or tree) of entries. Simple, and tolerates high load factors.
- **Open addressing**: on a collision, probe other slots in the same array (linear: i+1, i+2...). Better cache locality, but the load factor must stay low, and deletions need tombstones.

### Two-sum and friends
```java
int[] twoSum(int[] nums, int target) {
    Map<Integer, Integer> seen = new HashMap<>();
    for (int i = 0; i < nums.length; i++) {
        Integer j = seen.get(target - nums[i]);
        if (j != null) return new int[] {j, i};
        seen.put(nums[i], i);
    }
    return null;
}
```
Related patterns: grouping anagrams (key = sorted letters), longest consecutive sequence (a set, start counting only where `x - 1` is absent: O(n)), and frequency counting with `merge(x, 1, Integer::sum)`.

## Trees

### Traversals
```java
void inorder(TreeNode n, List<Integer> out) {          // sorted for a BST
    if (n == null) return;
    inorder(n.left, out);
    out.add(n.val);
    inorder(n.right, out);
}

List<List<Integer>> levels(TreeNode root) {             // BFS by level
    List<List<Integer>> result = new ArrayList<>();
    Deque<TreeNode> queue = new ArrayDeque<>();
    if (root != null) queue.add(root);
    while (!queue.isEmpty()) {
        List<Integer> level = new ArrayList<>();
        for (int size = queue.size(); size > 0; size--) {
            TreeNode n = queue.poll();
            level.add(n.val);
            if (n.left != null) queue.add(n.left);
            if (n.right != null) queue.add(n.right);
        }
        result.add(level);
    }
    return result;
}
```

### Validate a BST
Comparing a node only with its children is the classic wrong answer. Pass down the allowed range:
```java
boolean isBst(TreeNode n, long min, long max) {
    if (n == null) return true;
    if (n.val <= min || n.val >= max) return false;
    return isBst(n.left, min, n.val) && isBst(n.right, n.val, max);
}
// isBst(root, Long.MIN_VALUE, Long.MAX_VALUE)
```

### B-tree vs B+tree
In a **B+tree** all values (or row pointers) live in the leaves, internal nodes hold only separator keys (so they fit more keys, giving higher fan-out), and leaves are linked for range scans. Nearly every relational index is a B+tree, often just called "B-tree".

### Heaps
Array layout: children of `i` at `2i + 1` and `2i + 2`, parent at `(i - 1) / 2`. Heapsort = heapify, then repeatedly swap the root to the end and sift down: O(n log n), in place.

Read more: [Algorithms, 4th ed. (Sedgewick & Wayne), book site](https://algs4.cs.princeton.edu/home/)

## Graphs

### BFS on a grid
```java
int shortestPath(char[][] grid, int sr, int sc, int tr, int tc) {
    int rows = grid.length, cols = grid[0].length;
    int[][] dist = new int[rows][cols];
    for (int[] row : dist) Arrays.fill(row, -1);
    Deque<int[]> queue = new ArrayDeque<>();
    queue.add(new int[] {sr, sc});
    dist[sr][sc] = 0;
    int[][] dirs = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
    while (!queue.isEmpty()) {
        int[] cur = queue.poll();
        if (cur[0] == tr && cur[1] == tc) return dist[tr][tc];
        for (int[] d : dirs) {
            int r = cur[0] + d[0], c = cur[1] + d[1];
            if (r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] != '#' && dist[r][c] == -1) {
                dist[r][c] = dist[cur[0]][cur[1]] + 1;
                queue.add(new int[] {r, c});
            }
        }
    }
    return -1;
}
```

### Dijkstra
```java
long[] dijkstra(List<List<int[]>> adj, int src) {       // adj.get(u) = list of {v, weight}
    long[] dist = new long[adj.size()];
    Arrays.fill(dist, Long.MAX_VALUE);
    dist[src] = 0;
    PriorityQueue<long[]> pq = new PriorityQueue<>(Comparator.comparingLong(x -> x[1]));
    pq.add(new long[] {src, 0});
    while (!pq.isEmpty()) {
        long[] top = pq.poll();
        int u = (int) top[0];
        if (top[1] > dist[u]) continue;                   // stale entry, skip
        for (int[] e : adj.get(u)) {
            long nd = dist[u] + e[1];
            if (nd < dist[e[0]]) {
                dist[e[0]] = nd;
                pq.add(new long[] {e[0], nd});
            }
        }
    }
    return dist;
}
```

### Topological sort (Kahn)
```java
List<Integer> topoSort(int n, int[][] edges) {          // edge {a, b}: a before b
    List<List<Integer>> adj = new ArrayList<>();
    int[] indegree = new int[n];
    for (int i = 0; i < n; i++) adj.add(new ArrayList<>());
    for (int[] e : edges) { adj.get(e[0]).add(e[1]); indegree[e[1]]++; }
    Deque<Integer> queue = new ArrayDeque<>();
    for (int i = 0; i < n; i++) if (indegree[i] == 0) queue.add(i);
    List<Integer> order = new ArrayList<>();
    while (!queue.isEmpty()) {
        int u = queue.poll();
        order.add(u);
        for (int v : adj.get(u)) if (--indegree[v] == 0) queue.add(v);
    }
    return order.size() == n ? order : null;              // null: there's a cycle
}
```

### Union-Find
```java
int[] parent, rank;
int find(int x) { return parent[x] == x ? x : (parent[x] = find(parent[x])); }   // path compression
boolean union(int a, int b) {
    int ra = find(a), rb = find(b);
    if (ra == rb) return false;
    if (rank[ra] < rank[rb]) { int t = ra; ra = rb; rb = t; }
    parent[rb] = ra;                                                              // union by rank
    if (rank[ra] == rank[rb]) rank[ra]++;
    return true;
}
```
With both optimizations each operation costs O(α(n)), effectively constant.

Read more: [cp-algorithms: Dijkstra](https://cp-algorithms.com/graph/dijkstra.html) · [cp-algorithms: topological sort](https://cp-algorithms.com/graph/topological-sort.html) · [cp-algorithms: disjoint set union](https://cp-algorithms.com/data_structures/disjoint_set_union.html)

## Algorithm techniques

### Binary search, the version that doesn't break
```java
// first index with a[i] >= target (a.length if none)
int lowerBound(int[] a, int target) {
    int lo = 0, hi = a.length;              // half-open [lo, hi)
    while (lo < hi) {
        int mid = (lo + hi) >>> 1;
        if (a[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
```
**Binary search on the answer**: when "can we do it with X?" is monotonic in X (minimum capacity to ship in D days, minimum eating speed), binary-search X and check feasibility each time.

### Sliding window: longest substring without repeats
```java
int longestUnique(String s) {
    Map<Character, Integer> last = new HashMap<>();
    int best = 0;
    for (int left = 0, right = 0; right < s.length(); right++) {
        Integer seen = last.put(s.charAt(right), right);
        if (seen != null && seen >= left) left = seen + 1;   // shrink past the duplicate
        best = Math.max(best, right - left + 1);
    }
    return best;
}
```

### Dynamic programming: coin change
```java
int minCoins(int[] coins, int amount) {
    int[] dp = new int[amount + 1];                  // dp[x] = min coins for sum x
    Arrays.fill(dp, Integer.MAX_VALUE);
    dp[0] = 0;
    for (int x = 1; x <= amount; x++) {
        for (int c : coins) {
            if (c <= x && dp[x - c] != Integer.MAX_VALUE) {
                dp[x] = Math.min(dp[x], dp[x - c] + 1);
            }
        }
    }
    return dp[amount] == Integer.MAX_VALUE ? -1 : dp[amount];
}
```
The recipe: define the state (`dp[x]`), the transition (`dp[x - c] + 1`), the base case (`dp[0] = 0`) and the evaluation order. Greedy (take the biggest coin) fails for coins {1, 3, 4} and amount 6: greedy gives 4+1+1, optimal is 3+3.

### Backtracking: subsets
```java
void subsets(int[] nums, int start, Deque<Integer> current, List<List<Integer>> out) {
    out.add(new ArrayList<>(current));
    for (int i = start; i < nums.length; i++) {
        current.addLast(nums[i]);                    // choose
        subsets(nums, i + 1, current, out);          // explore
        current.removeLast();                        // un-choose
    }
}
```

Read more: [NeetCode roadmap: problems grouped by pattern](https://neetcode.io/roadmap) · [cp-algorithms](https://cp-algorithms.com/) · [Bloom filter](https://en.wikipedia.org/wiki/Bloom_filter)

## Sources
- Robert Sedgewick, Kevin Wayne, *Algorithms*, 4th edition ([book site with Java code](https://algs4.cs.princeton.edu/home/)): the best fit for a Java developer.
- Cormen et al., *Introduction to Algorithms* (CLRS): the reference for proofs.
- [VisuAlgo](https://visualgo.net/en): animations of every structure above.
- [NeetCode 150](https://neetcode.io/roadmap): enough practice to cover the usual interview patterns.
