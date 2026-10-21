# Spring Core и MVC: подробно

Здесь разделы краткого конспекта разобраны глубже. Справочная документация Spring Framework отличная, и из неё берётся большинство вопросов на собеседованиях по теме.

## IoC и DI

### Почему внедрение через конструктор, конкретно
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
При внедрении в поля тому же тесту нужен reflection или контекст Spring, зависимости не видны в API, а класс с 12 полями `@Autowired` не *ощущается* слишком большим. Длинный конструктор ощущается, и это полезный сигнал о дизайне.

### Что контейнер делает при старте
1. Читает определения бинов (component scan, методы `@Bean`, автоконфигурация).
2. Запускает `BeanFactoryPostProcessor` (они могут менять определения).
3. Регистрирует `BeanPostProcessor`.
4. Создаёт все не-lazy синглтоны в порядке зависимостей, прогоняя каждый через жизненный цикл.
5. Публикует `ContextRefreshedEvent`.

Ошибки конфигурации (нет бина, неоднозначный тип, цикл) падают на шаге 4, при старте, а не на первом запросе. Это главная причина держать синглтоны ранними.

Подробнее: [Spring: the IoC container](https://docs.spring.io/spring-framework/reference/core/beans.html) · [Spring: dependency injection](https://docs.spring.io/spring-framework/reference/core/beans/dependencies/factory-collaborators.html)

## Объявление бинов

### Полный и lite режим @Bean
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
Собственные автоконфигурации Spring Boot используют `proxyBeanMethods = false` и внедрение через параметры.

### Паттерн strategy через DI
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
Добавить провайдера = добавить `@Component`. Никакой цепочки if/else, которую надо править.

### Условные бины
`@Profile`, `@ConditionalOnProperty("feature.x.enabled")` и `@ConditionalOnMissingBean` (Boot) выбирают бины при старте. Для решений на каждый запрос (feature flags, A/B тесты) внедряй все реализации и выбирай в рантайме.

Подробнее: [Spring: @Bean and @Configuration (full vs lite mode)](https://docs.spring.io/spring-framework/reference/core/beans/java/basic-concepts.html) · [Spring: classpath scanning](https://docs.spring.io/spring-framework/reference/core/beans/classpath-scanning.html)

## Scopes

### Scoped proxy
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
Синглтон держит прокси; каждый вызов ищет целевой объект в текущем request scope. Вне запроса (плановая задача) вызов падает с "No thread-bound request found".

### Как получить свежий prototype
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

Подробнее: [Spring: bean scopes](https://docs.spring.io/spring-framework/reference/core/beans/factory-scopes.html)

## Жизненный цикл бина

### Все колбэки по порядку
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

### Как написать BeanPostProcessor
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
Так, в миниатюре, создаются AOP-прокси Spring.

### Чего не делать в @PostConstruct
- Вызывать свои же `@Transactional`/`@Async` методы: прокси ещё не существует. Для работы, которой нужен полный контекст, используй `ApplicationReadyEvent` или `SmartInitializingSingleton`.
- Делать медленный I/O (прогрев, удалённые вызовы): это блокирует старт и роняет его, если удалённая сторона недоступна.

Подробнее: [Spring: lifecycle callbacks](https://docs.spring.io/spring-framework/reference/core/beans/factory-nature.html) · [Spring: container extension points](https://docs.spring.io/spring-framework/reference/core/beans/factory-extension.html)

## Конфигурация и профили

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
Профили группируют бины и файлы свойств по окружениям (`application-prod.yml`). Не клади в профили переключатели бизнес-логики: `@Profile("!prod")` на обходе безопасности это классический инцидент в продакшене.

Подробнее: [Spring: environment abstraction and profiles](https://docs.spring.io/spring-framework/reference/core/beans/environment.html)

## События

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
События развязывают модули внутри одного приложения; Spring Modulith строится на этом и добавляет сохраняемый журнал публикаций событий (outbox внутри процесса).

Подробнее: [Spring: standard and custom events](https://docs.spring.io/spring-framework/reference/core/beans/context-introduction.html#context-functionality-events) · [Spring Modulith](https://spring.io/projects/spring-modulith)

## Основы Spring MVC

### Один запрос от начала до конца
1. Поток Tomcat прогоняет **цепочку фильтров** (Spring Security, CORS, логирование запросов).
2. `DispatcherServlet.doDispatch` спрашивает у `HandlerMapping` обработчик и его interceptor-ы.
3. Выполняются `HandlerInterceptor.preHandle`.
4. `RequestMappingHandlerAdapter` разрешает аргументы (`HandlerMethodArgumentResolver`: path variables, `@RequestBody` через `HttpMessageConverter`, валидация) и вызывает метод.
5. Обрабатывается возвращаемое значение: `@ResponseBody` → message converter (Jackson) пишет JSON.
6. При исключении работают `HandlerExceptionResolver` (сначала методы `@ExceptionHandler`).
7. Interceptor-ы `postHandle`/`afterCompletion`, затем фильтры раскручиваются обратно.

### Обработка ошибок через ProblemDetail
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

### Вызовы других сервисов
`RestTemplate` в режиме поддержки. Используй `RestClient` (Spring 6.1, синхронный, fluent) или `WebClient` (реактивный), либо декларативные HTTP-интерфейсы (`@HttpExchange`). Всегда задавай таймауты на подключение и чтение.

Подробнее: [Spring MVC: DispatcherServlet](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-servlet.html) · [Spring MVC: error responses (ProblemDetail)](https://docs.spring.io/spring-framework/reference/web/webmvc/mvc-ann-rest-exceptions.html) · [Spring: REST clients](https://docs.spring.io/spring-framework/reference/integration/rest-clients.html)

## Источники
- [Справочная документация Spring Framework](https://docs.spring.io/spring-framework/reference/): главы core и web покрывают всё выше.
- [Spring guides](https://spring.io/guides): короткие туториалы под конкретные задачи.
- Craig Walls, *Spring in Action*, 6-е издание.
