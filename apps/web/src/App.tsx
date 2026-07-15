import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { AppShell } from "./components/AppShell.tsx"
import { ApprovalCards } from "./components/ApprovalCards.tsx"
import { Chat } from "./components/Chat.tsx"
import { JournalTimeline } from "./components/JournalTimeline.tsx"
import { ScheduledFeaturesPanel } from "./components/ScheduledFeaturesPanel.tsx"
import { SessionSwitcher } from "./components/SessionSwitcher.tsx"
import { SkillsPanel } from "./components/SkillsPanel.tsx"
import { ToolsPanel } from "./components/ToolsPanel.tsx"

/**
 * The one-screen Efflux console. `AppShell` owns the TopBar (wordmark + theme toggle)
 * and the responsive three-column frame; App only wires the propless panels into its
 * slots. The sessions rail holds the switcher, the main column stacks the approval
 * cards above a growing `Chat` (which owns its own transcript scroll and pinned
 * composer), the inspector rail carries a Journal/Tools tabset, and skills plus
 * scheduled features live in the TopBar actions. Every panel self-drives off
 * `currentSessionAtom`.
 */
export function App() {
  return (
    <AppShell
      topBarActions={
        <>
          <SkillsPanel />
          <ScheduledFeaturesPanel />
        </>
      }
      sessions={<SessionSwitcher />}
      main={
        <>
          <ApprovalCards />
          <Chat />
        </>
      }
      inspector={
        <Tabs defaultValue="journal" className="p-3">
          <TabsList className="w-full">
            <TabsTrigger value="journal">Journal</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
          </TabsList>
          <TabsContent value="journal">
            <JournalTimeline />
          </TabsContent>
          <TabsContent value="tools">
            <ToolsPanel />
          </TabsContent>
        </Tabs>
      }
    />
  )
}
