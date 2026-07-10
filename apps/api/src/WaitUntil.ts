import { Context } from "effect"

/** Per-request handle to the Worker fetch `ExecutionContext.waitUntil`, injected via the per-request context argument of the web handler (`HttpEffect.toWebHandlerWith`'s second arg). Registering a promise keeps the Worker isolate alive until it settles, so a turn driver forked detached from the request fiber survives client disconnect and runs to completion. */
export class WaitUntil extends Context.Service<
  WaitUntil,
  (promise: Promise<unknown>) => void
>()("api/WaitUntil") {}
