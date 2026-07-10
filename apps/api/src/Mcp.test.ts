/**
 * Regression pins for the pure SSE frame helpers behind `readSseReply`.
 *
 * The MCP Streamable-HTTP transport may deliver a JSON-RPC reply as an SSE
 * stream, chunked arbitrarily by the network. `parseSseFrames` freezes the
 * framing contract: an event is complete only once a blank line terminates it,
 * `\r\n` and `\n` endings parse identically, a single optional leading space
 * after `data:` is stripped, non-`data:` keep-alive/comment lines are dropped,
 * and a frame split across reads is preserved in `rest` for the next chunk.
 * `flushSseFrame` pins the stream-end flush of a final unterminated event, and
 * `matchFrameById` pins the "first matching id wins, skip non-JSON" selection.
 *
 * @module
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { flushSseFrame, matchFrameById, parseSseFrames } from "./Mcp.ts"

const rpc = (id: number): string => JSON.stringify({ jsonrpc: "2.0", id, result: { n: id } })

describe("parseSseFrames", () => {
  it.effect("extracts one complete frame and clears the rest", () =>
    Effect.sync(() =>
      expect(parseSseFrames(`data: ${rpc(1)}\n\n`)).toEqual({ frames: [rpc(1)], rest: "" })))

  it.effect("extracts multiple complete frames from a single buffer", () =>
    Effect.sync(() =>
      expect(parseSseFrames(`data: ${rpc(1)}\n\ndata: ${rpc(2)}\n\n`)).toEqual({
        frames: [rpc(1), rpc(2)],
        rest: "",
      })))

  it.effect("parses CRLF line endings identically to LF, joining multi-line data by \\n", () =>
    Effect.sync(() =>
      expect(parseSseFrames("data: a\r\ndata: b\r\n\r\n")).toEqual({ frames: ["a\nb"], rest: "" })))

  it.effect("strips exactly one optional leading space after data:", () =>
    Effect.sync(() => {
      expect(parseSseFrames("data:x\n\n").frames).toEqual(["x"])
      expect(parseSseFrames("data: x\n\n").frames).toEqual(["x"])
      expect(parseSseFrames("data:  x\n\n").frames).toEqual([" x"])
    }))

  it.effect("drops keep-alive comment lines within an event", () =>
    Effect.sync(() =>
      expect(parseSseFrames(`: ping\ndata: ${rpc(7)}\n\n`)).toEqual({ frames: [rpc(7)], rest: "" })))

  it.effect("yields no frame for an event that carries no data line", () =>
    Effect.sync(() => expect(parseSseFrames(": ping\n\n")).toEqual({ frames: [], rest: "" })))

  it.effect("preserves a trailing partial line as rest", () =>
    Effect.sync(() =>
      expect(parseSseFrames(`data: ${rpc(1)}\n\ndata: {"id`)).toEqual({
        frames: [rpc(1)],
        rest: 'data: {"id',
      })))

  it.effect("holds a data line without its terminating blank in rest", () =>
    Effect.sync(() =>
      expect(parseSseFrames("data: a\n")).toEqual({ frames: [], rest: "data: a\n" })))

  it.effect("reassembles a frame split across two chunks via rest", () =>
    Effect.sync(() => {
      const first = parseSseFrames('data: {"id')
      expect(first).toEqual({ frames: [], rest: 'data: {"id' })
      const second = parseSseFrames(`${first.rest}":1}\n\n`)
      expect(second).toEqual({ frames: ['{"id":1}'], rest: "" })
    }))

  it.effect("reassembles a multi-line frame split mid-event across chunks", () =>
    Effect.sync(() => {
      const first = parseSseFrames("data: a\n")
      expect(first.frames).toEqual([])
      const second = parseSseFrames(`${first.rest}data: b\n\n`)
      expect(second).toEqual({ frames: ["a\nb"], rest: "" })
    }))
})

describe("flushSseFrame", () => {
  it.effect("flushes a final unterminated single-line event", () =>
    Effect.sync(() => expect(flushSseFrame(`data: ${rpc(3)}`)).toBe(rpc(3))))

  it.effect("flushes a final unterminated multi-line event", () =>
    Effect.sync(() => expect(flushSseFrame("data: a\ndata: b")).toBe("a\nb")))

  it.effect("tolerates a trailing carriage return on the final line", () =>
    Effect.sync(() => expect(flushSseFrame("data: a\r")).toBe("a")))

  it.effect("returns undefined when the rest carries no data line", () =>
    Effect.sync(() => {
      expect(flushSseFrame("")).toBeUndefined()
      expect(flushSseFrame(": ping")).toBeUndefined()
    }))
})

describe("matchFrameById", () => {
  it.effect("returns the first frame whose parsed id matches", () =>
    Effect.sync(() =>
      expect(matchFrameById([rpc(1), rpc(2)], 2)).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { n: 2 },
      })))

  it.effect("skips non-JSON frames while searching for the matching id", () =>
    Effect.sync(() =>
      expect(matchFrameById(["not json", rpc(5)], 5)).toEqual({
        jsonrpc: "2.0",
        id: 5,
        result: { n: 5 },
      })))

  it.effect("returns undefined when no frame matches the id", () =>
    Effect.sync(() => {
      expect(matchFrameById([rpc(1)], 2)).toBeUndefined()
      expect(matchFrameById([], 1)).toBeUndefined()
    }))
})
