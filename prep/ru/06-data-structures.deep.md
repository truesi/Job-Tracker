# Структуры данных и алгоритмы: подробно

Здесь разделы краткого конспекта разобраны глубже, с решениями классических задач на Java. На live coding сначала назови решение в лоб и его сложность, потом улучшай вслух.

## Big-O

### Как быстро оценить
- Вложенные циклы по одному входу: перемножай. Последовательные шаги: складывай и оставляй наибольшее.
- Уменьшение задачи вдвое на каждом шаге: log n. Рекурсия с ветвлением b и глубиной d: около bᵈ вызовов.
- **Мастер-теорема** для `T(n) = a·T(n/b) + O(nᵈ)`: если d > log_b a → O(nᵈ); если d = log_b a → O(nᵈ log n); иначе O(n^(log_b a)). Merge sort: a = 2, b = 2, d = 1, значит O(n log n).
- Грубая прикидка на ~1 секунду работы: n ≤ 10⁸ для O(n), 10⁶ для O(n log n), 10⁴ для O(n²), 25 для O(2ⁿ).

### Амортизированный анализ
Динамический массив, который удваивается при заполнении, копирует 1 + 2 + 4 + ... + n < 2n элементов за n добавлений, поэтому каждое добавление в среднем по всей последовательности стоит O(1). Это гарантия худшего случая для последовательности, а не вероятностный "средний случай".

Подробнее: [Big-O cheat sheet](https://www.bigocheatsheet.com/) · [Мастер-теорема](https://en.wikipedia.org/wiki/Master_theorem_%28analysis_of_algorithms%29)

## Массивы и связные списки

### Развернуть связный список
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

### Поиск цикла Флойда и где цикл начинается
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
Тот же приём с медленным и быстрым указателями находит середину списка (когда быстрый доходит до конца, медленный в середине).

### Префиксные суммы
`prefix[i] = a[0] + ... + a[i-1]` превращает любую сумму на отрезке в `prefix[r + 1] - prefix[l]`, O(1) после подготовки за O(n). Вместе с хеш-таблицей это считает подмассивы с суммой k за O(n).

Подробнее: [VisuAlgo: анимации списков, сортировок, деревьев, графов](https://visualgo.net/en)

## Стеки и очереди

### Монотонный стек: следующий больший элемент
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
Каждый индекс кладётся и снимается один раз: O(n). Тот же паттерн решает "daily temperatures", "largest rectangle in histogram" и "stock span".

### Правильные скобки
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

### Максимум в скользящем окне через дек
Держи в деке индексы с убывающими значениями; спереди выбрасывай индексы, вышедшие из окна, сзади меньшие значения. Спереди всегда максимум окна: O(n) в сумме.

## Хеш-таблицы

### Цепочки vs открытая адресация
- **Цепочки**: в каждом bucket список (или дерево) элементов. Просто и терпимо к высокому load factor.
- **Открытая адресация**: при коллизии пробуем другие ячейки того же массива (линейно: i+1, i+2...). Лучше локальность кэша, но load factor должен оставаться низким, а удаление требует "надгробий".

### Two-sum и родственные задачи
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
Родственные паттерны: группировка анаграмм (ключ = отсортированные буквы), самая длинная последовательность подряд идущих чисел (множество, считать только там, где нет `x - 1`: O(n)), подсчёт частот через `merge(x, 1, Integer::sum)`.

## Деревья

### Обходы
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

### Проверить, что дерево это BST
Сравнивать узел только с детьми это классический неправильный ответ. Передавай вниз допустимый диапазон:
```java
boolean isBst(TreeNode n, long min, long max) {
    if (n == null) return true;
    if (n.val <= min || n.val >= max) return false;
    return isBst(n.left, min, n.val) && isBst(n.right, n.val, max);
}
// isBst(root, Long.MIN_VALUE, Long.MAX_VALUE)
```

### B-tree vs B+tree
В **B+tree** все значения (или указатели на строки) лежат в листьях, внутренние узлы хранят только разделяющие ключи (поэтому вмещают больше ключей и дают больший fan-out), а листья связаны для range-сканов. Почти любой реляционный индекс это B+tree, часто его называют просто "B-tree".

### Кучи
Раскладка в массиве: дети `i` в `2i + 1` и `2i + 2`, родитель в `(i - 1) / 2`. Heapsort = heapify, затем раз за разом меняем корень с концом и опускаем вниз: O(n log n) на месте.

Подробнее: [Algorithms, 4th ed. (Sedgewick & Wayne), сайт книги](https://algs4.cs.princeton.edu/home/)

## Графы

### BFS по сетке
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

### Дейкстра
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

### Топологическая сортировка (Кан)
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
С обеими оптимизациями каждая операция стоит O(α(n)), то есть фактически константу.

Подробнее: [cp-algorithms: Dijkstra](https://cp-algorithms.com/graph/dijkstra.html) · [cp-algorithms: topological sort](https://cp-algorithms.com/graph/topological-sort.html) · [cp-algorithms: disjoint set union](https://cp-algorithms.com/data_structures/disjoint_set_union.html)

## Алгоритмические приёмы

### Бинарный поиск, версия, которая не ломается
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
**Бинарный поиск по ответу**: когда "справимся ли с X?" монотонно по X (минимальная грузоподъёмность, чтобы перевезти за D дней, минимальная скорость поедания), ищи X бинарным поиском и каждый раз проверяй выполнимость.

### Скользящее окно: самая длинная подстрока без повторов
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

### Динамическое программирование: размен монет
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
Рецепт: определить состояние (`dp[x]`), переход (`dp[x - c] + 1`), базовый случай (`dp[0] = 0`) и порядок вычисления. Жадный подход (брать самую крупную монету) ломается для монет {1, 3, 4} и суммы 6: жадно получается 4+1+1, оптимально 3+3.

### Backtracking: подмножества
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

Подробнее: [NeetCode roadmap: задачи, сгруппированные по паттернам](https://neetcode.io/roadmap) · [cp-algorithms](https://cp-algorithms.com/) · [Фильтр Блума](https://en.wikipedia.org/wiki/Bloom_filter)

## Источники
- Robert Sedgewick, Kevin Wayne, *Algorithms*, 4-е издание ([сайт книги с кодом на Java](https://algs4.cs.princeton.edu/home/)): лучше всего подходит Java-разработчику.
- Кормен и др., *Алгоритмы: построение и анализ* (CLRS): справочник с доказательствами.
- [VisuAlgo](https://visualgo.net/en): анимации всех структур выше.
- [NeetCode 150](https://neetcode.io/roadmap): достаточно практики, чтобы покрыть обычные паттерны собеседований.
