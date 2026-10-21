# Multithreading & Java Memory Model

## Threads
- Ways to run code concurrently: extend `Thread`, pass a `Runnable`, submit a `Runnable`/`Callable` to an `ExecutorService`, or use virtual threads (`Thread.ofVirtual().start(...)`, `Executors.newVirtualThreadPerTaskExecutor()`).
- `start()` creates a new thread that calls `run()`. Calling `run()` directly just runs it in the current thread. Calling `start()` twice throws `IllegalThreadStateException`.
- **States**: `NEW` → `RUNNABLE` → `BLOCKED` (waiting to enter a `synchronized` block) / `WAITING` (`wait()`, `join()`, `park()` without timeout) / `TIMED_WAITING` (`sleep`, timed `wait`/`join`) → `TERMINATED`.
- **Daemon** threads don't keep the JVM alive. When only daemons remain the JVM exits, and their `finally` blocks may not run.
- `join()` waits for a thread to finish. `sleep()` keeps the monitors it holds; `wait()` releases the monitor.

## Interruption
- Interruption is cooperative: `interrupt()` only sets a flag. A CPU loop that never checks `Thread.currentThread().isInterrupted()` keeps running.
- Blocking methods (`sleep`, `wait`, `join`, `BlockingQueue.take`...) throw `InterruptedException` and **clear** the flag.
- Never swallow it: rethrow, or restore the flag with `Thread.currentThread().interrupt()`.

## synchronized
- Every object has an intrinsic lock (monitor). A `synchronized` instance method locks `this`; a `static synchronized` method locks the `Class` object, so they don't block each other.
- Reentrant: a thread holding the lock can enter other `synchronized` code on the same lock.
- Gives **mutual exclusion and visibility**: everything written before unlock is visible to the next thread that locks the same monitor.
- `wait`/`notify`/`notifyAll` require holding the monitor (otherwise `IllegalMonitorStateException`). Always `wait()` in a `while (!condition)` loop: spurious wakeups happen, and the condition can change before the lock is reacquired.

## volatile
- Guarantees **visibility and ordering**: a write is visible to subsequent reads, and the compiler/CPU can't reorder around it.
- Does **not** give atomicity: `volatileCount++` is read-modify-write and still races. Use `AtomicInteger`/`LongAdder` or a lock.
- Typical uses: stop flags, publishing an immutable object, the field in double-checked locking.
- Without `volatile` a busy loop `while (running) {}` may never see `running = false`: the JIT can hoist the read out of the loop.

## Java Memory Model: happens-before
- Program order inside one thread.
- Unlock of a monitor → every later lock of the same monitor.
- Volatile write → every later read of the same variable.
- `Thread.start()` → actions of the started thread; actions of a thread → another thread returning from its `join()`.
- Final fields: values set in the constructor are visible to all threads, if `this` doesn't escape during construction.
- No happens-before edge = **data race**: stale values, reordered writes, partially constructed objects. `Thread.sleep` creates no edge.
- Non-volatile `long`/`double` writes may be split into two 32-bit writes (JLS 17.7).
- **Double-checked locking** needs the field to be `volatile`, otherwise another thread can see a non-null reference to a half-constructed object. A holder-class idiom or an `enum` singleton avoids the problem.

## Concurrency problems
- **Race condition**: the result depends on interleaving (check-then-act, read-modify-write).
- **Deadlock** needs all four Coffman conditions: mutual exclusion, hold-and-wait, no preemption, circular wait. Fixes: a global lock order, `tryLock` with a timeout, fewer nested locks. Find it with `jstack` or a thread dump.
- **Livelock**: threads keep reacting to each other and make no progress. **Starvation**: a thread never gets a CPU or lock (unfair locks, priorities).
- Ways to avoid sharing: thread confinement, immutable objects, `ThreadLocal`. In thread pools, always `ThreadLocal.remove()` in `finally`, or values leak into the next task.

## Virtual threads (Java 21)
- Cheap threads scheduled by the JVM onto a few carrier threads (a `ForkJoinPool`). On blocking I/O the virtual thread unmounts and frees the carrier.
- **Pinning**: in JDK 21 a virtual thread blocked inside `synchronized` or a native call stays mounted on its carrier. JDK 24 (JEP 491) removed pinning for `synchronized`.
- Don't pool virtual threads: create one per task. Limit access to scarce resources (DB connections) with a `Semaphore`.
- Best for I/O-bound, thread-per-request code. They don't speed up CPU-bound work.
