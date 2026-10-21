# GC & JVM memory

## JVM memory areas
- **Heap**: all objects. Young generation (Eden + two Survivor spaces) and old generation.
- **Metaspace**: class metadata, in native memory. It replaced PermGen in Java 8 and is unlimited unless you set `-XX:MaxMetaspaceSize`.
- **Thread stacks**: frames with locals and operand stacks, one per thread (`-Xss`). Deep recursion → `StackOverflowError`.
- **Code cache**: JIT-compiled code. **Direct buffers** (`ByteBuffer.allocateDirect`, Netty): off-heap.
- Flags: `-Xms`/`-Xmx` for the heap. In containers, `-XX:MaxRAMPercentage` (default 25% of the container limit).
- OutOfMemoryError flavors: `Java heap space`, `Metaspace`, `GC overhead limit exceeded`, `unable to create native thread`, `Direct buffer memory`.

## Garbage collection basics
- An object is alive if it's reachable from **GC roots**: locals and parameters of live stack frames, static fields, JNI references, monitors in use. Unreachable cycles are collected too: tracing, not reference counting.
- **Generational hypothesis**: most objects die young. A minor (young) GC is frequent and cheap; objects that survive several minor GCs (age up to 15) are promoted to the old generation.
- Algorithms: mark-sweep, mark-compact (no fragmentation), copying (young gen: live objects copied from Eden + Survivor to the other Survivor).
- **Stop-the-world** pauses happen at safepoints. A card table plus write barriers track old → young references, so a minor GC doesn't scan the whole old gen.
- Allocation is very cheap: a bump of a pointer in the thread's own **TLAB** (thread-local allocation buffer).
- `System.gc()` is only a hint.

## Collectors
- **Serial**: one thread, for small heaps or 1-CPU containers.
- **Parallel**: multi-threaded stop-the-world, best throughput. The default up to Java 8.
- **G1** (default since Java 9): heap split into equal regions (1–32 MB), collects the regions with the most garbage first, targets a pause goal (`-XX:MaxGCPauseMillis`, default 200 ms). Objects ≥ half a region are *humongous*.
- **ZGC**: concurrent marking and relocation, pauses under 1 ms regardless of heap size (up to terabytes). Generational since JDK 21.
- **Shenandoah**: concurrent compaction too (from Red Hat). **Epsilon**: allocates and never collects, for tests and benchmarks.
- CMS was deprecated in 9 and removed in 14.

## References
- **Strong**: normal references.
- **Soft**: cleared only under memory pressure, guaranteed before an OOM. Memory-sensitive caches (with care).
- **Weak**: cleared at the next GC once the object is only weakly reachable. `WeakHashMap`, canonicalizing maps.
- **Phantom**: `get()` always returns null; it signals that an object is gone, for cleanup. `Cleaner` is built on it.
- `finalize()` is deprecated for removal: unpredictable, slow, and it can resurrect objects. Use try-with-resources and `Cleaner`.

## Memory leaks in Java
- A leak = objects still reachable but no longer needed. Typical causes: static collections that only grow, caches without eviction, listeners never removed, `ThreadLocal`s on pool threads, inner classes holding their outer instance, classloader leaks on redeploy.
- Symptom: the old gen's occupancy after each full GC keeps rising.
- Tools: `-XX:+HeapDumpOnOutOfMemoryError`, `jcmd <pid> GC.heap_dump`, Eclipse MAT (dominator tree, retained size, path to GC roots), JFR + JDK Mission Control, GC logs (`-Xlog:gc*`), `jstat -gcutil`, async-profiler (allocation profiling).

## JIT and class loading
- Tiered compilation: interpreter → C1 (fast compile, profiling) → C2 (aggressive optimization) for hot methods.
- Key optimizations: **inlining**, **escape analysis** (an object that doesn't escape can be scalar-replaced, never allocated on the heap), loop unrolling, lock elision. **Deoptimization** happens when an assumption breaks.
- Class loaders: bootstrap → platform → application. **Parent delegation**: a loader asks its parent first, so nobody can replace `java.lang.String`.
- Lifecycle: loading → linking (verify, prepare, resolve) → initialization (static initializers, on first active use).
- `ClassNotFoundException`: explicit loading by name failed. `NoClassDefFoundError`: the class was there at compile time but is missing (or failed to initialize) at runtime.
