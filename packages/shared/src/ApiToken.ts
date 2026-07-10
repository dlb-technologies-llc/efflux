import { Context } from "effect"
import type { Redacted } from "effect"

/** The configured server API token, provided per-request from `env.API_TOKEN`; AuthMiddleware compares the bearer credential against it. */
export class ApiToken extends Context.Service<ApiToken, Redacted.Redacted<string>>()("api/ApiToken") {}
