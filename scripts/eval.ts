#!/usr/bin/env bun
/**
 * Regression eval harness for a candidate model/skill/role against the archived
 * session corpus. For each archive it replays the original user turns into a
 * fresh eval session on a running worker, then (a) deterministically diffs the
 * candidate tool trajectory against the archived baseline and (b) LLM-judges
 * whether the candidate's final answer is equivalent to the baseline's via the
 * toolkit-free `/tasks` endpoint. Exits non-zero if any case regresses.
 *
 * WARNING: every non-dry-run case makes REAL, billed model calls — the candidate
 * replay (one prompt per archived user turn) plus one judge call. Point it at a
 * TINY corpus (`--limit`, `--name`) and prefer `--dry-run` to inspect the corpus
 * without spending anything.
 *
 * Usage: bun run eval [--url URL] [--model CANDIDATE] [--skill S] [--role R]
 *          [--judge-model JM] [--limit N] [--name FILTER] [--dry-run] [--json]
 */

import type { JudgeVerdict } from "./eval-core.ts"
import { makePromptRequest, SubagentTaskRequest } from "../packages/shared/src/index.ts"
import { Cause, Console, Effect } from "effect"
import {
  buildJudgePrompt,
  diffTrajectory,
  extractTrajectory,
  extractUserTurns,
  finalAnswer,
  parseJudgeVerdict,
} from "./eval-core.ts"
import { ApiClient, bootstrap, fetchAllEvents, runMain } from "./lib.ts"

const USAGE = [
  "Usage: bun run eval [--url URL] [--model CANDIDATE] [--skill S] [--role R]",
  "                    [--judge-model JM] [--limit N] [--name FILTER] [--dry-run] [--json]",
].join("\n")

const DEFAULT_MODEL = "openai/gpt-4o-mini"

/** One evaluated archive: the case identity, the deterministic trajectory verdict, the judge verdict, and whether the case FAILED the eval. A case fails (`regressed`) when the trajectory diverges, the judge is not `equivalent` (an `inconclusive` or absent judge signal counts as a failure, never a silent pass), or the replay itself errored (`trajectory === "ERROR"`, `verdict === "error"`). */
interface CaseResult {
  readonly name: string
  readonly id: string
  readonly closedAt: number
  readonly trajectory: "OK" | "DIFF" | "ERROR"
  readonly differences: ReadonlyArray<string>
  readonly verdict: JudgeVerdict | "error"
  readonly regressed: boolean
}

/** CLI entry — skipped when imported (e.g. by tests). */
if (import.meta.main) {
  const { parsed, runtime } = bootstrap(process.argv.slice(2), new Set(["dry-run", "json"]), USAGE)

  const candidateModel = parsed.flags["model"] ?? DEFAULT_MODEL
  const judgeModel = parsed.flags["judge-model"] ?? DEFAULT_MODEL
  const overrides = {
    model: candidateModel,
    ...(parsed.flags["skill"] !== undefined ? { skill: parsed.flags["skill"] } : {}),
    ...(parsed.flags["role"] !== undefined ? { role: parsed.flags["role"] } : {}),
  }

  const main = Effect.gen(function*() {
    const api = yield* ApiClient

    const { archives } = yield* api.archives.listArchives()
    const nameFilter = parsed.flags["name"]
    const filtered = nameFilter !== undefined
      ? archives.filter((archive) => archive.name.includes(nameFilter))
      : archives
    const limitFlag = parsed.flags["limit"]
    if (limitFlag !== undefined && !/^[1-9][0-9]*$/.test(limitFlag)) {
      return yield* Effect.fail(new Error(`--limit must be a positive integer, got "${limitFlag}"`))
    }
    const limit = limitFlag !== undefined ? Number.parseInt(limitFlag, 10) : undefined
    const corpus = limit !== undefined ? filtered.slice(0, limit) : filtered

    if (corpus.length === 0) {
      yield* Console.log("(corpus empty — close a session with ?mode=archive first)")
      return true
    }

    if (parsed.flags["dry-run"] === "true") {
      yield* Effect.forEach(corpus, (summary) =>
        Console.log(`${summary.name}/${summary.id}/${summary.closedAt}  ${summary.sizeBytes}b`))
      return true
    }

    const evaluated = yield* Effect.forEach(corpus, (summary) => {
      const { name, id, closedAt } = summary
      const where = `${name}/${id}/${closedAt}`
      return Effect.gen(function*() {
        const archive = yield* api.archives.getArchive({ params: { name, id, closedAt } })
        const baseline = extractTrajectory(archive.events)
        const baselineAnswer = finalAnswer(archive.events)
        const userTurns = extractUserTurns(archive)
        if (userTurns.length === 0) {
          yield* Console.log(`skip ${where} — no user turns to replay`)
          return undefined
        }

        const evalName = `eval-${name}`
        const evalId = `${id}-${closedAt}-${Date.now()}`
        const purge = api.agents
          .reset({ params: { name: evalName, id: evalId }, query: { mode: "purge" } })
          .pipe(Effect.ignore)

        return yield* Effect.gen(function*() {
          yield* api.agents.putConfig({
            params: { name: evalName, id: evalId },
            payload: {
              defaultModel: candidateModel,
              rules: { Bash: "allow", request_secret: "deny", create_scheduled_job: "deny" },
            },
          })
          yield* Effect.forEach(userTurns, (turn) =>
            api.agents.prompt({
              params: { name: evalName, id: evalId },
              payload: makePromptRequest(turn.content, overrides),
            }))

          const events = yield* fetchAllEvents(api, evalName, evalId)
          const candidate = extractTrajectory(events)
          const candidateAnswer = finalAnswer(events)
          const diff = diffTrajectory(baseline, candidate)

          const judgePrompt = buildJudgePrompt({
            userTurns: userTurns.map((turn) => turn.content),
            baselineAnswer,
            candidateAnswer,
          })
          const judge = yield* api.agents.task({
            payload: new SubagentTaskRequest({ prompt: judgePrompt, model: judgeModel }),
          })
          const verdict = parseJudgeVerdict(judge.text)

          const result: CaseResult = {
            name,
            id,
            closedAt,
            trajectory: diff.matches ? "OK" : "DIFF",
            differences: diff.differences,
            verdict,
            regressed: !diff.matches || verdict !== "equivalent",
          }
          return result
        }).pipe(Effect.ensuring(purge))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function*() {
            yield* Console.error(`error ${where}: ${Cause.pretty(cause)}`)
            const result: CaseResult = {
              name,
              id,
              closedAt,
              trajectory: "ERROR",
              differences: [Cause.pretty(cause)],
              verdict: "error",
              regressed: true,
            }
            return result
          })),
      )
    })

    const results = evaluated.filter((result) => result !== undefined)
    const regressedCount = results.filter((result) => result.regressed).length

    if (parsed.flags["json"] === "true") {
      yield* Console.log(JSON.stringify({ total: results.length, regressed: regressedCount, cases: results }))
    } else {
      yield* Effect.forEach(results, (result) =>
        Effect.gen(function*() {
          yield* Console.log(`${result.name}/${result.id}/${result.closedAt}`)
          yield* Console.log(`  trajectory: ${result.trajectory}`)
          if (result.differences.length > 0) {
            yield* Effect.forEach(result.differences, (difference) => Console.log(`    - ${difference}`))
          }
          yield* Console.log(`  judge: ${result.verdict}`)
        }))
      yield* Console.log(`${results.length} cases, ${regressedCount} regressed`)
    }

    return regressedCount === 0
  })

  await runMain(main, runtime)
}
