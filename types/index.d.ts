export type StepStatus = 'todo' | 'done' | 'failed' | 'skipped'

/** One checklist Claude showed, keyed by its tool_use_id. */
export type Checklist = {
  title: string
  steps: string[]
  status: StepStatus[]
  /** Why a step failed or was skipped, as the person typed it; '' for none. */
  notes: string[]
  /** The status text last sent to Claude, so only changes are reported. */
  reported: string
  /** The session that showed it; only its own checklists count at compaction. */
  session?: string
}

/** One colored callout from Claude's replies, for the highlights pane. */
export type Highlight = { kind: 'imp' | 'warn' | 'ok' | 'tip' | 'next'; text: string }

declare module 'claude-code' {
  interface PluginState {
    'rich-blocks': {
      checklists: Shaped<Record<string, Checklist>>
      /** Whether the suggestion above the prompt is opened. */
      suggestOpen: boolean
      /** The suggestion last sent or dismissed; the band hides while it matches. */
      suggestSeen: string
      /** Callouts collected from this conversation, newest last. */
      highlights: Shaped<Highlight[]>
      /** The tab picked in each tabbed copy box, by tool_use_id. */
      copyTabs: Record<string, number>
      /** The option picked in each choice block, by tool_use_id. */
      choices: Record<string, number>
    }
  }
}
