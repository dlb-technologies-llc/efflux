import { useAtomRefresh, useAtomSet, useAtomSubscribe, useAtomValue } from "@effect/atom-react"
import { MAX_UPLOAD_BYTES, type StreamPart } from "@efflux/shared"
import { Exit } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import { Paperclip } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"

import { historyAtom, noParts, resumeAtom, streamAtom } from "../atoms.ts"
import { uploadFileFn } from "../atoms/files.ts"
import { latestTurnInFlight } from "../atoms/journal.ts"
import { skillsListAtom } from "../atoms/skills.ts"
import { failureMessage } from "../errors.ts"
import { historyForResume } from "../format.ts"
import {
  currentSessionAtom,
  journalVersionAtom,
  selectedModelAtom,
  selectedSkillAtom,
} from "../session.ts"
import { activeSlashToken, skillFromMessage } from "../slashCommand.ts"
import { toWorkspaceFilename } from "../upload.ts"
import { useJournal } from "../useJournal.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"
import { Message } from "./Message.tsx"
import { MessageList } from "./MessageList.tsx"
import { SLASH_MENU_LISTBOX_ID, SlashCommandMenu, slashOptionId } from "./SlashCommandMenu.tsx"
import { StatusPill } from "./StatusPill.tsx"
import type { ToolCallView } from "./ToolCallCard.tsx"

/** Distance (px) from the bottom within which the transcript counts as "pinned" and keeps auto-scrolling. */
const NEAR_BOTTOM_PX = 80

/** Live chat view: renders session history and streams the current assistant turn. */
export function Chat() {
  const [input, setInput] = React.useState("")
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  const [parts, setParts] = React.useState<ReadonlyArray<StreamPart>>(noParts)
  const [pendingUserMessage, setPendingUserMessage] = React.useState<string | null>(null)
  const [atBottom, setAtBottom] = React.useState(true)

  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = React.useState(false)
  const [uploadStatus, setUploadStatus] = React.useState<string | null>(null)
  const runUpload = useAtomSet(uploadFileFn, { mode: "promiseExit" })

  const session = useAtomValue(currentSessionAtom)
  const model = useAtomValue(selectedModelAtom)
  const skill = useAtomValue(selectedSkillAtom)
  const bumpJournal = useAtomSet(journalVersionAtom)

  const skillsResult = useAtomValue(skillsListAtom)
  const skills = AsyncResult.isSuccess(skillsResult) ? skillsResult.value.skills : []
  const skillNames = skills.map((entry) => entry.name)

  const [menuIndex, setMenuIndex] = React.useState(0)
  const [dismissedToken, setDismissedToken] = React.useState<string | null>(null)
  const [cursor, setCursor] = React.useState(0)
  const [pendingCursor, setPendingCursor] = React.useState<number | null>(null)
  const composerRef = React.useRef<HTMLDivElement>(null)

  const token = activeSlashToken(input, cursor)
  const filtered =
    token === null
      ? []
      : skills.filter((entry) => entry.name.toLowerCase().includes(token.toLowerCase()))
  const menuOpen = token !== null && filtered.length > 0 && dismissedToken !== token

  React.useEffect(() => {
    setMenuIndex(0)
  }, [token])

  const composerTextarea = React.useCallback(
    () => composerRef.current?.querySelector<HTMLTextAreaElement>('[data-slot="textarea"]') ?? null,
    [],
  )

  React.useLayoutEffect(() => {
    if (pendingCursor === null) return
    const textarea = composerTextarea()
    if (textarea !== null) {
      textarea.focus()
      textarea.setSelectionRange(pendingCursor, pendingCursor)
      setCursor(pendingCursor)
    }
    setPendingCursor(null)
  }, [pendingCursor, composerTextarea])

  /** Complete the token at the caret in place: replace the partial `/tok` with `/<name> `, leaving the rest of the message untouched, and park the caret after the inserted space. */
  const acceptSkill = (name: string) => {
    if (token === null) return
    const slashIndex = cursor - token.length - 1
    setInput(`${input.slice(0, slashIndex)}/${name} ${input.slice(cursor)}`)
    setPendingCursor(slashIndex + name.length + 2)
    setDismissedToken(null)
  }

  const sessionAtom = historyAtom(session)
  const historyResult = useAtomValue(sessionAtom)
  const refreshHistory = useAtomRefresh(sessionAtom)
  const runStream = useAtomSet(streamAtom, { mode: "promiseExit" })

  const [resuming, setResuming] = React.useState(false)
  const resumingRef = React.useRef(false)
  const resumeHandledRef = React.useRef<string | null>(null)
  const currentKeyRef = React.useRef<string | null>(null)
  const sessionKey = `${session.name}/${session.id}`
  const { result: journalResult } = useJournal(session)
  const sessionResumeAtom = resumeAtom(session)
  const runResume = useAtomSet(sessionResumeAtom, { mode: "promiseExit" })

  React.useEffect(() => {
    currentKeyRef.current = sessionKey
  })

  const onResult = React.useCallback(
    (result: AsyncResult.AsyncResult<ReadonlyArray<StreamPart>, unknown>) => {
      if (AsyncResult.isSuccess(result)) setParts(result.value)
    },
    [],
  )
  useAtomSubscribe(streamAtom, onResult)

  const onResumeResult = React.useCallback(
    (result: AsyncResult.AsyncResult<ReadonlyArray<StreamPart>, unknown>) => {
      if (!resumingRef.current) return
      if (AsyncResult.isSuccess(result)) setParts(result.value)
    },
    [],
  )
  useAtomSubscribe(sessionResumeAtom, onResumeResult)

  const streamingText = parts.reduce(
    (text, part) => (part._tag === "text-delta" ? text + part.delta : text),
    "",
  )
  const streamError = parts.reduce<string | null>(
    (message, part) => (part._tag === "error" ? part.message : message),
    submitError,
  )
  const streamActive = parts.length > 0
  const awaitingApproval = parts.some((part) => part._tag === "approval-request")

  const toolViews: ReadonlyArray<ToolCallView> = parts.flatMap((part) => {
    if (part._tag !== "tool-call") return []
    const match = parts.find(
      (other) => other._tag === "tool-result" && other.id === part.id,
    )
    const view: ToolCallView = {
      name: part.name,
      ...(part.params !== undefined ? { params: part.params } : {}),
      ...(match !== undefined && match._tag === "tool-result"
        ? { result: match.result, isFailure: match.isFailure }
        : { running: true }),
    }
    return [view]
  })

  /** Upload the picked file's raw bytes to the session workspace: pre-check the 10 MB cap, sanitize the browser name to the contract's `WorkspaceFilename`, then surface an "uploaded ✓" (or error) status pill. Clears the input value each time so re-picking the same file re-fires `onChange`. */
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file === undefined) return
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadStatus("File exceeds the 10 MB limit")
      event.target.value = ""
      return
    }
    const filename = toWorkspaceFilename(file.name)
    const bytes = new Uint8Array(await file.arrayBuffer())
    setUploading(true)
    setUploadStatus(null)
    const exit = await runUpload({ ...session, filename, bytes })
    setUploading(false)
    Exit.match(exit, {
      onFailure: (cause) => setUploadStatus(failureMessage(cause, "Upload failed")),
      onSuccess: () => setUploadStatus(`${filename} uploaded ✓ — reference it as ${filename}`),
    })
    event.target.value = ""
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = input.trim()
    if (message.length === 0) return
    const inlineSkill = skillFromMessage(message, skillNames)
    setParts(noParts)
    setSubmitError(null)
    setInput("")
    setCursor(0)
    setDismissedToken(null)
    setPendingUserMessage(message)
    setPending(true)
    const exit = await runStream({
      ...session,
      message,
      ...(model !== "" ? { model } : {}),
      ...(inlineSkill !== undefined ? { skill: inlineSkill } : skill !== "" ? { skill } : {}),
    })
    setPending(false)
    Exit.match(exit, {
      onFailure: (cause) => {
        setSubmitError(failureMessage(cause, "Stream failed"))
        setParts(noParts)
      },
      onSuccess: () => {
        refreshHistory()
        bumpJournal((v) => v + 1)
      },
    })
  }

  const previousHistoryLengthRef = React.useRef(0)
  React.useEffect(() => {
    setParts(noParts)
    setPendingUserMessage(null)
    setSubmitError(null)
    previousHistoryLengthRef.current = 0
    setResuming(false)
    resumingRef.current = false
  }, [session.name, session.id])

  React.useLayoutEffect(() => {
    if (!AsyncResult.isSuccess(historyResult)) return
    const length = historyResult.value.history.length
    if (length > previousHistoryLengthRef.current) {
      setParts(noParts)
      setPendingUserMessage(null)
    }
    previousHistoryLengthRef.current = length
  }, [historyResult])

  React.useEffect(() => {
    if (resumeHandledRef.current === sessionKey) return
    if (!AsyncResult.isSuccess(historyResult)) return
    if (!AsyncResult.isSuccess(journalResult)) return
    resumeHandledRef.current = sessionKey
    if (!latestTurnInFlight(journalResult.value)) return
    const key = sessionKey
    setResuming(true)
    resumingRef.current = true
    void runResume(session).then(() => {
      if (currentKeyRef.current !== key) return
      setResuming(false)
      resumingRef.current = false
      setParts(noParts)
      refreshHistory()
      bumpJournal((v) => v + 1)
    })
  }, [sessionKey, historyResult, journalResult, runResume, refreshHistory, bumpJournal])

  const scrollRegionRef = React.useRef<HTMLDivElement>(null)
  const getViewport = React.useCallback(
    () =>
      scrollRegionRef.current?.querySelector<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      ) ?? null,
    [],
  )

  React.useEffect(() => {
    const viewport = getViewport()
    if (viewport === null) return
    const onScroll = () => {
      const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      setAtBottom(distance <= NEAR_BOTTOM_PX)
    }
    onScroll()
    viewport.addEventListener("scroll", onScroll)
    return () => viewport.removeEventListener("scroll", onScroll)
  }, [getViewport])

  const historyLength = AsyncResult.isSuccess(historyResult)
    ? historyResult.value.history.length
    : 0
  React.useEffect(() => {
    if (!atBottom) return
    const viewport = getViewport()
    if (viewport === null) return
    viewport.scrollTop = viewport.scrollHeight
  }, [atBottom, getViewport, historyLength, streamingText, toolViews.length, pending, awaitingApproval])

  const jumpToLatest = () => {
    const viewport = getViewport()
    if (viewport === null) return
    viewport.scrollTop = viewport.scrollHeight
    setAtBottom(true)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setMenuIndex((current) => (current + 1) % filtered.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setMenuIndex((current) => (current - 1 + filtered.length) % filtered.length)
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        const choice = filtered[menuIndex]
        if (choice !== undefined) acceptSkill(choice.name)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setDismissedToken(token)
        return
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  const syncCursor = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCursor(event.currentTarget.selectionStart)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div ref={scrollRegionRef} className="relative flex-1 min-h-0 flex flex-col">
        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col gap-4 p-4">
            <AsyncBoundary result={historyResult}>
              {(value) => (
                <MessageList
                  messages={resuming && parts.length > 0 ? historyForResume(value.history) : value.history}
                />
              )}
            </AsyncBoundary>
            {pendingUserMessage !== null ? (
              <Message variant="user" content={pendingUserMessage} />
            ) : null}
            {streamActive || pending ? (
              <Message variant="assistant" streaming content={streamingText} tools={toolViews} />
            ) : null}
            {resuming ? <StatusPill state="accent" dot label="resuming…" /> : null}
            {awaitingApproval ? (
              <StatusPill state="warning" dot label="awaiting approval — act in Approvals" />
            ) : null}
            {uploadStatus !== null ? <StatusPill state="accent" dot label={uploadStatus} /> : null}
            {streamError !== null ? (
              <p className="text-destructive text-sm">{streamError}</p>
            ) : null}
          </div>
        </ScrollArea>
        {atBottom ? null : (
          <Button
            variant="outline"
            size="sm"
            className="absolute bottom-3 right-3 shadow-md"
            onClick={jumpToLatest}
          >
            Jump to latest
          </Button>
        )}
      </div>
      <form className="flex items-end gap-2 border-t border-border p-3" onSubmit={handleSubmit}>
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={pending || resuming || uploading}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach a file to the workspace"
        >
          <Paperclip />
        </Button>
        <div ref={composerRef} className="relative flex-1">
          {menuOpen ? (
            <SlashCommandMenu items={filtered} activeIndex={menuIndex} onSelect={acceptSkill} />
          ) : null}
          <Textarea
            className="w-full min-h-9 max-h-40 resize-none"
            rows={1}
            placeholder="Message the agent…  type /skill anywhere to apply a skill · ⌘↵ to send"
            value={input}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={menuOpen}
            aria-controls={SLASH_MENU_LISTBOX_ID}
            aria-activedescendant={menuOpen ? slashOptionId(menuIndex) : undefined}
            onChange={(event) => {
              setInput(event.target.value)
              setCursor(event.target.selectionStart)
              setDismissedToken(null)
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={syncCursor}
            onClick={syncCursor}
            onSelect={syncCursor}
            disabled={pending || resuming}
          />
        </div>
        <Button type="submit" disabled={pending || resuming || input.trim().length === 0}>
          {pending ? "Sending…" : "Send"}
        </Button>
      </form>
    </div>
  )
}
