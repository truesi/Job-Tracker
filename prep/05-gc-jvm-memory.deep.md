# GC & JVM memory: deep dive

This page goes deeper on the short notes, section by section. The Oracle GC tuning guide and Shipilёv's "JVM Anatomy Quarks" cover nearly everything here in more detail.

## JVM memory areas

### What an object costs
On a 64-bit JVM with compressed references (the default for heaps under ~32 GB):
- **Header**: an 8-byte mark word (hash code, GC age, lock state) + a 4-byte class pointer.
- **Fields**, then padding to a multiple of 8 bytes.

So `new Object()` is 16 bytes, an `Integer` is 16 bytes, and an empty `ArrayList` is ~24 bytes plus its array. Above ~32 GB compressed oops switch off and every reference doubles to 8 bytes, so a 33 GB heap can hold *less* than a 31 GB one. Inspect real layouts with JOL (Java Object Layout).

**Compact object headers** shrink the header to 8 bytes: experimental in JDK 24 (JEP 450) and a product feature in JDK 25 (JEP 519). That saves 10–20% of the heap in object-heavy apps.

### Process memory in a container
The container's limit has to hold far more than the heap:

`RSS ≈ heap + metaspace + threads × stack size + code cache + direct buffers + GC data structures + native libraries`

If `-Xmx` is too close to the limit, Kubernetes kills the pod with **OOMKilled** without any Java `OutOfMemoryError`. Common practice is `-XX:MaxRAMPercentage=70..75`, then measuring with **Native Memory Tracking**: start with `-XX:NativeMemoryTracking=summary` and run `jcmd <pid> VM.native_memory summary`.

Read more: [JOL (Java Object Layout)](https://github.com/openjdk/jol) · [JEP 519 Compact Object Headers](https://openjdk.org/jeps/519) · [Troubleshooting guide](https://docs.oracle.com/en/java/javase/21/troubleshoot/index.html)

## Garbage collection basics

### A minor GC, step by step
1. Eden fills up, and allocation fails.
2. Stop the world. Roots = stack frames, statics, plus **dirty cards** (old objects that recently got a reference to a young object).
3. Live objects in Eden and the "from" Survivor are copied to the "to" Survivor and their age is incremented. Objects past the tenuring threshold (or that don't fit in Survivor) are promoted to the old gen.
4. Eden and "from" are now empty in their entirety; the survivors swap roles.

The cost is proportional to **live** objects, not garbage. That's why lots of short-lived garbage is cheap, and why a cache that keeps many medium-lived objects is expensive: they get copied several times, then promoted.

### Concurrent marking
Concurrent collectors mark while the application keeps changing references. The tri-color abstraction: white (not yet seen), grey (seen, fields not scanned), black (done). The danger is the app storing a white object into a black one and removing the last grey path to it, which would wrongly free a live object. Barriers prevent this: G1 uses **SATB** (snapshot-at-the-beginning) pre-write barriers; ZGC uses **load barriers** on reference reads.

### Safepoints
STW phases need every thread at a **safepoint** (a place where the JVM knows the exact location of every reference). The JIT inserts safepoint polls at method returns and loop back-edges. A long loop with an `int` counter (a "counted loop") used to have no poll, so one thread could delay a pause for seconds. Modern JDKs strip-mine such loops to keep polls in. In GC logs, look at "time to safepoint" separately from the GC work.

### What triggers a full GC
Promotion failure (old gen can't take survivors), a full Metaspace, an explicit `System.gc()`, G1 evacuation failure, or a humongous allocation that can't fit. A full GC in G1 or Parallel compacts the whole heap, stop-the-world; frequent full GCs are always worth investigating.

Read more: [HotSpot GC tuning guide](https://docs.oracle.com/en/java/javase/21/gctuning/index.html) · [JVM Anatomy Quarks](https://shipilev.net/jvm/anatomy-quarks/)

## Collectors

| Collector | Flag | Pauses | Good for |
|---|---|---|---|
| Serial | `-XX:+UseSerialGC` | STW, single thread | tiny heaps, 1 CPU, CLI tools |
| Parallel | `-XX:+UseParallelGC` | STW, multi-threaded | batch jobs, max throughput |
| G1 | default / `-XX:+UseG1GC` | mostly short, goal-driven | general services, 4–64 GB heaps |
| ZGC | `-XX:+UseZGC` | < 1 ms | latency-sensitive, large heaps |
| Shenandoah | `-XX:+UseShenandoahGC` | < 10 ms, concurrent compaction | latency-sensitive (in OpenJDK builds that include it) |

### G1 in more detail
- The heap is ~2048 equal regions; each is Eden, Survivor, Old, Humongous or free at any moment.
- **Remembered sets** per region record incoming references, so any subset of regions can be evacuated alone.
- **Young collections** evacuate Eden and Survivor regions. When the old gen passes the IHOP threshold (initially 45%, adaptive), G1 starts **concurrent marking**, then runs **mixed collections** that also evacuate the old regions with the most garbage: hence "Garbage First".
- The pause goal (`MaxGCPauseMillis`) controls how many regions go into each collection. Setting it very low shrinks the young gen and causes more frequent GCs.
- Trouble signs in logs: `to-space exhausted` / evacuation failure (no room to copy survivors), and `Pause Full`. Fixes: more headroom, start marking earlier, find the allocation source.

### ZGC in more detail
- **Colored pointers**: metadata bits in each reference say which GC phase it's valid for.
- **Load barriers**: when the app loads a reference, a barrier checks the color and, if the object was moved, fixes the reference right away (self-healing). That's what allows concurrent relocation.
- Generational ZGC arrived in JDK 21 (JEP 439), became the default ZGC mode in JDK 23 (JEP 474), and the non-generational mode was removed in JDK 24 (JEP 490).
- The cost: some throughput and CPU for the barriers and concurrent threads, and it needs headroom: if allocation outpaces concurrent collection, threads stall ("allocation stall").

### Reading GC logs
```
-Xlog:gc*:file=gc.log:time,uptime,level,tags:filecount=5,filesize=20m
```
Look at pause times (p99, not the average), how often GCs run, old-gen occupancy after GC (is the baseline rising?), and allocation rate. Tools such as GCeasy or JDK Mission Control turn logs into charts.

Read more: [G1 tuning guide](https://docs.oracle.com/en/java/javase/21/gctuning/garbage-first-g1-garbage-collector1.html) · [ZGC guide](https://docs.oracle.com/en/java/javase/21/gctuning/z-garbage-collector.html) · [OpenJDK ZGC project](https://openjdk.org/projects/zgc/) · [JEP 439 Generational ZGC](https://openjdk.org/jeps/439) · [JEP 474 ZGC generational mode by default](https://openjdk.org/jeps/474)

## References

### Reference queues
Soft, weak and phantom references can be registered with a `ReferenceQueue`. When the GC clears the reference, it's enqueued, and a cleanup thread can poll the queue. That's how `WeakHashMap` expunges stale entries.

### Cleaner instead of finalize
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
The Cleaner is a **safety net** for when someone forgets `close()`, not the primary mechanism.

### Why finalize was a bad idea
Objects with a `finalize()` need at least two GC cycles to be freed, finalizers run on one low-priority thread (a slow one blocks all the rest), the order is undefined, and `finalize` can store `this` somewhere and resurrect the object. JEP 421 (JDK 18) deprecated finalization for removal.

Read more: [java.lang.ref package](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ref/package-summary.html) · [Cleaner javadoc](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ref/Cleaner.html) · [JEP 421 Deprecate Finalization for Removal](https://openjdk.org/jeps/421)

## Memory leaks in Java

### A diagnosis workflow
1. **Confirm**: old-gen usage *after* full GCs keeps rising over hours (a rising sawtooth baseline). High usage alone isn't a leak.
2. **Capture**: `jcmd <pid> GC.heap_dump /tmp/heap.hprof`, or have the JVM do it with `-XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/dumps`. Two dumps some time apart make growth obvious.
3. **Analyze** in Eclipse MAT: the *Leak Suspects* report, then the *Dominator Tree* sorted by retained heap, then *Path to GC Roots* (excluding weak/soft references) on the suspicious object.
4. **Fix the owner**, not the symptom: add eviction, remove the listener, clear the ThreadLocal.

### Leaks seen in real services
```java
// a "cache" that only grows
private static final Map<String, Report> CACHE = new HashMap<>();

// a ThreadLocal never cleared on a pool thread
private static final ThreadLocal<UserContext> CTX = new ThreadLocal<>();
```
- A long batch job with one JPA `EntityManager`: the persistence context keeps every loaded entity. Fix: `flush()` + `clear()` every N rows.
- Metaspace growth: classes generated at runtime (Groovy scripts compiled per request, proxies created in a loop) or old classloaders kept alive after redeploy.
- Unbounded queues in front of a slow consumer: technically not a leak, but it fills the heap the same way.

### Allocation profiling
High GC load without a leak means too much allocation. Find the source with JFR (`jcmd <pid> JFR.start duration=60s filename=rec.jfr`, then the allocation views in JDK Mission Control) or with async-profiler in `alloc` mode.

Read more: [Eclipse MAT](https://eclipse.dev/mat/) · [JDK Mission Control](https://www.oracle.com/java/technologies/jdk-mission-control.html) · [async-profiler](https://github.com/async-profiler/async-profiler)

## JIT and class loading

### Tiered compilation
| Level | What runs |
|---|---|
| 0 | interpreter, collects profile |
| 1–3 | C1-compiled code, with different amounts of profiling |
| 4 | C2-compiled code, fully optimized using the profile |

C2 optimizes **speculatively** using the profile: if a call site only ever saw one class, it inlines that class's method behind a cheap type check. When the assumption breaks (a new subclass is loaded, an "impossible" branch is taken), the code is **deoptimized** back to the interpreter and recompiled later. That's why benchmarks need warmup (use JMH), and why startup is slow; CDS archives, CRaC and the AOT cache from Project Leyden (JEP 483, JDK 24) attack that.

### Inlining and escape analysis
Inlining is the mother of all optimizations: it lets the JIT see across method boundaries. Small methods (bytecode ≤ 35 bytes) are always candidates; hot ones up to 325 bytes. Escape analysis then works on the inlined code:

```java
int lengthSquared(int x, int y) {
    Point p = new Point(x, y);      // never leaves this method once inlined:
    return p.x() * p.x() + p.y() * p.y();   // the JIT keeps x and y in registers, no allocation
}
```

### Class loading phases (JVMS chapter 5)
1. **Loading**: find the bytes and create the `Class` object.
2. **Linking**: *verification* (bytecode is type-safe), *preparation* (static fields get default values), *resolution* (symbolic references become direct, often lazily).
3. **Initialization**: static initializers and static field assignments run, once, under a lock, on first active use.

A class can be unloaded only when its class loader becomes unreachable, so classes of the application class loader stay loaded forever. Spring Boot fat jars use their own loader to read nested jars; app servers use one loader per web app, which is where redeploy leaks come from.

Read more: [JVMS chapter 5: Loading, Linking, and Initializing](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-5.html) · [JEP 483 Ahead-of-Time Class Loading & Linking](https://openjdk.org/jeps/483) · [JMH](https://github.com/openjdk/jmh)

## Sources
- [HotSpot Virtual Machine Garbage Collection Tuning Guide](https://docs.oracle.com/en/java/javase/21/gctuning/index.html): official, covers every collector.
- [Aleksey Shipilёv: JVM Anatomy Quarks](https://shipilev.net/jvm/anatomy-quarks/): short articles, each on one JVM mechanism.
- [Java Virtual Machine Specification SE 21](https://docs.oracle.com/javase/specs/jvms/se21/html/index.html)
- Scott Oaks, *Java Performance*, 2nd edition: GC, JIT and profiling, very practical.
