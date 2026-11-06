import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Checklist, StepStatus } from '../types'

import { drawCallouts, hasCallouts } from './callouts'
import { sectionText } from './instructions'

// rich-blocks: interactive blocks Claude draws in the chat.
//   copy_box  - a color-coded box with a Copy button
//   checklist - steps the person ticks off: Done / Failed / Skip
//
// The desktop app folds runs of tool calls into one "Used ... N times" line
// and does not unfold it on request, so the blocks are drawn by the ToolGroup
// hook, under that line. A call drawn as its own row gets one via ToolUse.

const PLUGIN = 'rich-blocks'
const COPY_TOOL = `mcp__${PLUGIN}__copy_box`
const CHECK_TOOL = `mcp__${PLUGIN}__checklist`

// Change the tag when Checklist's fields change: older stored values then read as {}.
const checklists = atom({ plugin: 'rich-blocks', key: 'checklists' } as const, {}, { shape: 'checklists-2' })
const suggestOpen = atom({ plugin: 'rich-blocks', key: 'suggestOpen' } as const, false)
const suggestSeen = atom({ plugin: 'rich-blocks', key: 'suggestSeen' } as const, '')

type Tone = 'info' | 'warning' | 'success' | 'danger'
type CopyBoxInput = { text: string; title?: string; language?: string; tone: Tone }
type ChecklistInput = { title: string; steps: string[] }

const TONES: Record<Tone, { color: string; icon: string }> = {
  info: { color: '#3b82f6', icon: 'ℹ' },
  warning: { color: '#f59e0b', icon: '⚠' },
  success: { color: '#22c55e', icon: '✓' },
  danger: { color: '#ef4444', icon: '✖' },
}

const STEP_LOOK: Record<StepStatus, { glyph: string; color: string }> = {
  todo: { glyph: '○', color: 'subtle' },
  done: { glyph: '✓', color: '#22c55e' },
  failed: { glyph: '✗', color: '#ef4444' },
  skipped: { glyph: '–', color: '#eab308' },
}

function readCopyBox(input: unknown): CopyBoxInput | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  if (typeof raw.text !== 'string') return undefined
  const tone = raw.tone
  return {
    text: raw.text,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    language: typeof raw.language === 'string' ? raw.language : undefined,
    tone: tone === 'warning' || tone === 'success' || tone === 'danger' ? tone : 'info',
  }
}

function readChecklist(input: unknown): ChecklistInput | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const raw = input as Record<string, unknown>
  if (!Array.isArray(raw.steps)) return undefined
  const steps = raw.steps.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
  if (steps.length === 0) return undefined
  return { title: typeof raw.title === 'string' ? raw.title : 'Steps', steps }
}

function summary(list: Checklist): string {
  const lines = list.steps.map((step, i) => {
    const hasReason = list.status[i] === 'failed' || list.status[i] === 'skipped'
    const note = hasReason && list.notes[i]?.trim() ? ` (reason: ${list.notes[i].trim()})` : ''
    return `${i + 1}. [${list.status[i] ?? 'todo'}] ${step}${note}`
  })
  return `Checklist "${list.title}":\n${lines.join('\n')}`
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
// compaction keeps. Checklists loaded from other sessions never count.
function completedSteps(lists: Record<string, Checklist>, session: string): string {
  const parts = Object.values(lists)
    .filter(list => list.session === session)
    .map(list => ({ list, done: list.steps.filter((_, i) => list.status[i] === 'done') }))
    .filter(({ done }) => done.length > 0)
    .map(({ list, done }) => `- ${list.title}:\n${done.map(step => `  - ✓ ${step}`).join('\n')}`)
  return parts.join('\n')
}

const KEEP_NOTE = (done: string) =>
  'Steps the user completed and confirmed (kept by rich-blocks across compaction):\n' + done

const COMPACT_GUIDE = (done: string) =>
  'rich-blocks: keep the completed steps below exactly as listed; they were carried out and confirmed. ' +
  'Keep decisions and current state the task still depends on. Drop what is spent: failed or abandoned ' +
  'attempts that were later fixed, test runs and their output, checklist and UI chatter, and superseded ' +
  'versions of files or plans.\n\n' + KEEP_NOTE(done)

// After compaction or a /clear handoff, mark every checklist as reported and
// its suggestion as seen, so nothing old is sent or shown again.
// Checklist marks outlive the session: every change is mirrored to $.store
// (the newest 100 checklists), and a session starts by loading them back, so
// a resumed conversation shows its checklists as they were left.
const STORE_KEY = 'checklists-2'
const KEEP = 100

async function saveLists($: any) {
  const lists = await read($, checklists)
  const kept = Object.fromEntries(Object.entries(lists).slice(-KEEP))
  await $.store.set(STORE_KEY, kept)
}

async function loadLists($: any) {
  const stored = (await $.store.get(STORE_KEY)) as Record<string, Checklist> | undefined
  if (!stored || typeof stored !== 'object') return
  // The session's own values win over stored ones of the same checklist.
  await update($, checklists, (lists: Record<string, Checklist>) => ({ ...stored, ...lists }))
  // An old checklist's suggestion is not news: keep it out of a fresh session's band.
  const merged = await read($, checklists)
  const current = await read($, suggestSeen)
  if (current === '') await update($, suggestSeen, () => suggestion(merged))
}

async function settleChecklists($: any) {
  const lists = await read($, checklists)
  await update($, checklists, (all: Record<string, Checklist>) => {
    const copy: Record<string, Checklist> = {}
    for (const [id, list] of Object.entries(all)) copy[id] = { ...list, reported: summary(list) }
    return copy
  })
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
function drawCopyBox($: any, els: Els, key: string, box: CopyBoxInput) {
  const { Box, Text, Button, Code } = els
  const tone = TONES[box.tone]
  const isShort = !box.text.includes('\n') && box.text.length <= 60
  const copy = (
    <Button
      key={`copy-${key}`}
      onPress={async (press: any) => {
        const copied = await $.ui.copy({ text: box.text, surface: press.surface })
        $.ui.toast(copied.isCopied ? 'Copied ✓' : `Could not copy (${copied.reason})`)
      }}
    >
      Copy
    </Button>
  )
  const title = (
    <Text color={tone.color} bold>
      {box.title ?? 'Copy'}
    </Text>
  )

  if (isShort) {
    return (
      <Box key={key} flexDirection="row" alignItems="center" gap="sm" borderStyle="round" borderColor={tone.color} paddingX={1}>
        {title}
        <Box flexGrow={1}>
          <Code source={box.text} language={box.language} wrap="truncate-end" />
        </Box>
        {copy}
      </Box>
    )
  }
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={tone.color} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        {title}
        {copy}
      </Box>
      <Code source={box.text} language={box.language} />
    </Box>
  )
}

// The desktop draws native buttons and ignores a label's text color, so the
// pressed one gets a thin outline in its color that hugs the button. Labels
// never change and unpressed slots keep a clear outline, so nothing shifts.
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

// A checklist: a header with progress, then one row per step with its status
// and three buttons, the pressed one in its own color. Pressing the status a
// step already has sets it back to todo. A failed step opens a line for why.
// The desktop's rounded pill: an Svg of a rounded rectangle with the label,
// the same size as the flat one-row pill (label plus a cell either side).
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

  const edit = (fn: (list: Checklist) => Checklist) =>
    update($, checklists, (lists: Record<string, Checklist>) => ({ ...lists, [key]: fn(lists[key] ?? emptyList(input)) }))
  const setStep = (i: number, next: StepStatus) => setStepOf($, key, i, next, input)
  const saveNote = async (i: number, text: string) => {
    drafts.delete(draftKey(key, i))
    await edit(list => {
      const notes = [...list.notes]
      notes[i] = text
      return { ...list, notes }
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
                  // The desktop: a rounded Svg pill with an invisible Client over it for the click.
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
                  // Colored flat pills where the surface runs Client modules; plain buttons elsewhere.
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
    await $.tool.register({
      name: 'copy_box',
      description:
        'Show the user text they need to copy and paste (a command, config, snippet, message) ' +
        'in a color-coded box with a Copy button, drawn in the chat. Use this instead of a ' +
        'plain code block whenever the user has to copy something. tone: info (default), ' +
        'warning, success or danger.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The exact text to copy.' },
          title: { type: 'string', description: 'Short label, e.g. "Run in PowerShell".' },
          language: { type: 'string', description: 'Highlighter language, e.g. powershell, bash, json.' },
          tone: { type: 'string', enum: ['info', 'warning', 'success', 'danger'] },
        },
        required: ['text'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'checklist',
      description:
        'Show the user an interactive checklist in the chat for steps THEY must do themselves ' +
        '(install something, click through a UI, change a setting). Each step gets Done / Failed / ' +
        'Skip buttons. Use this instead of a numbered list of manual steps. Keep each step one short ' +
        'sentence. The user\'s progress is sent back to you with their next message.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name for the task, e.g. "Install the Claude CLI".' },
          steps: { type: 'array', items: { type: 'string' }, description: 'The steps, in order.' },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: COPY_TOOL }, async () => ({
    result: 'Shown to the user in a copy box with a Copy button.',
  }))

  on('tool.call', { tool: CHECK_TOOL }, async ($, e) => {
    const input = readChecklist(e)
    if (input === undefined) return { deny: 'checklist needs a non-empty "steps" array of strings.' }
    const list: Checklist = { ...emptyList(input), session: await $.session.id() }
    list.reported = summary(list)
    await update($, checklists, (lists: Record<string, Checklist>) => ({ ...lists, [e.tool_use_id]: list }))
    await saveLists($)
    return {
      result:
        `Shown to the user as an interactive checklist (${input.steps.length} steps, all todo). ` +
        'Their progress arrives with their next message.',
    }
  })

  // A click on a colored pill: its key says which checklist, step and status.
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
  // is spent, then add the completed steps back as one short row after it.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e)
    await flushDrafts($)
    const done = completedSteps(await read($, checklists), await $.session.id())
    const guide = done === '' ? undefined : COMPACT_GUIDE(done)
    const result = await next(guide ? { ...e, instructions: e.instructions ? `${e.instructions}\n\n${guide}` : guide } : e)
    if (result.messages === undefined) return result
    await settleChecklists($)
    if (done === '') return result
    // The note rides in the compacted conversation itself: a row appended while
    // the compaction runs is wiped when the compacted list is installed.
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

  // With each message the person sends, tell Claude about checklists that changed.
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
    // Whatever the person sends, the current suggestion has been dealt with.
    await update($, suggestSeen, () => suggestion(lists))
    await update($, suggestOpen, () => false)
    const changed = Object.entries(lists).filter(([, list]) => summary(list) !== list.reported)
    if (changed.length === 0) return next(e)
    await update($, checklists, (all: Record<string, Checklist>) => {
      const copy = { ...all }
      for (const [id] of changed) if (copy[id]) copy[id] = { ...copy[id], reported: summary(copy[id]) }
      return copy
    })
    const note =
      'Checklist progress the user marked (rich-blocks):\n\n' + changed.map(([, list]) => summary(list)).join('\n\n')
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const calls = e.props.calls
      .map((call, i) => ({ call, key: call.tool_use_id ?? `call-${i}` }))
      .filter(({ call }) => (call.tool === COPY_TOOL || call.tool === CHECK_TOOL) && !call.isErrored && !call.isInterrupted)
    if (calls.length === 0) return next(e)
    const els = $.ui.resolve(e)
    const group = await next(e)
    const blocks = []
    for (const { call, key } of calls) {
      if (call.tool === COPY_TOOL) {
        const box = readCopyBox(call.input)
        if (box) blocks.push(drawCopyBox($, els, key, box))
      } else {
        const list = readChecklist(call.input)
        if (list) blocks.push(await drawChecklist($, els, key, list))
      }
    }

    return (
      <els.Box flexDirection="column" gap="xs">
        {group}
        {blocks}
      </els.Box>
    )
  })

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
    // Its own block with room below, so it never runs into the next band (Clawd's).
    const stack = (mine: unknown) => (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom="sm" paddingTop="xs">
          {mine}
        </Box>
        {below}
      </Box>
    )

    // Clawd's look: plain colored text runs on one line (the desktop draws a
    // Button's label in its own colors, so the header is Text, not a Button).
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

    // Opened: every row drawn whole, colored by outcome, so a long suggestion
    // reads top to bottom with nothing to scroll.
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
                // The desktop may draw its own prompt box that a mod cannot fill.
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

  // Colored callouts in Claude's own replies: [[imp: ...]], [[warn: ...]],
  // [[ok: ...]], [[tip: ...]]. Replies without a marker are left alone.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary || !hasCallouts(e.props.text)) return next(e)
    return drawCallouts($.ui.resolve(e), e.props.text)
  })

  on('ui.render', { component: 'ToolUse', props: { tool: COPY_TOOL } }, async ($, e, next) => {
    const box = readCopyBox(e.props.input)
    if (box === undefined || e.props.isErrored) return next(e)
    return drawCopyBox($, $.ui.resolve(e), e.props.tool_use_id, box)
  })

  on('ui.render', { component: 'ToolUse', props: { tool: CHECK_TOOL } }, async ($, e, next) => {
    const list = readChecklist(e.props.input)
    if (list === undefined || e.props.isErrored) return next(e)
    return drawChecklist($, $.ui.resolve(e), e.props.tool_use_id, list)
  })
}
