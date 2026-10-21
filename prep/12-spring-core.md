# Spring Core & MVC

## IoC and DI
- **Inversion of Control**: the container (`ApplicationContext`) creates objects (beans) and wires their dependencies; classes don't build their own collaborators.
- **Constructor injection** is preferred: dependencies are explicit and `final`, the object is never half-built, it's easy to test without Spring, and circular dependencies fail loudly. A single constructor needs no `@Autowired` (since 4.3).
- Setter injection for truly optional dependencies. Field injection hides dependencies and needs reflection in tests.
- `ApplicationContext` vs `BeanFactory`: the context adds eager singleton creation, events, AOP integration, i18n and environment/profiles.

## Defining beans
- Stereotypes found by component scanning: `@Component`, `@Service`, `@Repository` (adds persistence exception translation), `@Controller`/`@RestController`.
- `@Configuration` + `@Bean` methods for third-party classes or when construction needs logic.
- In a `@Configuration` class (proxied with CGLIB), calling another `@Bean` method returns **the same singleton**. In "lite" mode (`@Component`, or `proxyBeanMethods = false`) it's a plain Java call that creates a new object.
- Autowiring is by **type**. With several candidates: `@Primary`, `@Qualifier("name")`, or a parameter name matching the bean name; otherwise `NoUniqueBeanDefinitionException`.
- Inject `List<PaymentProvider>` or `Map<String, PaymentProvider>` to get all implementations (strategy pattern). `ObjectProvider<T>` or `Optional<T>` for optional ones.
- The default bean name is the class name in camelCase: `OrderService` → `orderService`.

## Scopes
- `singleton` (default): one instance per container, shared by all threads, so it must be **stateless or thread-safe**.
- `prototype`: a new instance per injection or `getBean`. The container doesn't call its destroy callbacks.
- Web scopes: `request`, `session`, `application`, `websocket`.
- A prototype (or request-scoped) bean injected into a singleton is injected **once**. Get fresh instances via `ObjectProvider<T>.getObject()`, `@Lookup` methods, or a scoped proxy (`proxyMode = ScopedProxyMode.TARGET_CLASS`).

## Bean lifecycle
- Instantiate → inject dependencies → `*Aware` callbacks → `BeanPostProcessor.postProcessBeforeInitialization` → `@PostConstruct` → `InitializingBean.afterPropertiesSet` → custom `initMethod` → `BeanPostProcessor.postProcessAfterInitialization` (**AOP proxies are created here**) → bean in use → `@PreDestroy` → `DisposableBean.destroy` → `destroyMethod`.
- `BeanFactoryPostProcessor`: changes bean **definitions** before any bean exists (property placeholders). `BeanPostProcessor`: changes or wraps bean **instances**.
- Circular dependencies with constructor injection fail with `BeanCurrentlyInCreationException`. Spring Boot 2.6+ forbids circular references by default; fix the design (extract a third bean, use events), with `@Lazy` as a last resort.

## Configuration and profiles
- `Environment` aggregates property sources: files, environment variables, system properties, command-line arguments.
- `@Value("${app.timeout:5s}")` for single values; `@ConfigurationProperties(prefix = "app")` for type-safe groups (records work), with validation.
- `@Profile("dev")` on beans; `@Conditional` and its Boot variants for finer conditions.

## Events
- `ApplicationEventPublisher.publishEvent(obj)`; listeners with `@EventListener`.
- Listeners run **synchronously**, in the publisher's thread and transaction. Add `@Async` for asynchronous handling.
- `@TransactionalEventListener(phase = AFTER_COMMIT)` runs only after a successful commit.
- Lifecycle events: `ContextRefreshedEvent`, `ContextClosedEvent`; Boot adds `ApplicationReadyEvent` and others.

## Spring MVC basics
- Request flow: `DispatcherServlet` → `HandlerMapping` (finds the controller method) → `HandlerAdapter` (resolves arguments, invokes) → return value: `HttpMessageConverter` (Jackson) for `@ResponseBody`, or a `ViewResolver` for views.
- `@RestController` = `@Controller` + `@ResponseBody`. Arguments: `@PathVariable`, `@RequestParam`, `@RequestBody`, `@RequestHeader`. `@Valid` on a body that fails → `MethodArgumentNotValidException` → 400.
- Errors: `@RestControllerAdvice` + `@ExceptionHandler`; `ProblemDetail` (RFC 9457) responses since Spring 6.
- **Filters** run in the servlet container before `DispatcherServlet` (security, logging, CORS); **HandlerInterceptors** run inside Spring MVC around a handler, which they know.
- Controllers are singletons: never keep request data in fields.
