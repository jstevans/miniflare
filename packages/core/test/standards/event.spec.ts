import {
  BindingsPlugin,
  DOMException,
  ExecutionContext,
  FetchError,
  FetchEvent,
  Request,
  Response,
  ScheduledController,
  ScheduledEvent,
  ServiceWorkerGlobalScope,
  kAddModuleFetchListener,
  kDispatchFetch,
  kDispatchScheduled,
} from "@miniflare/core";
import {
  NoOpLog,
  TestLog,
  getObjectProperties,
  isWithin,
  triggerPromise,
  useMiniflare,
  useServer,
} from "@miniflare/shared-test";
import anyTest, { TestInterface, ThrowsExpectation } from "ava";

interface Context {
  log: TestLog;
  globalScope: ServiceWorkerGlobalScope;
}

const test = anyTest as TestInterface<Context>;

test.beforeEach((t) => {
  const log = new TestLog();
  const globalScope = new ServiceWorkerGlobalScope(log, {}, { KEY: "value" });
  t.context = { log, globalScope };
});

test("ServiceWorkerGlobalScope: includes sandbox in globals", (t) => {
  const globalScope = new ServiceWorkerGlobalScope(
    new NoOpLog(),
    { sand: "box" },
    {},
    false
  );
  t.is((globalScope as any).sand, "box");
});
test("ServiceWorkerGlobalScope: includes environment in globals if modules disabled", (t) => {
  let globalScope = new ServiceWorkerGlobalScope(
    new NoOpLog(),
    {},
    { env: "ironment" },
    false
  );
  t.is((globalScope as any).env, "ironment");
  globalScope = new ServiceWorkerGlobalScope(
    new NoOpLog(),
    {},
    { env: "ironment" },
    true
  );
  t.throws(() => (globalScope as any).env, {
    instanceOf: ReferenceError,
    message:
      /^env is not defined\.\nAttempted to access binding using global in modules mode/,
  });
});
test("ServiceWorkerGlobalScope: includes global self-references", (t) => {
  const { globalScope } = t.context;
  t.is(globalScope.global, globalScope);
  t.is(globalScope.globalThis, globalScope);
  t.is(globalScope.self, globalScope);
});
test("ServiceWorkerGlobalScope: addEventListener: disabled if modules enabled", (t) => {
  const globalScope = new ServiceWorkerGlobalScope(new NoOpLog(), {}, {}, true);
  t.throws(() => globalScope.addEventListener("fetch", () => {}), {
    instanceOf: TypeError,
    message:
      "Global addEventListener() cannot be used in modules. Instead, event " +
      "handlers should be declared as exports on the root module.",
  });
});
test("ServiceWorkerGlobalScope: removeEventListener: disabled if modules enabled", (t) => {
  const globalScope = new ServiceWorkerGlobalScope(new NoOpLog(), {}, {}, true);
  t.throws(() => globalScope.removeEventListener("fetch", () => {}), {
    instanceOf: TypeError,
    message:
      "Global removeEventListener() cannot be used in modules. Instead, event " +
      "handlers should be declared as exports on the root module.",
  });
});
test("ServiceWorkerGlobalScope: dispatchEvent: disabled if modules enabled", (t) => {
  const globalScope = new ServiceWorkerGlobalScope(new NoOpLog(), {}, {}, true);
  const event = new FetchEvent(new Request("http://localhost"));
  t.throws(() => globalScope.dispatchEvent(event), {
    instanceOf: TypeError,
    message:
      "Global dispatchEvent() cannot be used in modules. Instead, event " +
      "handlers should be declared as exports on the root module.",
  });
});
test("ServiceWorkerGlobalScope: hides implementation details", (t) => {
  const { globalScope } = t.context;
  t.deepEqual(getObjectProperties(globalScope), [
    "KEY", // binding
    "addEventListener",
    "dispatchEvent",
    "global",
    "globalThis",
    "removeEventListener",
    "self",
  ]);
});

test("MiniflareCore: adds fetch event listener", async (t) => {
  const script = `(${(() => {
    const sandbox = self as any;
    sandbox.addEventListener("fetch", (e: FetchEvent) => {
      e.respondWith(new sandbox.Response(e.request.url));
    });
  }).toString()})()`;
  const mf = useMiniflare({}, { script });
  const res = await mf.dispatchFetch(new Request("http://localhost:8787/"));
  t.is(await res.text(), "http://localhost:8787/");
});
test("MiniflareCore: adds scheduled event listener", async (t) => {
  const script = `(${(() => {
    const sandbox = self as any;
    sandbox.addEventListener("scheduled", (e: ScheduledEvent) => {
      e.waitUntil(Promise.resolve(e.scheduledTime));
      e.waitUntil(Promise.resolve(e.cron));
    });
  }).toString()})()`;
  const mf = useMiniflare({}, { script });
  const res = await mf.dispatchScheduled(1000, "30 * * * *");
  t.is(res[0], 1000);
  t.is(res[1], "30 * * * *");
});
test("MiniflareCore: adds module fetch event listener", async (t) => {
  const script = `export default {
    thisTest: "that",
    fetch(request, env, ctx) {
      ctx.waitUntil(Promise.resolve(env.KEY));
      ctx.waitUntil(this.thisTest);
      return new Response(request.url);
    }
  }`;
  const mf = useMiniflare(
    { BindingsPlugin },
    { modules: true, script, bindings: { KEY: "value" } }
  );
  const res = await mf.dispatchFetch(new Request("http://localhost:8787/"));
  t.is(await res.text(), "http://localhost:8787/");
  t.deepEqual(await res.waitUntil(), ["value", "that"]);
});
test("MiniflareCore: adds module scheduled event listener", async (t) => {
  const script = `export default {
    thisTest: "that",
    scheduled(controller, env, ctx) {
      ctx.waitUntil(Promise.resolve(controller.scheduledTime));
      ctx.waitUntil(Promise.resolve(controller.cron));
      ctx.waitUntil(Promise.resolve(env.KEY));
      ctx.waitUntil(this.thisTest);
      return "returned";
    }
  }`;
  const mf = useMiniflare(
    { BindingsPlugin },
    { modules: true, script, bindings: { KEY: "value" } }
  );
  const res = await mf.dispatchScheduled(1000, "30 * * * *");
  t.deepEqual(res, [1000, "30 * * * *", "value", "that", "returned"]);
});

test("kDispatchFetch: dispatches event", async (t) => {
  const { globalScope } = t.context;
  globalScope.addEventListener("fetch", (e) => {
    e.respondWith(new Response(e.request.url));
  });
  const res = await globalScope[kDispatchFetch](
    new Request("http://localhost:8787/")
  );
  t.is(await res.text(), "http://localhost:8787/");
});
test("kDispatchFetch: dispatches event with promise response", async (t) => {
  const { globalScope } = t.context;
  globalScope.addEventListener("fetch", (e) => {
    e.respondWith(Promise.resolve(new Response(e.request.url)));
  });
  const res = await globalScope[kDispatchFetch](
    new Request("http://localhost:8787/")
  );
  t.is(await res.text(), "http://localhost:8787/");
});
test("kDispatchFetch: stops calling listeners after first response", async (t) => {
  const { globalScope } = t.context;
  globalScope.addEventListener("fetch", (e) => {
    e.waitUntil(Promise.resolve(1));
    e.waitUntil(Promise.resolve(2));
  });
  globalScope.addEventListener("fetch", (e) => {
    e.waitUntil(Promise.resolve(3));
    e.respondWith(new Response(e.request.url));
  });
  globalScope.addEventListener("fetch", (e) => {
    e.waitUntil(Promise.resolve(4));
  });
  const res = await globalScope[kDispatchFetch](
    new Request("http://localhost:8787/")
  );
  t.is(await res.text(), "http://localhost:8787/");
  t.deepEqual(await res.waitUntil(), [1, 2, 3]);
});
test("kDispatchFetch: stops calling listeners after first error", async (t) => {
  t.plan(3);
  const { globalScope } = t.context;
  globalScope.addEventListener("fetch", () => {
    t.pass();
  });
  globalScope.addEventListener("fetch", () => {
    t.pass();
    if (1 === 1) throw new TypeError("test");
  });
  globalScope.addEventListener("fetch", () => {
    t.fail();
  });
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    { instanceOf: TypeError, message: "test" }
  );
});
test("kDispatchFetch: passes through to upstream on no response", async (t) => {
  const upstream = (await useServer(t, (req, res) => res.end("upstream"))).http;
  const { globalScope } = t.context;
  globalScope.addEventListener("fetch", (e) => {
    e.waitUntil(Promise.resolve(1));
  });
  const res = await globalScope[kDispatchFetch](new Request(upstream), true);
  t.is(await res.text(), "upstream");
  t.deepEqual(await res.waitUntil(), [1]);
});
test("kDispatchFetch: passes through to upstream on error", async (t) => {
  const upstream = (await useServer(t, (req, res) => res.end("upstream"))).http;
  const { globalScope } = t.context;
  globalScope.addEventListener("fetch", (e) => {
    e.waitUntil(Promise.resolve(1));
    e.passThroughOnException();
    if (1 === 1) throw new Error("test");
    e.respondWith(new Response(e.request.url));
  });
  const res = await globalScope[kDispatchFetch](new Request(upstream), true);
  t.is(await res.text(), "upstream");
  t.deepEqual(await res.waitUntil(), [1]);
});
test("kDispatchFetch: passes through to upstream on async error", async (t) => {
  const upstream = (await useServer(t, (req, res) => res.end("upstream"))).http;
  const { globalScope } = t.context;
  globalScope.addEventListener("fetch", (e) => {
    e.waitUntil(Promise.resolve(1));
    e.passThroughOnException();
    e.respondWith(Promise.reject(new Error("test")));
  });
  const res = await globalScope[kDispatchFetch](new Request(upstream), true);
  t.is(await res.text(), "upstream");
  t.deepEqual(await res.waitUntil(), [1]);
});
test("kDispatchFetch: throws error if no pass through on listener error", async (t) => {
  const { globalScope } = t.context;
  globalScope.addEventListener("fetch", (e) => {
    if (1 === 1) throw new Error("test");
    e.respondWith(new Response(e.request.url));
  });
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    { instanceOf: Error, message: "test" }
  );
});
test("kDispatchFetch: throws error if pass through with no upstream", async (t) => {
  const { globalScope } = t.context;
  globalScope.addEventListener("fetch", (e) => {
    e.passThroughOnException();
    if (1 === 1) throw new Error("test");
    e.respondWith(new Response(e.request.url));
  });
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    {
      instanceOf: FetchError,
      code: "ERR_NO_UPSTREAM",
      message:
        "No upstream to pass-through to specified.\nMake sure you've set the `upstream` option.",
    }
  );
});
test("kDispatchFetch: throws error if respondWith called multiple times", async (t) => {
  const { globalScope } = t.context;
  globalScope.addEventListener("fetch", (e) => {
    e.respondWith(new Response("body1"));
    e.respondWith(new Response("body2"));
  });
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    {
      instanceOf: DOMException,
      name: "InvalidStateError",
      message:
        "FetchEvent.respondWith() has already been called; it can only be called once.",
    }
  );
});
test("kDispatchFetch: throws error if respondWith called after response sent", async (t) => {
  t.plan(2);
  const { globalScope } = t.context;
  const [trigger, promise] = triggerPromise<void>();
  globalScope.addEventListener("fetch", async (e) => {
    await promise;
    t.throws(() => e.respondWith(new Response("body")), {
      instanceOf: DOMException,
      name: "InvalidStateError",
      message:
        "Too late to call FetchEvent.respondWith(). It must be called synchronously in the event handler.",
    });
  });
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    { instanceOf: FetchError, code: "ERR_NO_RESPONSE" }
  );
  trigger();
});
test("kDispatchFetch: throws error if response is not a Response", async (t) => {
  // Check suggestion with regular service worker handler
  let globalScope = new ServiceWorkerGlobalScope(new NoOpLog(), {}, {});
  globalScope.addEventListener("fetch", (e) => {
    e.respondWith(Promise.resolve({} as any));
  });
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    {
      instanceOf: FetchError,
      code: "ERR_RESPONSE_TYPE",
      message:
        "Fetch handler didn't respond with a Response object.\n" +
        "Make sure you're calling `event.respondWith()` with a `Response` or " +
        "`Promise<Response>` in your handler.",
    }
  );
  // Check suggestion with module handler
  globalScope = new ServiceWorkerGlobalScope(new NoOpLog(), {}, {}, true);
  globalScope[kAddModuleFetchListener](async () => ({} as any));
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    {
      instanceOf: FetchError,
      code: "ERR_RESPONSE_TYPE",
      message:
        "Fetch handler didn't respond with a Response object.\n" +
        "Make sure you're returning a `Response` in your handler.",
    }
  );
});
test("kDispatchFetch: throws error if fetch handler doesn't respond", async (t) => {
  // Check suggestion with regular service worker handler
  let globalScope = new ServiceWorkerGlobalScope(new NoOpLog(), {}, {});
  globalScope.addEventListener("fetch", () => {});
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    {
      instanceOf: FetchError,
      code: "ERR_NO_RESPONSE",
      message:
        "No fetch handler responded and no upstream to proxy to specified.\n" +
        "Make sure you're calling `event.respondWith()` with a `Response` or " +
        "`Promise<Response>` in your handler.",
    }
  );
  // Check suggestion with module handler
  globalScope = new ServiceWorkerGlobalScope(new NoOpLog(), {}, {}, true);
  globalScope[kAddModuleFetchListener]((async () => {}) as any);
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    {
      instanceOf: FetchError,
      code: "ERR_NO_RESPONSE",
      message:
        "No fetch handler responded and no upstream to proxy to specified.\n" +
        "Make sure you're returning a `Response` in your handler.",
    }
  );
});
test("kDispatchFetch: throws error if fetch handler undefined", async (t) => {
  // Check suggestion with regular service worker handler
  let globalScope = new ServiceWorkerGlobalScope(new NoOpLog(), {}, {});
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    {
      instanceOf: FetchError,
      code: "ERR_NO_HANDLER",
      message:
        "No fetch handler defined and no upstream to proxy to specified.\n" +
        'Make sure you\'re calling addEventListener("fetch", ...).',
    }
  );
  // Check suggestion with module handler
  globalScope = new ServiceWorkerGlobalScope(new NoOpLog(), {}, {}, true);
  await t.throwsAsync(
    () => globalScope[kDispatchFetch](new Request("http://localhost:8787/")),
    {
      instanceOf: FetchError,
      code: "ERR_NO_HANDLER",
      message:
        "No fetch handler defined and no upstream to proxy to specified.\n" +
        "Make sure you're exporting a default object containing a `fetch` " +
        "function property.",
    }
  );
});

test("kDispatchScheduled: dispatches event", async (t) => {
  const { globalScope } = t.context;
  globalScope.addEventListener("scheduled", (e) => {
    e.waitUntil(Promise.resolve(1));
    e.waitUntil(Promise.resolve(2));
  });
  globalScope.addEventListener("scheduled", (e) => {
    e.waitUntil(Promise.resolve(3));
    e.waitUntil(Promise.resolve(e.scheduledTime));
    e.waitUntil(Promise.resolve(e.cron));
  });
  const res = await globalScope[kDispatchScheduled](1000, "30 * * * *");
  t.deepEqual(res, [1, 2, 3, 1000, "30 * * * *"]);
});
test("kDispatchScheduled: defaults to current time and empty cron if none specified", async (t) => {
  const { globalScope } = t.context;
  globalScope.addEventListener("scheduled", (e) => {
    e.waitUntil(Promise.resolve(e.scheduledTime));
    e.waitUntil(Promise.resolve(e.cron));
  });
  const [scheduledTime, cron] = await globalScope[kDispatchScheduled]();
  isWithin(t, 10000, Date.now(), scheduledTime);
  t.is(cron, "");
});
test("kDispatchScheduled: stops calling listeners after first error", async (t) => {
  t.plan(3);
  const { globalScope } = t.context;
  globalScope.addEventListener("scheduled", () => {
    t.pass();
  });
  globalScope.addEventListener("scheduled", () => {
    t.pass();
    if (1 === 1) throw new TypeError("test");
  });
  globalScope.addEventListener("scheduled", () => {
    t.fail();
  });
  await t.throwsAsync(() => globalScope[kDispatchScheduled](), {
    instanceOf: TypeError,
    message: "test",
  });
});

const illegalInvocationExpectation: ThrowsExpectation = {
  instanceOf: TypeError,
  message: "Illegal invocation",
};

test("FetchEvent: hides implementation details", (t) => {
  const event = new FetchEvent(new Request("http://localhost:8787"));
  t.deepEqual(getObjectProperties(event), [
    "isTrusted",
    "passThroughOnException",
    "request",
    "respondWith",
    "waitUntil",
  ]);
});
test("FetchEvent: methods throw if this is incorrectly bound", (t) => {
  const { respondWith, passThroughOnException, waitUntil } = new FetchEvent(
    new Request("http://localhost:8787")
  );
  t.throws(() => respondWith(new Response()), illegalInvocationExpectation);
  t.throws(() => passThroughOnException(), illegalInvocationExpectation);
  t.throws(() => waitUntil(Promise.resolve()), illegalInvocationExpectation);
});
test("ScheduledEvent: hides implementation details", (t) => {
  const event = new ScheduledEvent(1000, "30 * * * *");
  t.deepEqual(getObjectProperties(event), [
    "cron",
    "isTrusted",
    "scheduledTime",
    "waitUntil",
  ]);
});
test("ScheduledEvent: methods throw if this is incorrectly bound", (t) => {
  const { waitUntil } = new ScheduledEvent(1000, "30 * * * *");
  t.throws(() => waitUntil(Promise.resolve()), illegalInvocationExpectation);
});
test("ExecutionContext: hides implementation details", (t) => {
  const event = new FetchEvent(new Request("http://localhost:8787"));
  const ctx = new ExecutionContext(event);
  t.deepEqual(getObjectProperties(ctx), [
    "passThroughOnException",
    "waitUntil",
  ]);
});
test("ExecutionContext: methods throw if this is incorrectly bound", (t) => {
  const event = new FetchEvent(new Request("http://localhost:8787"));
  const { passThroughOnException, waitUntil } = new ExecutionContext(event);
  t.throws(() => passThroughOnException(), illegalInvocationExpectation);
  t.throws(() => waitUntil(Promise.resolve()), illegalInvocationExpectation);
});
test("ScheduledController: hides implementation details", (t) => {
  const controller = new ScheduledController(1000, "30 * * * *");
  t.deepEqual(getObjectProperties(controller), ["cron", "scheduledTime"]);
});
