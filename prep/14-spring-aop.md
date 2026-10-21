# Spring AOP

## Concepts
- **Cross-cutting concerns**: logic needed in many places but not part of the business logic: transactions, security, caching, logging, metrics, retries.
- **Aspect**: a module of such logic (`@Aspect` class). **Join point**: a point in execution; in Spring AOP always a **method execution**. **Pointcut**: an expression selecting join points. **Advice**: the code run at them. **Weaving**: linking aspects with target code.
- Advice types: `@Before`, `@AfterReturning`, `@AfterThrowing`, `@After` (like `finally`, always), `@Around` (wraps the call; the most powerful).
- Spring AOP weaves at **runtime via proxies**; AspectJ weaves at compile time or load time by changing bytecode.

## Proxies
- **JDK dynamic proxy**: implements the bean's interfaces. Only interface methods are intercepted, and the bean must be injected by interface.
- **CGLIB proxy**: a generated subclass of the bean class. Spring Boot uses it by default (`spring.aop.proxy-target-class=true`).
- CGLIB can't intercept `final` methods or `private` methods (and can't proxy `final` classes). Static methods are never intercepted. Such methods silently run **without** the advice.
- **Self-invocation**: `this.otherMethod()` inside the bean calls the target directly, bypassing the proxy, so `@Transactional`, `@Cacheable`, `@Async` on `otherMethod` are ignored.
- Fixes for self-invocation: move the method to another bean (best); inject the bean's own proxy (`@Lazy` self-injection); `AopContext.currentProxy()` with `exposeProxy = true`; or AspectJ weaving.

## Pointcut expressions
- `execution(modifiers? return-type declaring-type? name(params) throws?)`: `execution(* com.shop.service..*.*(..))` = any method of any class in `service` and its subpackages.
- `within(com.shop.web..*)`: all methods of types in those packages.
- `@annotation(com.shop.Audited)`: methods annotated `@Audited`. `@within(org.springframework.stereotype.Service)`: all methods of classes annotated `@Service`.
- `bean(*Service)` (Spring-specific, by bean name), `args(..)`, `this(...)` (the proxy), `target(...)` (the target object).
- Combine with `&&`, `||`, `!`, and name reusable expressions with `@Pointcut` methods.

## Advice types and @Around
- `@Around` receives a `ProceedingJoinPoint`: call `proceed()` to run the method (or don't, to block it), change arguments, change or replace the return value, catch and translate exceptions, measure time, retry.
- Forgetting `return pjp.proceed()` makes the method return `null` (or throw for primitives) to the caller.
- `JoinPoint` in other advice gives the signature, arguments and target. `@AfterReturning(returning = "result")` and `@AfterThrowing(throwing = "ex")` bind the result or exception.
- `@AfterThrowing` observes an exception but **can't swallow** it; it still propagates. Use `@Around` to translate.
- Ordering between aspects: `@Order` on the aspect class. A lower value = higher precedence = **outermost** (its "before" runs first and its "after" runs last).

## Spring features built on AOP
- `@Transactional`, `@Cacheable`/`@CacheEvict`, `@Async`, `@Retryable`, `@PreAuthorize` (method security), `@Validated` method validation, `@Observed`/`@Timed` metrics.
- Spring Data repositories are interface proxies whose interceptors implement your query methods.
- Interceptor order matters: retry must wrap the transaction (each attempt gets a new transaction); `@Transactional`'s advisor has the lowest precedence by default (innermost).

## Spring AOP vs AspectJ
- **Spring AOP**: method executions on Spring beans only, through proxies. Simple, no special compiler, a small overhead per call. Covers most needs.
- **AspectJ**: any join point (constructors, field access, call sites, static and private methods), any object (not only beans), no self-invocation problem. Needs the `ajc` compiler or a load-time weaving agent.
- Spring uses AspectJ's **annotations and pointcut language** (`@Aspect`, `execution(...)`) even in proxy mode, which causes the common confusion.

## Pitfalls
- Advice not applied: the object was created with `new` (not a bean); the method is private, final or static; the call is a self-invocation; the pointcut doesn't match (wrong package or annotation retention); the aspect isn't a bean (`@Aspect` alone isn't a `@Component`).
- `BeanNotOfRequiredTypeException`: injecting by concrete class when Spring created a JDK interface proxy.
- Heavy aspects on hot paths (logging every call with arguments) cost CPU and can leak sensitive data into logs.
