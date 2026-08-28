/**
 * Pins for the pure outcome formatters in `Notify.ts` — `formatSlackText`,
 * `formatEmailSubject`, and `formatEmailText` — across the run shapes the DO
 * builds: a failed run (non-zero exit, stderr present), a success run
 * ("ok"/exit 0), an errored run (exit -1, message in stderr, empty stdout), an
 * empty-output run, and a very long output (tail truncation). These are one-off
 * pure-function fixtures, so plain object literals rather than schema
 * arbitraries. `sendSlack` is not exercised here (no live fetch in unit tests).
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { type NotifyOutcome, formatEmailSubject, formatEmailText, formatSlackText } from "./Notify.ts"

const failed: NotifyOutcome = {
  description: "nightly backup",
  status: "failed (exit 2)",
  exitCode: 2,
  startedAt: 1_000_000,
  finishedAt: 1_007_000,
  stdoutExcerpt: "starting backup...",
  stderrExcerpt: "tar: permission denied\nbackup aborted",
}

const success: NotifyOutcome = {
  description: "fetch weather",
  status: "ok",
  exitCode: 0,
  startedAt: 2_000_000,
  finishedAt: 2_003_500,
  stdoutExcerpt: '{"weather":"clear"}',
  stderrExcerpt: "",
}

const errored: NotifyOutcome = {
  description: "restore snapshot",
  status: "failed (exit -1)",
  exitCode: -1,
  startedAt: 3_000_000,
  finishedAt: 3_000_500,
  stdoutExcerpt: "",
  stderrExcerpt: "runner restore failed 500",
}

const emptyOutput: NotifyOutcome = {
  description: "noop probe",
  status: "ok",
  exitCode: 0,
  startedAt: 4_000_000,
  finishedAt: 4_001_000,
  stdoutExcerpt: "",
  stderrExcerpt: "",
}

const longTail = "X".repeat(50) + "Y".repeat(900)
const longOutput: NotifyOutcome = {
  description: "verbose job",
  status: "failed (exit 1)",
  exitCode: 1,
  startedAt: 5_000_000,
  finishedAt: 5_002_000,
  stdoutExcerpt: "",
  stderrExcerpt: longTail,
}

describe("formatSlackText", () => {
  it("failed run: surfaces status, exit code, and the stderr tail", () => {
    const text = formatSlackText(failed)
    expect(text).toContain("nightly backup")
    expect(text).toContain("failed (exit 2)")
    expect(text).toContain("Exit code: 2")
    expect(text).toContain("Duration: 7s")
    expect(text).toContain("tar: permission denied")
    expect(text).toContain("backup aborted")
  })

  it("success run: shows ok status and falls back to stdout when stderr is empty", () => {
    const text = formatSlackText(success)
    expect(text).toContain("fetch weather")
    expect(text).toContain("Status: ok")
    expect(text).toContain("Exit code: 0")
    expect(text).toContain("Duration: 4s")
    expect(text).toContain('{"weather":"clear"}')
  })

  it("errored run: shows exit -1 and the stderr message", () => {
    const text = formatSlackText(errored)
    expect(text).toContain("restore snapshot")
    expect(text).toContain("failed (exit -1)")
    expect(text).toContain("Exit code: -1")
    expect(text).toContain("runner restore failed 500")
  })

  it("empty output: still produces a sensible message without crashing", () => {
    const text = formatSlackText(emptyOutput)
    expect(text).toContain("noop probe")
    expect(text).toContain("Status: ok")
    expect(text).toContain("(none)")
  })

  it("very long output: keeps only the trailing 500 chars", () => {
    const text = formatSlackText(longOutput)
    expect(text).toContain("Y".repeat(500))
    expect(text).not.toContain("X")
  })
})

describe("formatEmailSubject", () => {
  it("failed run: prefixes [efflux] and joins description with status", () => {
    expect(formatEmailSubject(failed)).toBe("[efflux] nightly backup — failed (exit 2)")
  })

  it("success run: reflects the ok status", () => {
    expect(formatEmailSubject(success)).toBe("[efflux] fetch weather — ok")
  })

  it("errored run: reflects the exit -1 status", () => {
    expect(formatEmailSubject(errored)).toBe("[efflux] restore snapshot — failed (exit -1)")
  })
})

describe("formatEmailText", () => {
  it("failed run: labelled sections plus the stderr excerpt", () => {
    const text = formatEmailText(failed)
    expect(text).toContain("nightly backup")
    expect(text).toContain("Status: failed (exit 2)")
    expect(text).toContain("Exit code: 2")
    expect(text).toContain("Duration: 7s")
    expect(text).toContain("stdout:")
    expect(text).toContain("starting backup...")
    expect(text).toContain("stderr:")
    expect(text).toContain("tar: permission denied")
  })

  it("success run: ok status with stdout populated and stderr marked (none)", () => {
    const text = formatEmailText(success)
    expect(text).toContain("Status: ok")
    expect(text).toContain('{"weather":"clear"}')
    expect(text).toContain("stderr:\n(none)")
  })

  it("errored run: empty stdout marked (none), stderr message present", () => {
    const text = formatEmailText(errored)
    expect(text).toContain("Status: failed (exit -1)")
    expect(text).toContain("stdout:\n(none)")
    expect(text).toContain("runner restore failed 500")
  })

  it("empty output: both sections marked (none) and no crash", () => {
    const text = formatEmailText(emptyOutput)
    expect(text).toContain("Status: ok")
    expect(text).toContain("stdout:\n(none)")
    expect(text).toContain("stderr:\n(none)")
  })

  it("very long output: stderr excerpt truncated to the trailing 500 chars", () => {
    const text = formatEmailText(longOutput)
    expect(text).toContain("Y".repeat(500))
    expect(text).not.toContain("X")
  })
})
