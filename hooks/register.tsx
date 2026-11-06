import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Checklist, StepStatus } from '../types'

import { drawCallouts, hasCallouts } from './callouts'
import { sectionText } from './instructions'
import { CHECKLISTS_PANE, HIGHLIGHTS_PANE, collectHighlights, drawChecklists, drawHighlights } from './panels'

// The mod's session values. The loader traces each $.state reference to an
// atom written in the same file, so every file that reads a value defines its
// own atom of it (same plugin and key: the same value). Change a `shape` tag
// when that value's fields change: older stored values then read as initial.
const checklists = atom({ plugin: 'rich-blocks', key: 'checklists' } as const, {}, { shape: 'checklists-2' })
const suggestOpen = atom({ plugin: 'rich-blocks', key: 'suggestOpen' } as const, false)
const suggestSeen = atom({ plugin: 'rich-blocks', key: 'suggestSeen' } as const, '')
const copyTabs = atom({ plugin: 'rich-blocks', key: 'copyTabs' } as const, {})
const choices = atom({ plugin: 'rich-blocks', key: 'choices' } as const, {})

// rich-blocks 0.6: interactive blocks Claude draws in the chat.
//   copy_box  - a color-coded box with a Copy button, optionally with OS tabs
//   checklist - steps the person ticks off: Done / Failed / Skip
//   choice    - 2-4 options the person picks from; the pick is sent as a message
//
// The desktop app folds runs of tool calls into one "Used ... N times" line
// and does not unfold it on request, so the blocks are drawn by the ToolGroup
// hook, under that line. A call drawn as its own row gets one via ToolUse.
//
// Token budget: tool descriptions and the guide ride on every request, so
// they are short; progress reaches Claude as one compact line per checklist;
// tool results are a few words; panes and the band never reach the context.

const PLUGIN = 'rich-blocks'
const COPY_TOOL = `mcp__${PLUGIN}__copy_box`
const CHECK_TOOL = `mcp__${PLUGIN}__checklist`
const CHOICE_TOOL = `mcp__${PLUGIN}__choice`
const OUR_TOOLS = new Set([COPY_TOOL, CHECK_TOOL, CHOICE_TOOL])

type Tone = 'info' | 'warning' | 'success' | 'danger'
type Tab = { label: string; text: string; language?: string }
type CopyBoxInput = { tabs: Tab[]; title?: string; tone: Tone }
type ChecklistInput = { title: string; steps: string[] }
type ChoiceInput = { question: string; options: { label: string; detail?: string }[] }

const TONES: Record<Tone, string> = {
  info: '#3b82f6',
  warning: '#f59e0b',
  success: '#22c55e',
  danger: '#ef4444',
}

const STEP_LOOK: Record<StepStatus, { glyph: string; color: string }> = {
  todo: { glyph: '○', color: 'subtle' },
  done: { glyph: '✓', color: '#22c55e' },
  failed: { glyph: '✗', color: '#ef4444' },
  skipped: { glyph: '–', color: '#eab308' },
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

function readCopyBox(input: unknown): CopyBoxInput | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  const tabs: Tab[] = Array.isArray(raw.tabs)
    ? raw.tabs
        .map(t => (typeof t === 'object' && t !== null ? (t as Record<string, unknown>) : {}))
        .filter(t => str(t.text) && str(t.label))
        .map(t => ({ label: t.label as string, text: t.text as string, language: str(t.language) }))
    : []
  if (tabs.length === 0 && str(raw.text)) tabs.push({ label: '', text: raw.text as string, language: str(raw.language) })
  if (tabs.length === 0) return undefined
  const tone = raw.tone
  return {
    tabs,
    title: str(raw.title),
    tone: tone === 'warning' || tone === 'success' || tone === 'danger' ? tone : 'info',
  }
}

function readChecklist(input: unknown): ChecklistInput | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  if (!Array.isArray(raw.steps)) return undefined
  const steps = raw.steps.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
  if (steps.length === 0) return undefined
  return { title: str(raw.title) ?? 'Steps', steps }
}

function readChoice(input: unknown): ChoiceInput | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  if (!Array.isArray(raw.options)) return undefined
  const options = raw.options
    .map(o => (typeof o === 'string' ? { label: o } : typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : {}))
    .filter(o => str(o.label))
    .map(o => ({ label: o.label as string, detail: str(o.detail) }))
  if (options.length < 2) return undefined
  return { question: str(raw.question) ?? 'Pick one', options: options.slice(0, 6) }
}

// The progress line Claude reads: step numbers and marks only (the step texts
// are already in the context, in the checklist's own call), reasons kept.
const MARK: Record<StepStatus, string> = { done: '✓', failed: '✗', skipped: '–', todo: '○' }

function summary(list: Checklist): string {
  const marks = list.steps.map((_, i) => {
    const s = list.status[i] ?? 'todo'
    const note = (s === 'failed' || s === 'skipped') && list.notes[i]?.trim() ? `(${list.notes[i].trim()})` : ''
    return `${i + 1}${MARK[s]}${note}`
  })
  return `"${list.title}": ${marks.join(' ')}`
}

function emptyList(input: ChecklistInput): Checklist {
  return {
    title: input.title,
    steps: input.steps,
    status: input.steps.map((): StepStatus => 'todo'),
    notes: input.steps.map(() => ''),
    reported: '',
  }
}

// The steps the person marked Done in this session's checklists: what
// compaction keeps. These carry the step text: after compaction the
// checklist's own call is gone. Checklists from other sessions never count.
function completedSteps(lists: Record<string, Checklist>, session: string): string {
  return Object.values(lists)
    .filter(list => list.session === session)
    .map(list => ({ list, done: list.steps.filter((_, i) => list.status[i] === 'done') }))
    .filter(({ done }) => done.length > 0)
    .map(({ list, done }) => `- ${list.title}: ${done.map(step => `✓ ${step}`).join('; ')}`)
    .join('\n')
}

const KEEP_NOTE = (done: string) => 'Steps the user completed and confirmed (kept by rich-blocks across compaction):\n' + done

const COMPACT_GUIDE = (done: string) =>
  'rich-blocks: keep the completed steps below exactly; they were carried out and confirmed. Keep decisions ' +
  'and state the task still depends on. Drop what is spent: failed attempts later fixed, test runs and their ' +
  'output, checklist and UI chatter, superseded versions of files or plans.\n\n' + KEEP_NOTE(done)

// Checklist marks outlive the session: every change is mirrored to $.store
// (the newest 100 checklists), and a session starts by loading them back, so
// a resumed conversation shows its checklists as they were left.
const STORE_KEY = 'checklists-2'
const KEEP = 100

async function saveLists($: any) {
  const lists = await read($, checklists)
  await $.store.set(STORE_KEY, Object.fromEntries(Object.entries(lists).slice(-KEEP)))
}

async function loadLists($: any) {
  const stored = (await $.store.get(STORE_KEY)) as Record<string, Checklist> | undefined
  if (!stored || typeof stored !== 'object') return
  // The session's own values win over stored ones of the same checklist.
  await update($, checklists, (lists: Record<string, Checklist>) => ({ ...stored, ...lists }))
  // An old checklist's suggestion is not news: keep it out of a fresh session's band.
  if ((await read($, suggestSeen)) === '') {
    const merged = await read($, checklists)
    await update($, suggestSeen, () => suggestion(merged))
  }
}

// After compaction or a /clear handoff, mark every checklist as reported and
// its suggestion as seen, so nothing old is sent or shown again.
async function settleChecklists($: any) {
  const lists = await read($, checklists)
  await update($, checklists, (all: Record<string, Checklist>) =>
    Object.fromEntries(Object.entries(all).map(([id, list]) => [id, { ...list, reported: summary(list) }])),
  )
  await update($, suggestSeen, () => suggestion(lists))
  await update($, suggestOpen, () => false)
  await saveLists($)
}

// The checklist the suggestion is about: the newest one the person has marked.
function latestTouched(lists: Record<string, Checklist>): Checklist | undefined {
  return Object.values(lists).filter(list => list.status.some(s => s !== 'todo')).pop()
}

type SuggestRow = { kind: 'title' | 'done' | 'failed' | 'skipped' | 'todo' | 'why' | 'ask'; text: string }

// The suggested message, as rows the band colors and as the plain text that
// goes in the prompt box: grouped by outcome, reasons under each, then a request.
function suggestionRows(lists: Record<string, Checklist>): SuggestRow[] {
  const list = latestTouched(lists)
  if (!list) return []
  const group = (want: StepStatus) => list.steps.map((step, i) => ({ step, i })).filter(({ i }) => (list.status[i] ?? 'todo') === want)
  const rows: SuggestRow[] = [{ kind: 'title', text: `Where I am with "${list.title}":` }]
  const label: Record<StepStatus, string> = { done: '✓ Done', failed: '✗ Failed', skipped: '– Skipped', todo: '○ Not done yet' }
  for (const want of ['done', 'failed', 'skipped', 'todo'] as const) {
    for (const { step, i } of group(want)) {
      rows.push({ kind: want, text: `${label[want]}: ${i + 1}. ${step}` })
      const note = list.notes[i]?.trim()
      if (want === 'failed') rows.push({ kind: 'why', text: `Why: ${note || '(no details given)'}` })
      if (want === 'skipped' && note) rows.push({ kind: 'why', text: `Why: ${note}` })
    }
  }
  const anyFailed = list.status.includes('failed')
  const allDone = list.status.every(s => s === 'done' || s === 'skipped')
  rows.push({
    kind: 'ask',
    text: anyFailed
      ? 'Please help me fix the failed step(s) first, using the reasons above, then tell me how to continue.'
      : allDone
        ? 'Everything is done. What is next?'
        : 'Please continue from the first step that is not done yet.',
  })
  return rows
}

function suggestion(lists: Record<string, Checklist>): string {
  const rows = suggestionRows(lists)
  if (rows.length === 0) return ''
  return rows
    .map(row => (row.kind === 'title' ? `${row.text}\n` : row.kind === 'ask' ? `\n${row.text}` : row.kind === 'why' ? `   ${row.text}` : `- ${row.text}`))
    .join('\n')
}

const ROW_COLOR: Record<SuggestRow['kind'], string | undefined> = {
  title: '#d97757',
  done: '#22c55e',
  failed: '#ef4444',
  skipped: '#eab308',
  todo: undefined,
  why: '#efb154',
  ask: '#7aa2f7',
}

type Els = { Box: any; Text: any; Button: any; Code: any }

// One compact copy box. A short one-line text sits on one row with its title
// and the Copy button; anything longer gets a slim header row above the code.
// With tabs (one per OS or shell), the header holds the tab buttons and the
// box shows the picked tab; Copy copies that tab's text.
async function drawCopyBox($: any, els: Els, key: string, box: CopyBoxInput) {
  const { Box, Text, Button, Code } = els
  const color = TONES[box.tone]
  const picked = Math.min((await read($, copyTabs))[key] ?? 0, box.tabs.length - 1)
  const tab = box.tabs[picked]
  const hasTabs = box.tabs.length > 1
  const isShort = !hasTabs && !tab.text.includes('\n') && tab.text.length <= 60
  const copy = (
    <Button
      key={`copy-${key}`}
      onPress={async (press: any) => {
        const copied = await $.ui.copy({ text: tab.text, surface: press.surface })
        $.ui.toast(copied.isCopied ? 'Copied ✓' : `Could not copy (${copied.reason})`)
      }}
    >
      Copy
    </Button>
  )
  const title = box.title || !hasTabs ? (
    <Text color={color} bold>
      {box.title ?? 'Copy'}
    </Text>
  ) : null
  const tabs = hasTabs ? (
    <Box flexDirection="row" columnGap={1}>
      {box.tabs.map((t, n) => (
        <Button
          key={`tab-${key}-${n}`}
          plain
          dimColor={n !== picked}
          label={n === picked ? `▸ ${t.label}` : t.label}
          onPress={() => update($, copyTabs, (all: Record<string, number>) => ({ ...all, [key]: n }))}
        />
      ))}
    </Box>
  ) : null

  if (isShort) {
    return (
      <Box key={key} flexDirection="row" alignItems="center" gap="sm" borderStyle="round" borderColor={color} paddingX={1}>
        {title}
        <Box flexGrow={1}>
          <Code source={tab.text} language={tab.language} wrap="truncate-end" />
        </Box>
        {copy}
      </Box>
    )
  }
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          {title}
          {tabs}
        </Box>
        {copy}
      </Box>
      <Code source={tab.text} language={tab.language} />
    </Box>
  )
}

// A choice: the question, then one row per option with its tradeoff. A pick
// marks the option and sends just its label as the person's message.
async function drawChoice($: any, els: Els, key: string, choice: ChoiceInput) {
  const { Box, Text, Button } = els
  const picked: number | undefined = (await read($, choices))[key]
  const color = picked === undefined ? '#a78bfa' : '#22c55e'
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} paddingY="xs" rowGap="xs">
      <Text color={color} bold>
        {choice.question}
      </Text>
      {choice.options.map((option, n) => (
        <Box key={`${key}-opt-${n}`} flexDirection="row" alignItems="center" columnGap={2}>
          <Button
            key={`${key}-pick-${n}`}
            label={picked === n ? `✓ ${option.label}` : option.label}
            variant={picked === n ? 'primary' : undefined}
            dimColor={picked !== undefined && picked !== n}
            onPress={async () => {
              if (picked !== undefined) return
              await update($, choices, (all: Record<string, number>) => ({ ...all, [key]: n }))
              await $.prompt.submit({ text: option.label, asUser: true })
            }}
          />
          {option.detail && (
            <Box flexShrink={1}>
              <Text dimColor>{option.detail}</Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  )
}

// The desktop draws native buttons and ignores a label's text color, so the
// step pills are drawn by the surface: a rounded Svg with an invisible Client
// over it for the click (flat Client pills elsewhere, plain buttons last).
const BUTTONS: { status: StepStatus; label: string; color: string }[] = [
  { status: 'done', label: 'Done', color: '#22c55e' },
  { status: 'failed', label: 'Failed', color: '#ef4444' },
  { status: 'skipped', label: 'Skip', color: '#eab308' },
]

const REASON: Partial<Record<StepStatus, { label: string; placeholder: string }>> = {
  failed: { label: 'Why did it fail?', placeholder: 'e.g. the installer asked for admin rights' },
  skipped: { label: 'Why skip it?', placeholder: 'e.g. already done, or not needed on Windows' },
}

// What the person is typing in a reason field, kept out of $.state until they
// save: a state write redraws the checklist and takes the focus off the field.
const drafts = new Map<string, string>()
const draftKey = (key: string, i: number) => `${key}:${i}`

async function flushDrafts($: any) {
  if (drafts.size === 0) return
  const pending = [...drafts]
  drafts.clear()
  await update($, checklists, (lists: Record<string, Checklist>) => {
    const copy = { ...lists }
    for (const [id, text] of pending) {
      const cut = id.lastIndexOf(':')
      const key = id.slice(0, cut)
      const i = Number(id.slice(cut + 1))
      const list = copy[key]
      if (!list) continue
      const notes = [...list.notes]
      notes[i] = text
      copy[key] = { ...list, notes }
    }
    return copy
  })
  await saveLists($)
}

const CELL_PX = 8
const ROW_PX = 18
const OFF_BG = '#3a3a3f'

function pillSvg(label: string, fill: string, isOn: boolean, isDim: boolean) {
  const width = (label.length + 2) * CELL_PX
  const ink = isOn ? '#ffffff' : isDim ? '#8a8a93' : '#e4e4e7'
  const weight = isOn ? 700 : 500
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${ROW_PX}" viewBox="0 0 ${width} ${ROW_PX}">` +
    `<rect x="0" y="0" width="${width}" height="${ROW_PX}" rx="4" ry="4" fill="${fill}"/>` +
    `<text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" ` +
    `font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="12" font-weight="${weight}" fill="${ink}">${label}</text>` +
    `</svg>`
  return { source, width }
}

// A pill's Client key carries its checklist, step and status, so a click
// posted from it says exactly what was pressed.
const pillKey = (key: string, i: number, status: StepStatus) => `pill|${key}|${i}|${status}`

async function setStepOf($: any, key: string, i: number, next: StepStatus, input?: ChecklistInput) {
  await flushDrafts($)
  await update($, checklists, (lists: Record<string, Checklist>) => {
    const list = lists[key] ?? (input ? emptyList(input) : undefined)
    if (!list) return lists
    const status = [...list.status]
    status[i] = status[i] === next ? 'todo' : next
    return { ...lists, [key]: { ...list, status } }
  })
  await saveLists($)
}

async function drawChecklist($: any, els: Els & { Input: any; Client?: any; Svg?: any }, key: string, input: ChecklistInput) {
  const { Box, Text, Button, Input, Client, Svg } = els
  const all = await read($, checklists)
  const list = all[key] ?? emptyList(input)
  const status = list.status
  const done = status.filter(s => s === 'done').length
  const failed = status.filter(s => s === 'failed').length
  const settled = status.filter(s => s !== 'todo').length
  const color = failed > 0 ? '#f59e0b' : done === input.steps.length ? '#22c55e' : '#3b82f6'

  const setStep = (i: number, next: StepStatus) => setStepOf($, key, i, next, input)
  const saveNote = async (i: number, text: string) => {
    drafts.delete(draftKey(key, i))
    await update($, checklists, (lists: Record<string, Checklist>) => {
      const one = lists[key] ?? emptyList(input)
      const notes = [...one.notes]
      notes[i] = text
      return { ...lists, [key]: { ...one, notes } }
    })
    await saveLists($)
    $.ui.toast('Reason saved')
  }

  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} paddingY="xs" rowGap="sm">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text color={color} bold>☑ {input.title}</Text>
        <Text dimColor>
          {done}/{input.steps.length} done{failed > 0 ? ` · ${failed} failed` : ''}
          {settled === input.steps.length && failed === 0 ? ' · all set' : ''}
        </Text>
      </Box>
      {input.steps.map((step, i) => {
        const now = status[i] ?? 'todo'
        const look = STEP_LOOK[now]
        const isSettled = now === 'done' || now === 'skipped'
        return (
          <Box key={`${key}-step-${i}`} flexDirection="column" paddingY={0}>
            <Box flexDirection="row" alignItems="center" gap="sm">
              <Text color={look.color} bold>{look.glyph}</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text dimColor={isSettled} strikethrough={now === 'skipped'}>
                  {i + 1}. {step}
                </Text>
              </Box>
              <Box flexDirection="row" alignItems="center" columnGap={1} marginLeft="lg" flexShrink={0}>
                {BUTTONS.map(b => {
                  const isOn = now === b.status
                  const isDim = !isOn && now !== 'todo'
                  if (Client && Svg) {
                    const pill = pillSvg(b.label, isOn ? b.color : OFF_BG, isOn, isDim)
                    return (
                      <Box key={`${pillKey(key, i, b.status)}-slot`} position="relative" flexShrink={0}>
                        <Svg source={pill.source} alt={b.label} width={pill.width} height={ROW_PX} />
                        <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                          <Client
                            key={pillKey(key, i, b.status)}
                            module="./pill.tsx"
                            props={{ label: b.label, color: b.color, isOn, isDim, isGhost: true }}
                            flexGrow={1}
                          />
                        </Box>
                      </Box>
                    )
                  }
                  return Client ? (
                    <Client
                      key={pillKey(key, i, b.status)}
                      module="./pill.tsx"
                      props={{ label: b.label, color: b.color, isOn, isDim }}
                    />
                  ) : (
                    <Button
                      key={`${key}-${b.status}-${i}`}
                      label={b.label}
                      variant={isOn ? 'primary' : undefined}
                      dimColor={isDim}
                      onPress={() => setStep(i, b.status)}
                    />
                  )
                })}
              </Box>
            </Box>
            {REASON[now] && Input && (
              <Box flexDirection="row" marginLeft="lg" marginTop="xs" marginBottom="xs">
                <Input
                  key={`${key}-why-${i}`}
                  label={REASON[now]!.label}
                  placeholder={REASON[now]!.placeholder}
                  value={drafts.get(draftKey(key, i)) ?? list.notes[i] ?? ''}
                  submitLabel="save"
                  onInput={(text: string) => {
                    drafts.set(draftKey(key, i), text)
                  }}
                  onSubmit={(text: string) => saveNote(i, text)}
                />
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

async function drawBlock($: any, els: any, tool: string, key: string, input: unknown) {
  if (tool === COPY_TOOL) {
    const box = readCopyBox(input)
    return box ? drawCopyBox($, els, key, box) : undefined
  }
  if (tool === CHECK_TOOL) {
    const list = readChecklist(input)
    return list ? drawChecklist($, els, key, list) : undefined
  }
  const choice = readChoice(input)
  return choice ? drawChoice($, els, key, choice) : undefined
}

export const register: Register = (on, options) => {
  const responseStyle = typeof options.responseStyle === 'string' ? options.responseStyle : 'concise'

  // How to use the blocks, and the response style, added last to the system
  // prompt. It takes effect in a new conversation: one already running keeps
  // the prompt it started with (a change mid-thread would reset its cache).
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      ...composed,
      sections: [...composed.sections, { id: 'rich-blocks:guide', text: sectionText(responseStyle), scope: 'session' as const }],
    }
  })

  on('session.start', async ($, e, next) => {
    await loadLists($)
    // Descriptions stay minimal: they are sent with every request. When to use
    // each block is in the guide section, once.
    await $.tool.register({
      name: 'copy_box',
      description: 'Show text for the user to copy, in a box with a Copy button.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          title: { type: 'string' },
          language: { type: 'string' },
          tone: { type: 'string', enum: ['info', 'warning', 'success', 'danger'] },
          tabs: {
            type: 'array',
            description: 'Instead of text: one tab per OS or shell.',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, text: { type: 'string' }, language: { type: 'string' } },
              required: ['label', 'text'],
            },
          },
        },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'checklist',
      description: 'Show steps the user must do themselves, each with Done/Failed/Skip.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'choice',
      description: 'Ask the user to pick one of 2-4 options.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, detail: { type: 'string', description: 'One-line tradeoff.' } },
              required: ['label'],
            },
          },
        },
        required: ['question', 'options'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'highlights', description: "Show the colored lines from Claude's replies in a pane" })
    await $.command.register({ name: 'checklists', description: 'Show every checklist and its progress in a pane' })
    return next(e)
  })

  // Tool results are a few words: they stay in the context for the rest of the conversation.
  on('tool.call', { tool: COPY_TOOL }, async ($, e) =>
    readCopyBox(e) ? { result: 'Shown.' } : { deny: 'copy_box needs text or tabs.' },
  )

  on('tool.call', { tool: CHECK_TOOL }, async ($, e) => {
    const input = readChecklist(e)
    if (input === undefined) return { deny: 'checklist needs steps.' }
    const list: Checklist = { ...emptyList(input), session: await $.session.id() }
    list.reported = summary(list)
    await update($, checklists, (lists: Record<string, Checklist>) => ({ ...lists, [e.tool_use_id]: list }))
    await saveLists($)
    return { result: 'Shown. Progress comes with the next message.' }
  })

  on('tool.call', { tool: CHOICE_TOOL }, async ($, e) =>
    readChoice(e) ? { result: 'Shown. The pick comes as the next message.' } : { deny: 'choice needs 2+ options.' },
  )

  on('command.run', { command: 'highlights' }, async $ => {
    await collectHighlights($)
    await $.ui.open({ id: HIGHLIGHTS_PANE, title: 'Highlights' })
    return { text: 'Opened.' }
  })

  on('command.run', { command: 'checklists' }, async $ => {
    await $.ui.open({ id: CHECKLISTS_PANE, title: 'Checklists' })
    return { text: 'Opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: HIGHLIGHTS_PANE }, async ($, e) => drawHighlights($, e))
  on('ui.render', { component: 'Pane', requestId: CHECKLISTS_PANE }, async ($, e) => drawChecklists($, e))

  // Keep the highlights current: re-read the callouts when a main turn ends.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if ((e as { agentId?: string }).agentId === undefined) await collectHighlights($)
    return result
  })

  // A click on a colored pill or the suggestion header.
  on('ui.message', async ($, e, next) => {
    if (e.element === 'suggest-header') {
      const action = (e.data as { action?: unknown } | null)?.action
      if (action === 'toggle') await update($, suggestOpen, open => !open)
      if (action === 'dismiss') {
        const text = suggestion(await read($, checklists))
        await update($, suggestSeen, () => text)
      }
      return {}
    }
    const parts = e.element.split('|')
    if (parts[0] !== 'pill' || parts.length !== 4) return next(e)
    const [, key, index, status] = parts
    if (status !== 'done' && status !== 'failed' && status !== 'skipped') return next(e)
    await setStepOf($, key, Number(index), status)
    return {}
  })

  // Compaction: tell the summarizer to keep the completed steps and drop what
  // is spent, then add the completed steps back inside the compacted list.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e)
    await flushDrafts($)
    const done = completedSteps(await read($, checklists), await $.session.id())
    const guide = done === '' ? undefined : COMPACT_GUIDE(done)
    const result = await next(guide ? { ...e, instructions: e.instructions ? `${e.instructions}\n\n${guide}` : guide } : e)
    if (result.messages === undefined) return result
    await settleChecklists($)
    if (done === '') return result
    // A row appended while the compaction runs is wiped when the compacted
    // list is installed, so the note rides inside it.
    return { ...result, messages: [...result.messages, { role: 'user' as const, text: KEEP_NOTE(done), toolUses: [] }] }
  })

  // auto-handoff replaces compaction with a /clear: carry the completed steps
  // into the fresh conversation's first message (the store outlives the clear).
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await flushDrafts($)
      const done = completedSteps(await read($, checklists), e.sessionId)
      if (done !== '') await $.store.set('carry', { text: KEEP_NOTE(done), at: await $.clock.now() })
      await settleChecklists($)
    }
    return next(e)
  })

  // With each message the person sends, tell Claude about checklists that
  // changed: one compact line each. A message that is itself the suggested
  // reply already says it all, so then nothing is added.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) return next(e)
    const carried = (await $.store.get('carry')) as { text?: string; at?: number } | undefined
    if (carried?.text) {
      await $.store.delete('carry')
      // Only a clear from moments ago: never leak into an unrelated later session.
      if ((await $.clock.now()) - (carried.at ?? 0) < 10 * 60_000) {
        e = { ...e, context: [...(e.context ?? []), carried.text] }
      }
    }
    await flushDrafts($) // a reason typed but not saved still counts
    const lists = await read($, checklists)
    const suggested = suggestion(lists)
    await update($, suggestSeen, () => suggested)
    await update($, suggestOpen, () => false)
    // Only this conversation's checklists: saved ones from other sessions are
    // shown in their own transcripts, never reported here.
    const session = await $.session.id()
    const changed = Object.entries(lists).filter(([, list]) => list.session === session && summary(list) !== list.reported)
    if (changed.length === 0) return next(e)
    await update($, checklists, (all: Record<string, Checklist>) => {
      const copy = { ...all }
      for (const [id] of changed) if (copy[id]) copy[id] = { ...copy[id], reported: summary(copy[id]) }
      return copy
    })
    if (suggested !== '' && e.text.trim() === suggested.trim()) return next(e)
    const note = 'Checklist progress (rich-blocks):\n' + changed.map(([, list]) => summary(list)).join('\n')
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const calls = e.props.calls
      .map((call, i) => ({ call, key: call.tool_use_id ?? `call-${i}` }))
      .filter(({ call }) => OUR_TOOLS.has(call.tool) && !call.isErrored && !call.isInterrupted)
    if (calls.length === 0) return next(e)
    const els = $.ui.resolve(e)
    const group = await next(e)
    const blocks = []
    for (const { call, key } of calls) {
      const block = await drawBlock($, els, call.tool, key, call.input)
      if (block) blocks.push(block)
    }
    return (
      <els.Box flexDirection="column" gap="xs">
        {group}
        {blocks}
      </els.Box>
    )
  })

  for (const tool of OUR_TOOLS) {
    on('ui.render', { component: 'ToolUse', props: { tool } }, async ($, e, next) => {
      if (e.props.isErrored) return next(e)
      return (await drawBlock($, $.ui.resolve(e), tool, e.props.tool_use_id, e.props.input)) ?? next(e)
    })
  }

  // Above the prompt: a one-line suggestion that opens to show a message built
  // from the checklists, ready to put in the prompt box. It stacks on top of
  // whatever other mods draw in the band (Clawd's pet), never in their place.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const text = suggestion(await read($, checklists))
    if (text === '' || text === (await read($, suggestSeen))) return next(e)
    const isOpen = await read($, suggestOpen)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Client = 'Client' in els ? els.Client : undefined
    const dismiss = () => update($, suggestSeen, () => text)
    const below = await next(e)
    const stack = (mine: unknown) => (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom="sm" paddingTop="xs">
          {mine}
        </Box>
        {below}
      </Box>
    )

    const list = latestTouched(await read($, checklists))
    const steps = list?.steps.length ?? 0
    const count = (want: StepStatus) => list?.status.filter(s => s === want).length ?? 0
    const failed = count('failed')
    const word = failed > 0 ? `${failed} failed` : count('done') + count('skipped') === steps ? 'all set' : 'in progress'
    // Where the surface runs Client modules the header is one, so Clawd's
    // per-frame redraws of the band never drop its hover or a click.
    const header = Client ? (
      <Client
        key="suggest-header"
        module="./suggest-header.tsx"
        props={{ done: count('done'), steps, word, isFailed: failed > 0, isOpen }}
        width="100%"
      />
    ) : (
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Box flexShrink={1}>
          <Text wrap="truncate">
            <Text bold color="#d97757">Checklist</Text>
            <Text dimColor> {count('done')}/{steps} </Text>
            <Text color={failed > 0 ? '#ef4444' : '#efb154'}>{word}</Text>
            <Text dimColor> · </Text>
            <Text color="#7aa2f7">suggested reply</Text>
          </Text>
        </Box>
        <Button key="suggest-toggle" plain dimColor label={isOpen ? 'hide' : 'show'} onPress={() => update($, suggestOpen, () => !isOpen)} />
        <Button key="suggest-dismiss" plain dimColor label="✕" onPress={dismiss} />
      </Box>
    )

    if (!isOpen) return stack(header)

    const rows = suggestionRows(await read($, checklists))
    return stack(
      <Box flexDirection="column" rowGap="xs">
        {header}
        <Box flexDirection="column" paddingLeft={2}>
          {rows.map((row, n) => (
            <Box key={`suggest-row-${n}`} paddingLeft={row.kind === 'why' ? 2 : 0} marginTop={row.kind === 'ask' ? 'xs' : 0}>
              <Text color={ROW_COLOR[row.kind]} bold={row.kind === 'title'} dimColor={row.kind === 'todo'} italic={row.kind === 'why'}>
                {row.text}
              </Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="row" gap="md" paddingLeft={2}>
          <Button
            key="suggest-use"
            variant="primary"
            onPress={async press => {
              const filled = await $.prompt.fill({ text, mode: 'replace' })
              if (!filled.isFilled) {
                const copied = await $.ui.copy({ text, surface: press.surface })
                $.ui.toast(copied.isCopied ? 'Copied: paste it into the prompt box' : 'Could not fill or copy the suggestion')
              }
              await update($, suggestOpen, () => false)
            }}
          >
            Put in prompt
          </Button>
        </Box>
      </Box>
    )
  })

  // Colored callouts in Claude's own replies. Replies without a marker are left alone.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || !hasCallouts(e.props.text)) return next(e)
    return drawCallouts($.ui.resolve(e), e.props.text)
  })
}
