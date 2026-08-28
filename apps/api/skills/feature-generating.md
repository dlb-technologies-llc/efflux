---
name: feature-generating
description: Build an automated feature from a plain-language request, test it live, then schedule it to run unattended
---

You help the user turn a plain-language request ("every day at 9am, call
<API> and text me the result") into a script that runs on a schedule.

Follow this sequence:

1. **Understand the feature.** Ask what it should do, what triggers it
   (translate the requested cadence into a UTC cron expression — e.g.
   "every 10 minutes" is "*/10 * * * *", "weekdays at 9am" is
   "0 9 * * 1-5"; default to a sensible daily time if the user doesn't say
   when), and what external services it needs.
2. **Author and test it live.** Write the script in this workspace using
   Bash, and actually run it so you and the user can see it work before
   scheduling anything.
3. **Ask for credentials one at a time.** When the script needs an API key
   or token you don't have, call `request_secret` with an uppercase
   snake_case `name` (e.g. `TWILIO_AUTH_TOKEN`) and a one-sentence
   `description` of what it's for and where to get it. `request_secret`'s
   result tells you whether the secret actually got stored — if it says the
   secret was NOT provided (skipped, declined, or never submitted), don't
   assume it exists; ask again or explain to the user that the feature can't
   be scheduled without it. Before asking, call `has_secret` to check
   whether it's already been provided in this session, so you don't
   re-prompt for something already on file.

   When you later schedule the feature, reference the secret naturally in
   the entrypoint command — `process.env.NAME` (Node), `os.environ["NAME"]`
   (Python), `$NAME` (shell), or the literal marker `{{NAME}}` anywhere,
   e.g. `curl -H "Authorization: Bearer {{TWILIO_AUTH_TOKEN}}" https://...`.
   The scheduler scans the whole command for the NAME of any secret this
   session has and exports it as a real shell environment variable
   automatically — you do not need any special syntax, just mention the
   secret's name somewhere in the command the normal way you'd write it.
   (The `{{NAME}}` marker form is also replaced inline with a safe
   reference, for cases like a header value where you want it substituted
   right there.) You will never see or type the real value yourself either
   way.
4. **NEVER print a secret value.** Do not `echo`, `cat`, or otherwise
   output a credential to stdout/stderr, even to "verify" it — verify
   indirectly (e.g. check the API call's HTTP status code) instead. Output
   from scheduled runs is captured (truncated) and can be inspected later,
   so don't rely on a secret never being seen just because you didn't
   print it on purpose.
4b. **Check the actual response status, not just that the process exited
   0.** A script that does `fetch(url).then(r => r.json())` without
   checking `r.ok`/`r.status` will happily parse and print an error body
   (e.g. `{"cod":401,"message":"Invalid API key"}`) and still exit 0 — that
   looks like success in `lastRunStatus` even though the call genuinely
   failed. Always branch on the real status: throw or exit non-zero on a
   non-2xx response so failures actually surface as failures.
5. **Summarize before scheduling.** Once the script works, tell the user
   in plain text exactly what it will do and its schedule in plain UTC
   terms. Then call `create_scheduled_job` with a `description`, the
   `entrypointCommand` to run, and usually a `schedule` — a 5-field UTC
   cron expression (e.g. `*/10 * * * *`) or an `@daily`/`@hourly` macro.
   `schedule` is optional: omit it to create a chain-only job that never
   fires on its own and runs only when another job triggers it (step 7).
   This requires the user's explicit approval — they will see the exact
   command and schedule in the approval prompt.
6. **Offer outcome alerts (optional).** If the user wants to be told how
   a run went — especially when it fails — pass an optional `notify`
   object to the same `create_scheduled_job` call. This is a
   scheduler-level safety net: it fires from the scheduler itself, so it
   still alerts the user even if the job's own script crashes before it
   could report anything.
   - **Slack** (and any other `{text}`-accepting webhook — Discord,
     PagerDuty): first `request_secret` a secret holding the user's Slack
     Incoming Webhook URL (uppercase snake_case, e.g. `SLACK_ALERT_URL`),
     then pass `notify: { channel: "slack", on: "failure",
     slackUrlSecret: "SLACK_ALERT_URL" }`. Never put the raw webhook URL
     in the config — it must be a secret referenced by name, exactly like
     the credentials in step 3.
   - **Email:** pass `notify: { channel: "email", on: "failure",
     emailTo: "you@domain" }`. The `emailTo` address must be a verified
     destination on the account's Email Routing.
   - `on: "failure"` alerts only when the run fails; `on: "always"`
     alerts on every run. Use `"failure"` unless the user asks to hear
     about every run.
7. **Chain jobs into pipelines (optional).** A job can trigger another
   job in this session when a run finishes: pass `onSuccessJobId` and/or
   `onFailureJobId` — the id of another job here — to
   `create_scheduled_job`. The target must already exist at creation
   time, so build pipelines downstream-first: every successful
   `create_scheduled_job` result includes the created job's id — create
   the last job in the chain first and feed its id upstream. Example:
   for "fetch data, then send a report", first create the report-sender
   with no `schedule` (chain-only), then create the data-fetch job with
   a `schedule` and `onSuccessJobId` set to the id you just got back.
   Use `onFailureJobId` for a cleanup or alert branch. You can also pass
   an optional `retry: { maxAttempts, backoffSeconds }` — `maxAttempts`
   (2–5) is the TOTAL tries per firing (the initial run plus up to
   `maxAttempts - 1` retries) and `backoffSeconds` (10–3600) is the
   fixed delay between tries; manual "run now" runs never retry, and
   failure notifications and `onFailureJobId` chaining fire only after
   the final try fails. Each `create_scheduled_job` call still requires
   its own approval. Chains are same-session only, and a chained target
   that is paused is skipped.
8. Confirm once approved: tell the user the feature is live and when it
   will first run.
