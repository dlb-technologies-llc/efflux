import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { SafeId, type SessionInfo, SUGGESTED_MODEL_IDS } from "@effect-flue/shared"
import { Schema } from "effect"
import { CheckIcon, ChevronsUpDownIcon, PlusIcon, RotateCwIcon } from "lucide-react"
import * as React from "react"
import { useForm } from "react-hook-form"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { sessionsAtom } from "../atoms/sessions.ts"
import { skillsListAtom } from "../atoms/skills.ts"
import { formatRelativeTime } from "../format.ts"
import { currentSessionAtom, selectedModelAtom, selectedSkillAtom } from "../session.ts"
import { AsyncBoundary } from "./AsyncBoundary.tsx"

/** Session `name`/`id` segment validator, derived from the shared `SafeId` schema the Worker's DO key uses. */
const isSegment = Schema.is(SafeId)

/** Human hint mirroring the `SafeId` charset the Worker enforces on `:name`/`:id` path segments. */
const SAFE_ID_HINT = "[a-zA-Z0-9_-] · 1–128 chars"

/** Sentinel `Select` value for "no skill overlay"; Radix forbids an empty-string item value, so it maps to `""` at the atom boundary. */
const NO_SKILL = "__none__"

/** Sentinel combobox value for "use the session default model"; selecting it writes `""`. */
const MODEL_DEFAULT = "__default__"

/** The two free-text fields of the new-session form — plumbing only; both flow through `SafeId` on validate. */
type NewSessionFields = {
  readonly name: string
  readonly id: string
}

/**
 * Left-rail control: lists known sessions, switches or creates the active
 * session (`currentSessionAtom`), and picks the per-request model override
 * (`selectedModelAtom`) and skill overlay (`selectedSkillAtom`). Every other
 * panel reads those atoms — this is the only writer.
 */
export function SessionSwitcher() {
  const sessions = useAtomValue(sessionsAtom)
  const refresh = useAtomRefresh(sessionsAtom)
  const current = useAtomValue(currentSessionAtom)
  const setSession = useAtomSet(currentSessionAtom)

  const isActive = (session: SessionInfo): boolean => session.name === current.name && session.id === current.id

  const form = useForm<NewSessionFields>({ defaultValues: { name: "", id: "" }, mode: "onChange" })
  const onCreate = form.handleSubmit((values) => {
    setSession({ name: values.name, id: values.id })
    form.reset({ name: "", id: "" })
  })

  return (
    <div className="flex flex-col gap-5 p-4 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-[0.72rem] font-medium uppercase tracking-wider text-muted-foreground">Sessions</h2>
        <Button variant="ghost" size="icon-sm" aria-label="Refresh sessions" onClick={() => refresh()}>
          <RotateCwIcon />
        </Button>
      </div>

      <AsyncBoundary result={sessions} onRetry={() => refresh()}>
        {(value) =>
          value.sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No sessions yet.</p>
          ) : (
            <ScrollArea className="max-h-[42vh]">
              <ul className="flex flex-col gap-1 pr-2">
                {value.sessions.map((session) => {
                  const active = isActive(session)
                  return (
                    <li key={`${session.name}/${session.id}`}>
                      <button
                        type="button"
                        aria-current={active ? "true" : undefined}
                        onClick={() => setSession({ name: session.name, id: session.id })}
                        className={cn(
                          "flex w-full items-stretch gap-2 rounded-md border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "border-accent-line bg-accent-ghost"
                            : "border-transparent hover:bg-surface-2",
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "w-0.5 shrink-0 self-stretch rounded-full",
                            active ? "bg-primary" : "bg-transparent",
                          )}
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate font-mono text-[0.78rem]">
                            {session.name}/{session.id}
                          </span>
                          <span className="text-[0.7rem] text-muted-foreground tabular-nums">
                            {formatRelativeTime(session.lastActiveAt)}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </ScrollArea>
          )
        }
      </AsyncBoundary>

      <Form {...form}>
        <form className="flex flex-col gap-3 border-t border-border pt-4" onSubmit={onCreate}>
          <div className="grid grid-cols-2 gap-2">
            <FormField
              control={form.control}
              name="name"
              rules={{ validate: (value) => isSegment(value) || "Invalid name" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-mono text-[0.72rem] uppercase tracking-wider text-muted-foreground">
                    Name
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="support" className="font-mono text-xs" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="id"
              rules={{ validate: (value) => isSegment(value) || "Invalid id" }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-mono text-[0.72rem] uppercase tracking-wider text-muted-foreground">
                    Id
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="default" className="font-mono text-xs" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <FormDescription className="font-mono text-[0.7rem]">{SAFE_ID_HINT}</FormDescription>
          <Button type="submit" size="sm" disabled={!form.formState.isValid}>
            <PlusIcon />
            New session
          </Button>
        </form>
      </Form>

      <ModelCombobox />

      <SkillPicker />
    </div>
  )
}

/**
 * Free-entry model picker: `SUGGESTED_MODEL_IDS` render as suggestions, but the
 * search input is bound straight to `selectedModelAtom`, so any hand-typed id is
 * accepted. `""` means "use the session default".
 */
function ModelCombobox() {
  const model = useAtomValue(selectedModelAtom)
  const setModel = useAtomSet(selectedModelAtom)
  const [open, setOpen] = React.useState(false)

  return (
    <div className="grid gap-1.5">
      <span className="font-mono text-[0.72rem] uppercase tracking-wider text-muted-foreground">Model</span>
      <Button
        type="button"
        variant="outline"
        role="combobox"
        aria-expanded={open}
        className="w-full justify-between font-mono text-xs"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={cn("truncate", model === "" && "text-muted-foreground")}>
          {model === "" ? "session default" : model}
        </span>
        <ChevronsUpDownIcon className="opacity-50" />
      </Button>
      {open ? (
        <Command className="rounded-md border border-border bg-surface-2">
          <CommandInput
            value={model}
            onValueChange={setModel}
            placeholder="Search or type any model id"
          />
          <CommandList>
            <CommandEmpty>
              <span className="font-mono text-xs">Using “{model}”</span>
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={MODEL_DEFAULT}
                onSelect={() => {
                  setModel("")
                  setOpen(false)
                }}
              >
                <span className="text-muted-foreground">session default</span>
                <CheckIcon className={cn("ml-auto", model === "" ? "opacity-100" : "opacity-0")} />
              </CommandItem>
              {SUGGESTED_MODEL_IDS.map((id) => (
                <CommandItem
                  key={id}
                  value={id}
                  onSelect={() => {
                    setModel(id)
                    setOpen(false)
                  }}
                >
                  <span className="font-mono text-xs">{id}</span>
                  <CheckIcon className={cn("ml-auto", model === id ? "opacity-100" : "opacity-0")} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      ) : null}
    </div>
  )
}

/**
 * Skill-overlay picker over the R2 skills list. Selecting a skill writes its
 * name to `selectedSkillAtom`; the "No skill" option writes `""`.
 */
function SkillPicker() {
  const skills = useAtomValue(skillsListAtom)
  const skill = useAtomValue(selectedSkillAtom)
  const setSkill = useAtomSet(selectedSkillAtom)

  return (
    <div className="grid gap-1.5">
      <span className="font-mono text-[0.72rem] uppercase tracking-wider text-muted-foreground">Skill</span>
      <AsyncBoundary result={skills}>
        {(value) => (
          <Select
            value={skill === "" ? NO_SKILL : skill}
            onValueChange={(next) => setSkill(next === NO_SKILL ? "" : next)}
          >
            <SelectTrigger className="w-full font-mono text-xs">
              <SelectValue placeholder="No skill" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_SKILL}>No skill</SelectItem>
              {value.skills.map((entry) => (
                <SelectItem key={entry.name} value={entry.name}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </AsyncBoundary>
    </div>
  )
}
