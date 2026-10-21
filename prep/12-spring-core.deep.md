# Spring Core & MVC: deep dive

This page goes deeper on the short notes, section by section. The Spring Framework reference documentation is excellent and the source of most interview questions on this topic.

## IoC and DI

### Why constructor injection, concretely
```java
@Service
public class OrderService {
    private final OrderRepository orders;
    private final PaymentClient payments;

    public OrderService(OrderRepository orders, PaymentClient payments) {   // no @Autowired needed
        this.orders = orders;
        this.payments = payments;
    }
}

// a plain unit test, no Spring involved
var service = new OrderService(mock(OrderRepository.class), mock(PaymentClient.class));
```
With field injection the same test needs reflection or a Spring context, the dependencies are invisible in the API, and a class with 12 `@Autowired` fields doesn't *feel* too big. A long constructor does, which is a useful design signal.

### What the container does at startup
1. Read bean definitions (component scan, `@Bean` methods, auto-configuration).
2. Run `BeanFactoryPostProcessor`s (they can change definitions).
3. Register `BeanPostProcessor`s.
4. Instantiate all non-lazy singletons in dependency order, running each through the lifecycle.
5. Publish `ContextRefreshedEvent`.

Misconfiguration (a missing bean, an ambiguous type, a cycle) fails in step 4, at startup, not at the first request. That's a major reason to keep singletons eager.

Read more: [Spring: the IoC container](https://docs.spring.io/spring-framework/reference/core/beans.html) · [Spring: dependency injection](https://docs.spring.io/spring-framework/reference/core/beans/dependencies/factory-collaborators.html)

## Defining beans

### Full vs lite @Bean mode
```java
@Configuration                       // CGLIB subclass: inter-bean calls are intercepted
class AppConfig {
    @Bean Clock clock() { return Clock.systemUTC(); }
    @Bean Scheduler scheduler() { return new Scheduler(clock()); }   // same Clock singleton
}

@Configuration(proxyBeanMethods = false)   // no subclass: faster startup, but...
class LiteConfig {
    @Bean Clock clock() { return Clock.systemUTC(); }
    @Bean Scheduler scheduler(Clock clock) { return new Scheduler(clock); }   // ...inject as a parameter
}
```
Spring Boot's own auto-configurations use `proxyBeanMethods = false` and parameter injection.

### Strategy pattern with DI
```java
public interface PaymentProvider {
    String code();
    Receipt charge(Payment p);
}

@Service
class PaymentRouter {
    private final Map<String, PaymentProvider> byCode;

    PaymentRouter(List<PaymentProvider> providers) {
        this.byCode = providers.stream().collect(toMap(PaymentProvider::code, p -> p));
    }

    Receipt charge(Payment p) { return byCode.get(p.providerCode()).charge(p); }
}
```
Adding a provider = adding a `@Component`. No if/else chain to edit.

### Conditional beans
`@Profile`, `@ConditionalOnProperty("feature.x.enabled")`, and `@ConditionalOnMissingBean` (Boot) select beans at startup. For per-request decisions (feature flags, A/B tests), inject all implementations and choose at runtime.

Read more: [Spring: @Bean and @Configuration (full vs lite mode)](https://docs.spring.io/spring-framework/reference/core/beans/java/basic-concepts.html) · [Spring: classpath scanning](https://docs.spring.io/spring-framework/reference/core/beans/classpath-scanning.html)

## Scopes

### Scoped proxies
```java
@Component
@Scope(value = WebApplicationContext.SCOPE_REQUEST, proxyMode = ScopedProxyMode.TARGET_CLASS)
class RequestContext {
    private String tenantId;
    // getters and setters
}

@Service
class ReportService {
    private final RequestContext ctx;              // actually a proxy
    ReportService(RequestContext ctx) { this.ctx = ctx; }

    Report build() { return load(ctx.getTenantId()); }   // proxy delegates to this request's instance
}
```
The singleton holds a proxy; every call looks up the target in the current request scope. Outside of a request (a scheduled job) the call fails with "No thread-bound request found".

### Getting a fresh prototype
```java
@Service
class ImportService {
    private final ObjectProvider<CsvParser> parsers;      // CsvParser is @Scope("prototype")
    ImportService(ObjectProvider<CsvParser> parsers) { this.parsers = parsers; }

    void importFile(Path file) {
        CsvParser parser = parsers.getObject();           // new instance every call
        parser.parse(file);
    }
}
```

Read more: [Spring: bean scopes](https://docs.spring.io/spring-framework/reference/core/beans/factory-scopes.html)

## Bean lifecycle

### All callbacks in order
```java
@Component
class LifecycleDemo implements BeanNameAware, InitializingBean, DisposableBean {
    LifecycleDemo(Dep dep) { log("1 constructor + constructor injection"); }
    @Autowired void setOther(Other o) { log("2 setter/field injection"); }
    public void setBeanName(String name) { log("3 Aware callbacks"); }
    // 4 BeanPostProcessor.postProcessBeforeInitialization
    @PostConstruct void init() { log("5 @PostConstruct"); }
    public void afterPropertiesSet() { log("6 InitializingBean"); }
    // 7 @Bean(initMethod = ...) if declared that way
    // 8 BeanPostProcessor.postProcessAfterInitialization: may return a proxy
    @PreDestroy void close() { log("9 @PreDestroy"); }
    public void destroy() { log("10 DisposableBean"); }
}
```

### Writing a BeanPostProcessor
```java
@Component
class TimingPostProcessor implements BeanPostProcessor {
    @Override
    public Object postProcessAfterInitialization(Object bean, String name) {
        if (bean.getClass().isAnnotationPresent(Timed.class)) {
            return Proxy.newProxyInstance(bean.getClass().getClassLoader(),
                bean.getClass().getInterfaces(),
                (proxy, method, args) -> {
                    long t = System.nanoTime();
                    try { return method.invoke(bean, args); }
                    finally { log(name + "." + method.getName() + " " + (System.nanoTime() - t) + "ns"); }
                });
        }
        return bean;
    }
}
```
This is, in miniature, how Spring AOP proxies get created.

### Things not to do in @PostConstruct
- Call your own `@Transactional`/`@Async` methods: the proxy doesn't exist yet. Use `ApplicationReadyEvent` or `SmartInitializingSingleton` for work that needs the full context.
- Do slow I/O (warm-up, remote calls): it blocks startup and fails it if the remote is down.

Read more: [Spring: lifecycle callbacks](https://docs.spring.io/spring-framework/reference/core/beans/factory-nature.html) · [Spring: container extension points](https://docs.spring.io/spring-framework/reference/core/beans/factory-extension.html)

## Configuration and profiles

```java
@ConfigurationProperties(prefix = "payments")
@Validated
public record PaymentProperties(
    @NotNull URI baseUrl,
    @DefaultValue("5s") Duration timeout,
    @Min(1) @DefaultValue("3") int maxRetries) { }
```
```yaml
payments:
  base-url: https://psp.example.com      # relaxed binding: base-url, baseUrl, PAYMENTS_BASEURL
  timeout: 2s
```
Profiles group beans and property files per environment (`application-prod.yml`). Don't put business logic switches into profiles: `@Profile("!prod")` on a security bypass is a classic production incident.

Read more: [Spring: environment abstraction and profiles](https://docs.spring.io/spring-framework/reference/core/beans/environment.html)

## Events

```java
public record OrderPlaced(long orderId) { }

@Service
class OrderService {
    private final ApplicationEventPublisher events;
    OrderService(ApplicationEventPublisher events) { this.events = events; }

    @Transactional
    public void place(Order o) {
        repo.save(o);
        events.publishEvent(new OrderPlaced(o.getId()));
    }
}

@Component
class OrderListeners {
    @EventListener                                   // same thread, same transaction: can roll it back
    void reserveStock(OrderPlaced e) { ... }

    @TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
    @Async                                           // after commit, in another thread
    void sendEmail(OrderPlaced e) { ... }
}
```
Events decouple modules inside one application; Spring Modulith builds on this with a persisted event publication log (an in-process outbox).

Read more: [Spring: standard and custom events](https://docs.spring.io/spring-framework/reference/core/beans/context-introduction.html#context-functionality-events) · [Spring Modulith](https://spring.io/projects/spring-modulith)

## Spring MVC basics

### One request, end to end
1. Tomcat's thread runs the **filter chain** (Spring Security, CORS, request logging).
2. `DispatcherServlet.doDispatch` asks `HandlerMapping`s for a handler plus its interceptors.
3. `HandlerInterceptor.preHandle`s run.
4. `RequestMappingHandlerAdapter` resolves arguments (`HandlerMethodArgumentResolver`s: path variables, `@RequestBody` via `HttpMessageConverter`, validation) and invokes the method.
5. The return value is handled: `@ResponseBody` → message converter (Jackson) writes JSON.
6. On an exception, `HandlerExceptionResolver`s run (`@ExceptionHandler` methods first).
7. `postHandle`/`afterCompletion` interceptors, then filters unwind.

### Error handling with ProblemDetail
```java
@RestControllerAdvice
class ApiErrors extends ResponseEntityExceptionHandler {
    @ExceptionHandler(OrderNotFoundException.class)
    ProblemDetail notFound(OrderNotFoundException e) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(HttpStatus.NOT_FOUND, e.getMessage());
        pd.setProperty("orderId", e.orderId());
        return pd;          // application/problem+json
    }
}
```

### Calling other services
`RestTemplate` is in maintenance mode. Use `RestClient` (Spring 6.1, synchronous, fluent) or `WebClient` (reactive), or declarative HTTP interfaces (`@HttpExchange`). Always set connect and read timeouts.

Read more: [Spring MVC: DispatcherServlet](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-servlet.html) · [Spring MVC: error responses (ProblemDetail)](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html) · [Spring: REST clients](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html)

## Sources
- [Spring Framework reference documentation](https://docs.spring.io/spring-framework/reference/): the core and web chapters cover everything above.
- [Spring guides](https://spring.io/guides): short task-oriented tutorials.
- Craig Walls, *Spring in Action*, 6th edition.
