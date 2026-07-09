import * as React from "react"
import { ApprovalCards } from "./components/ApprovalCards.tsx"
import { Chat } from "./components/Chat.tsx"
import { JournalTimeline } from "./components/JournalTimeline.tsx"
import { SessionSwitcher } from "./components/SessionSwitcher.tsx"
import { SkillsPanel } from "./components/SkillsPanel.tsx"
import { ToolsPanel } from "./components/ToolsPanel.tsx"
import styles from "./App.module.css"

/** Right-rail tab identity — local UI state, not derived from any schema. */
type RightTab = "journal" | "skills" | "tools"

interface TabDef {
  readonly id: RightTab
  readonly label: string
}

/** Right-rail tabs in display order; Journal is the default so turn costs are visible immediately. */
const RIGHT_TABS: ReadonlyArray<TabDef> = [
  { id: "journal", label: "Journal" },
  { id: "skills", label: "Skills" },
  { id: "tools", label: "Tools" },
]

/**
 * One-screen demo console. A session switcher and model picker fill the left
 * rail, the live chat with its approval cards sit in the center, and a tabbed
 * skills/tools/journal region fills the right rail. Every panel self-drives off
 * `currentSessionAtom`, so App renders them with no props and owns nothing but
 * the responsive layout and the right-rail tab selection.
 */
export function App() {
  const [tab, setTab] = React.useState<RightTab>("journal")

  return (
    <div className={styles.app}>
      <div className={styles.left}>
        <SessionSwitcher />
      </div>

      <div className={styles.center}>
        <Chat />
        <ApprovalCards />
      </div>

      <div className={styles.right}>
        <div className={styles.tabs} role="tablist">
          {RIGHT_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? `${styles.tab ?? ""} ${styles.tabActive ?? ""}` : styles.tab}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className={styles.panel}>
          {tab === "journal" ? <JournalTimeline /> : tab === "skills" ? <SkillsPanel /> : <ToolsPanel />}
        </div>
      </div>
    </div>
  )
}
