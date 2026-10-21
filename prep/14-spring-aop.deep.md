# Spring AOP: deep dive

This page goes deeper on the short notes, section by section. Understanding how proxies work explains nearly every "why didn't my @Transactional/@Cacheable/@Async work" question.

## Concepts

### A complete aspect
```java
@Target(ElementType.METHOD)
@Retention(RetentionPolicy.RUNTIME)
public @interface Audited {
    String action();
}

@Aspect
@Component
class AuditAspect {
    private final AuditLog auditLog;
    AuditAspect(AuditLog auditLog) { this.auditLog = auditLog; }

    @AfterReturning(pointcut = "@annotation(audited)", returning = "result")
    void audit(JoinPoint jp, Audited audited, Object result) {
        auditLog.record(audited.action(), jp.getSignature().toShortString(), jp.getArgs());
    }
}

@Service
class AccountService {
    @Audited(action = "CLOSE_ACCOUNT")
    public void close(long accountId) { ... }
}
```
Binding the annotation as a parameter (`@annotation(audited)` + `Audited audited`) gives access to its attributes without reflection code.

### The terms, mapped onto that example
| Term | In the example |
|---|---|
| Aspect | `AuditAspect` |
| Pointcut | `@annotation(audited)` |
| Advice | the `audit` method, of type after-returning |
| Join point | the execution of `AccountService.close(...)` |
| Target | the real `AccountService` instance |
| Proxy | what other beans actually hold a reference to |

Read more: [Spring: AOP concepts](https://docs.spring.io/spring-framework/reference/core/aop/introduction-defn.html) · [Spring: declaring an aspect](https://docs.spring.io/spring-framework/reference/core/aop/ataspectj/at-aspectj.html)

## Proxies

### What a proxy call looks like
```
caller ──> proxy.close(42)
             ├─ interceptor 1 (e.g. security)  ── before
             ├─ interceptor 2 (e.g. transaction) ── begin
             │    └─> target.close(42)          ── real method; `this` here is the TARGET
             ├─ interceptor 2                   ── commit/rollback
             └─ interceptor 1                   ── after
```
Inside `target.close`, `this.helper()` is a plain call on the target: no interceptors. That's the whole self-invocation problem.

### JDK vs CGLIB in detail
| | JDK dynamic proxy | CGLIB |
|---|---|---|
| Mechanism | `java.lang.reflect.Proxy`, implements interfaces | generated subclass (via Objenesis, so constructors aren't called twice) |
| Needs | at least one interface | a non-final class |
| Intercepts | interface methods | public/protected/package-private non-final methods |
| Inject as | interface only | interface or class |

### Self-invocation fixes compared
```java
// 1. Best: split responsibilities into two beans
@Service class ReportService {
    private final ReportWriter writer;           // writer.save() is @Transactional
    void generate() { writer.save(build()); }
}

// 2. Self-injection through the proxy
@Service class ReportService {
    @Lazy @Autowired private ReportService self;
    void generate() { self.save(build()); }
}

// 3. Programmatic transaction, no proxy needed
@Service class ReportService {
    private final TransactionTemplate tx;
    void generate() { tx.executeWithoutResult(status -> save(build())); }
}
```
Option 3 is often the clearest for "a transaction around part of a method".

Read more: [Spring: proxying mechanisms](https://docs.spring.io/spring-framework/reference/core/aop/proxying.html) · [Spring: programmatic transaction management](https://docs.spring.io/spring-framework/reference/data-access/transaction/programmatic.html)

## Pointcut expressions

### Reusable, combined pointcuts
```java
@Aspect
@Component
class Pointcuts {
    @Pointcut("within(com.shop..web..*)")
    void webLayer() { }

    @Pointcut("execution(public * *(..))")
    void publicMethod() { }

    @Pointcut("@within(org.springframework.stereotype.Service) || @annotation(com.shop.Monitored)")
    void monitored() { }

    @Around("webLayer() && publicMethod()")
    Object logRequests(ProceedingJoinPoint pjp) throws Throwable { ... }
}
```

### The execution() grammar
```
execution( [modifiers] return-type [declaring-type.]method-name(params) [throws] )

execution(public * *(..))                          any public method
execution(* set*(..))                              any method starting with "set"
execution(* com.shop.OrderService.*(..))           any method of OrderService
execution(* com.shop..*Repository.find*(Long))     find* methods taking one Long, in any *Repository
execution(java.util.List *(..))                    methods returning List
```

### Performance hint
`within` and `@within` can be evaluated once per class at startup ("static" matching); `args(..)` and `@args` may need checks per call. Narrow pointcuts with `within` first to keep proxy creation and calls cheap.

Read more: [Spring: declaring pointcuts](https://docs.spring.io/spring-framework/reference/core/aop/ataspectj/pointcuts.html)

## Advice types and @Around

### A correct timing + retry aspect
```java
@Aspect
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)              // outermost: wraps transactions
class RetryOnConflictAspect {

    @Around("@annotation(retry)")
    Object retry(ProceedingJoinPoint pjp, RetryOnConflict retry) throws Throwable {
        for (int attempt = 1; ; attempt++) {
            long start = System.nanoTime();
            try {
                return pjp.proceed();
            } catch (OptimisticLockingFailureException e) {
                if (attempt >= retry.maxAttempts()) throw e;
            } finally {
                metrics.record(pjp.getSignature().toShortString(), System.nanoTime() - start);
            }
        }
    }
}
```
Rules for `@Around`: declare `throws Throwable`, return what `proceed()` returned (or a deliberate replacement), use `proceed(newArgs)` to change arguments, and put cleanup in `finally`.

### Advice order inside one aspect
Since Spring 5.2.7, advice methods of the same aspect on the same join point run in this precedence: `@Around`, `@Before`, `@After`, `@AfterReturning`, `@AfterThrowing`. When the order matters, split the logic into separate aspects with `@Order`, or use one `@Around`.

Read more: [Spring: declaring advice](https://docs.spring.io/spring-framework/reference/core/aop/ataspectj/advice.html)

## Spring features built on AOP

### Who's in the interceptor chain
Each of these is an advisor with its own order:

| Feature | Enabled by | Default order |
|---|---|---|
| `@Transactional` | `@EnableTransactionManagement` (auto in Boot) | lowest precedence (innermost) |
| `@Cacheable` | `@EnableCaching` | lowest precedence |
| `@Async` | `@EnableAsync` | applied as the outermost advisor of the proxy by default |
| `@PreAuthorize` | `@EnableMethodSecurity` | ordered method security interceptors |
| `@Retryable` | `@EnableRetry` | just before lowest precedence (outside transactions) |

You can change the order through the `order` attribute of the `@Enable...` annotations.

### Why @Cacheable + @Transactional ordering matters
If the cache advice runs inside the transaction (both lowest precedence: order by declaration, effectively undefined), a value can be cached before the transaction commits and then rolled back. Set explicit orders when both appear on the same method, or keep caching at a different layer.

Read more: [Spring: declarative transaction implementation](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-decl-explained.html) · [Spring: cache abstraction](https://docs.spring.io/spring-framework/reference/integration/cache.html)

## Spring AOP vs AspectJ

### When AspectJ is worth it
- You need advice on objects not managed by Spring (domain entities, objects created by a library).
- Self-invocation must be advised (`@Transactional` on internal calls) and refactoring isn't an option.
- You need field-level or constructor join points.
- Very hot paths where proxy dispatch overhead shows up in profiles.

### Modes
- **Compile-time weaving**: the AspectJ Maven/Gradle plugin runs `ajc`; woven classes are plain bytecode, so no runtime agent is needed.
- **Load-time weaving**: a `-javaagent` (aspectjweaver) rewrites classes as they load, configured by `META-INF/aop.xml`.
- `@EnableTransactionManagement(mode = AdviceMode.ASPECTJ)` switches Spring's transaction support to AspectJ weaving.

Read more: [Spring: using AspectJ with Spring applications](https://docs.spring.io/spring-framework/reference/core/aop/using-aspectj.html) · [Spring: choosing which AOP style to use](https://docs.spring.io/spring-framework/reference/core/aop/choosing.html) · [AspectJ documentation](https://eclipse.dev/aspectj/docs.php)

## Pitfalls

### A debugging checklist: "my annotation does nothing"
1. Is the object a Spring bean? (`new` or a library-created object → no proxy)
2. Is the call coming from another bean? (self-invocation → no proxy)
3. Is the method public (or at least non-private) and non-final? Is the class non-final? (Kotlin: is the `kotlin-spring` plugin applied?)
4. Is the feature enabled? (`@EnableAsync`, `@EnableCaching`, `@EnableRetry`, `@EnableMethodSecurity`)
5. Is the bean actually proxied? `AopUtils.isAopProxy(bean)` or a debugger shows `$$SpringCGLIB$$` in the class name.
6. Does the pointcut match? Annotation retention `RUNTIME`, correct package name, correct parameter types.

### Proxy-related surprises
- `getClass()` on a bean returns the proxy class; use `AopUtils.getTargetClass(bean)` or `ClassUtils.getUserClass`.
- The CGLIB proxy instance's own fields are never initialized (Objenesis skips the constructor). A `final` method called on the proxy runs on the proxy itself and sees `null` fields: a classic NPE with Kotlin or with `final` added "for safety".

Read more: [Spring: AOP API and ProxyFactory](https://docs.spring.io/spring-framework/reference/core/aop-api.html)

## Sources
- [Spring Framework: Aspect Oriented Programming](https://docs.spring.io/spring-framework/reference/core/aop.html): the complete chapter.
- [AspectJ Programming Guide](https://eclipse.dev/aspectj/docs.php): the full pointcut language.
- [Spring Framework source: spring-aop module](https://github.com/spring-projects/spring-framework/tree/main/spring-aop): `ProxyFactory`, `JdkDynamicAopProxy` and `CglibAopProxy` are readable.
