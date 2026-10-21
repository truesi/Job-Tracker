# Spring Core и MVC

## IoC и DI
- **Inversion of Control**: контейнер (`ApplicationContext`) создаёт объекты (бины) и связывает их зависимости; классы не собирают своих соавторов сами.
- **Внедрение через конструктор** предпочтительно: зависимости явные и `final`, объект никогда не бывает наполовину собран, его легко тестировать без Spring, а циклические зависимости падают громко. Единственному конструктору `@Autowired` не нужен (с 4.3).
- Внедрение через сеттер для действительно необязательных зависимостей. Внедрение в поле прячет зависимости и требует reflection в тестах.
- `ApplicationContext` vs `BeanFactory`: контекст добавляет раннее создание синглтонов, события, интеграцию с AOP, i18n и environment/profiles.

## Объявление бинов
- Стереотипы, которые находит component scanning: `@Component`, `@Service`, `@Repository` (добавляет трансляцию исключений persistence), `@Controller`/`@RestController`.
- `@Configuration` + методы `@Bean` для сторонних классов или когда создание требует логики.
- В классе `@Configuration` (проксируется через CGLIB) вызов другого `@Bean`-метода возвращает **тот же синглтон**. В режиме "lite" (`@Component` или `proxyBeanMethods = false`) это обычный вызов Java, который создаёт новый объект.
- Autowiring идёт по **типу**. При нескольких кандидатах: `@Primary`, `@Qualifier("name")` или имя параметра, совпадающее с именем бина; иначе `NoUniqueBeanDefinitionException`.
- Внедри `List<PaymentProvider>` или `Map<String, PaymentProvider>`, чтобы получить все реализации (паттерн strategy). `ObjectProvider<T>` или `Optional<T>` для необязательных.
- Имя бина по умолчанию это имя класса в camelCase: `OrderService` → `orderService`.

## Scopes
- `singleton` (по умолчанию): один экземпляр на контейнер, общий для всех потоков, поэтому он должен быть **без состояния или потокобезопасным**.
- `prototype`: новый экземпляр на каждое внедрение или `getBean`. Контейнер не вызывает его destroy-колбэки.
- Веб-scopes: `request`, `session`, `application`, `websocket`.
- Prototype (или request-scoped) бин, внедрённый в синглтон, внедряется **один раз**. Свежие экземпляры получай через `ObjectProvider<T>.getObject()`, методы `@Lookup` или scoped proxy (`proxyMode = ScopedProxyMode.TARGET_CLASS`).

## Жизненный цикл бина
- Создание экземпляра → внедрение зависимостей → колбэки `*Aware` → `BeanPostProcessor.postProcessBeforeInitialization` → `@PostConstruct` → `InitializingBean.afterPropertiesSet` → свой `initMethod` → `BeanPostProcessor.postProcessAfterInitialization` (**здесь создаются AOP-прокси**) → бин используется → `@PreDestroy` → `DisposableBean.destroy` → `destroyMethod`.
- `BeanFactoryPostProcessor`: меняет **определения** бинов до того, как появится хоть один бин (placeholder-ы свойств). `BeanPostProcessor`: меняет или оборачивает **экземпляры** бинов.
- Циклические зависимости при внедрении через конструктор падают с `BeanCurrentlyInCreationException`. Spring Boot 2.6+ по умолчанию запрещает циклические ссылки; исправляй дизайн (выдели третий бин, используй события), `@Lazy` как крайняя мера.

## Конфигурация и профили
- `Environment` собирает источники свойств: файлы, переменные окружения, системные свойства, аргументы командной строки.
- `@Value("${app.timeout:5s}")` для отдельных значений; `@ConfigurationProperties(prefix = "app")` для типобезопасных групп (подходят records), с валидацией.
- `@Profile("dev")` на бинах; `@Conditional` и его варианты из Boot для более тонких условий.

## События
- `ApplicationEventPublisher.publishEvent(obj)`; слушатели через `@EventListener`.
- Слушатели выполняются **синхронно**, в потоке и транзакции публикующего. Добавь `@Async` для асинхронной обработки.
- `@TransactionalEventListener(phase = AFTER_COMMIT)` выполняется только после успешного коммита.
- События жизненного цикла: `ContextRefreshedEvent`, `ContextClosedEvent`; Boot добавляет `ApplicationReadyEvent` и другие.

## Основы Spring MVC
- Путь запроса: `DispatcherServlet` → `HandlerMapping` (находит метод контроллера) → `HandlerAdapter` (разрешает аргументы, вызывает) → возвращаемое значение: `HttpMessageConverter` (Jackson) для `@ResponseBody` или `ViewResolver` для представлений.
- `@RestController` = `@Controller` + `@ResponseBody`. Аргументы: `@PathVariable`, `@RequestParam`, `@RequestBody`, `@RequestHeader`. Невалидное тело с `@Valid` → `MethodArgumentNotValidException` → 400.
- Ошибки: `@RestControllerAdvice` + `@ExceptionHandler`; ответы `ProblemDetail` (RFC 9457) с Spring 6.
- **Фильтры** работают в servlet-контейнере до `DispatcherServlet` (безопасность, логирование, CORS); **HandlerInterceptor** работают внутри Spring MVC вокруг обработчика, о котором они знают.
- Контроллеры синглтоны: никогда не храни данные запроса в полях.
