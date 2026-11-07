import { atom, read, update } from 'claude-code'

import type { Checklist, Highlight, StepStatus } from '../types'

import { CALLOUT_COLOR } from './callouts'

// Two side panes, both display only: they cost no tokens, since nothing in
// them reaches Claude's context.
//   /highlights  every callout from this conversation, grouped by color in cards
//   /checklists  every checklist as a card with a progress bar; expand for the steps
//
// Never name a variable `h` in this file: JSX compiles to calls of the global `h`.

export const HIGHLIGHTS_PANE = 'rb-highlights'
export const CHECKLISTS_PANE = 'rb-checklists'

// Defined here as well as in register.tsx: the loader traces each read to an
// atom of the same file. Same plugin, key and shape, so the same value.
const checklists = atom({ plugin: 'rich-blocks', key: 'checklists' } as const, {}, { shape: 'checklists-2' })
const highlights = atom({ plugin: 'rich-blocks', key: 'highlights' } as const, [], { shape: 'highlights-1' })
const paneToggles = atom({ plugin: 'rich-blocks', key: 'paneToggles' } as const, {})

const CARD_BORDER = '#3f3f46'
const MUTED = '#a1a1aa'
const PREVIEW = 5

// A function declaration, not an arrow: the loader follows $ across files only
// into declarations.
function toggle($: any, id: string, fallback: boolean) {
  return update($, paneToggles, (all: Record<string, boolean>) => ({ ...all, [id]: !(all[id] ?? fallback) }))
}

// ---- /highlights ------------------------------------------------------------

const KINDS: { kind: Highlight['kind']; label: string; icon: string }[] = [
  { kind: 'imp', label: 'Important', icon: '●' },
  { kind: 'warn', label: 'Warnings', icon: '▲' },
  { kind: 'next', label: "Claude's next steps", icon: '➜' },
  { kind: 'ok', label: 'Done', icon: '✓' },
  { kind: 'tip', label: 'Tips', icon: '◆' },
]

const MARKERS = /\[\[(imp|warn|ok|tip|next):\s*([^\n]*?)\]\]/g

// Read every callout out of the conversation's assistant replies. Called when
// a turn ends; the newest 200 are kept.
export async function collectHighlights($: any) {
  const messages = (await $.session.messages()) as { role: string; text: string }[]
  const found: Highlight[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const match of message.text.matchAll(MARKERS)) {
      const text = match[2].replace(/\*\*|`/g, '').trim()
      if (text) found.push({ kind: match[1] as Highlight['kind'], text })
    }
  }
  await update($, highlights, () => found.slice(-200))
}

export async function drawHighlights($: any, e: any) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const list: Highlight[] = await read($, highlights)
  const toggles: Record<string, boolean> = await read($, paneToggles)
  if (list.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>No highlights yet</Text>
        <Text color={MUTED}>Colored lines in Claude's replies collect here, grouped by color.</Text>
      </Box>
    )
  }

  const groups = KINDS.map(k => ({ ...k, items: list.map((item, i) => ({ item, i })).filter(({ item }) => item.kind === k.kind).reverse() }))
    .filter(g => g.items.length > 0)

  return (
    <Box flexDirection="column" rowGap="md" paddingY="xs">
      <Text color={MUTED}>
        {list.length} highlights · newest first
      </Text>
      {groups.map(g => {
        const color = CALLOUT_COLOR[g.kind]
        const isOpen = toggles[`hl:${g.kind}`] ?? true
        const isAll = toggles[`hl-all:${g.kind}`] ?? false
        const shown = isAll ? g.items : g.items.slice(0, PREVIEW)
        return (
          <Box key={`hl-card-${g.kind}`} flexDirection="column" borderStyle="round" borderColor={CARD_BORDER} paddingX={1} paddingY="xs" rowGap="xs">
            <Box flexDirection="row" alignItems="center" justifyContent="space-between">
              <Button key={`hl-head-${g.kind}`} plain onPress={() => toggle($, `hl:${g.kind}`, true)}>
                <Text color={color} bold>
                  {g.icon} {g.label}
                </Text>{' '}
                <Text color={MUTED}>{g.items.length}</Text>
              </Button>
              <Button key={`hl-fold-${g.kind}`} plain dimColor label={isOpen ? '▾' : '▸'} onPress={() => toggle($, `hl:${g.kind}`, true)} />
            </Box>
            {isOpen &&
              shown.map(({ item, i }) => (
                <Box key={`hl-row-${i}`} flexDirection="row" alignItems="flex-start" columnGap={1}>
                  <Text color={color}>▎</Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text>{item.text}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Button
                      key={`hl-copy-${i}`}
                      plain
                      dimColor
                      label="copy"
                      onPress={async (press: any) => {
                        const copied = await $.ui.copy({ text: item.text, surface: press.surface })
                        $.ui.toast(copied.isCopied ? 'Copied ✓' : 'Could not copy')
                      }}
                    />
                  </Box>
                </Box>
              ))}
            {isOpen && g.items.length > PREVIEW && (
              <Button
                key={`hl-more-${g.kind}`}
                plain
                dimColor
                label={isAll ? 'Show fewer' : `Show all ${g.items.length}`}
                onPress={() => toggle($, `hl-all:${g.kind}`, false)}
              />
            )}
          </Box>
        )
      })}
    </Box>
  )
}

// ---- /checklists ------------------------------------------------------------

const LOOK: Record<StepStatus, { glyph: string; color: string; word: string }> = {
  done: { glyph: '✓', color: '#22c55e', word: 'done' },
  failed: { glyph: '✗', color: '#ef4444', word: 'failed' },
  skipped: { glyph: '–', color: '#eab308', word: 'skipped' },
  todo: { glyph: '○', color: '#52525b', word: 'to do' },
}

// A segmented progress bar: one rounded segment per step, in its status color.
function progressSvg(status: StepStatus[]) {
  const seg = 18
  const gap = 3
  const width = Math.max(1, status.length) * (seg + gap) - gap
  const rects = status
    .map((s, i) => `<rect x="${i * (seg + gap)}" y="0" width="${seg}" height="6" rx="3" fill="${LOOK[s].color}"/>`)
    .join('')
  return { source: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">${rects}</svg>`, width }
}

function drawCard($: any, els: any, id: string, list: Checklist, isOpen: boolean, isEarlier: boolean) {
  const { Box, Text, Button } = els
  const Svg = 'Svg' in els ? els.Svg : undefined
  const done = list.status.filter(s => s === 'done').length
  const failed = list.status.filter(s => s === 'failed').length
  const skipped = list.status.filter(s => s === 'skipped').length
  const finished = done + skipped === list.steps.length
  const accent = failed > 0 ? '#ef4444' : finished ? '#22c55e' : '#7aa2f7'
  const bar = progressSvg(list.steps.map((_, i) => list.status[i] ?? 'todo'))

  return (
    <Box key={`cl-card-${id}`} flexDirection="column" borderStyle="round" borderColor={isOpen ? accent : CARD_BORDER} paddingX={1} paddingY="xs" rowGap="xs">
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" columnGap={1}>
        <Box flexShrink={1}>
          <Text bold color={isEarlier ? MUTED : accent} wrap="truncate">
            {list.title}
          </Text>
        </Box>
        <Button key={`cl-toggle-${id}`} plain dimColor label={isOpen ? '▾ hide steps' : '▸ steps'} onPress={() => toggle($, `cl:${id}`, false)} />
      </Box>
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        {Svg ? (
          <Svg source={bar.source} alt={`${done} of ${list.steps.length} done`} width={bar.width} height={6} />
        ) : (
          <Text>
            {list.steps.map((_, i) => {
              const look = LOOK[list.status[i] ?? 'todo']
              return <Text color={look.color}>{look.glyph}</Text>
            })}
          </Text>
        )}
        <Text color={MUTED}>
          {done}/{list.steps.length} done
          {failed > 0 ? ` · ${failed} failed` : ''}
          {skipped > 0 ? ` · ${skipped} skipped` : ''}
        </Text>
      </Box>
      {isOpen && (
        <Box flexDirection="column" rowGap="xs" marginTop="xs">
          {list.steps.map((step, i) => {
            const s = list.status[i] ?? 'todo'
            const look = LOOK[s]
            const note = (s === 'failed' || s === 'skipped') && list.notes[i]?.trim()
            return (
              <Box key={`cl-step-${id}-${i}`} flexDirection="row" columnGap={1}>
                <Text color={look.color} bold>
                  {look.glyph}
                </Text>
                <Box flexDirection="column" flexShrink={1}>
                  <Text dimColor={s === 'done' || s === 'skipped'}>
                    {i + 1}. {step}
                  </Text>
                  {note && (
                    <Text color={look.color} italic>
                      {note}
                    </Text>
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}

export async function drawChecklists($: any, e: any) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const session = await $.session.id()
  const all: Record<string, Checklist> = await read($, checklists)
  const toggles: Record<string, boolean> = await read($, paneToggles)
  const entries = Object.entries(all).reverse()
  if (entries.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>No checklists yet</Text>
        <Text color={MUTED}>Steps Claude gives you to do appear here with their progress.</Text>
      </Box>
    )
  }
  const isUnfinished = (l: Checklist) => l.status.some(s => s === 'todo' || s === 'failed')
  const byOpenFirst = (a: [string, Checklist], b: [string, Checklist]) => Number(isUnfinished(b[1])) - Number(isUnfinished(a[1]))
  const current = entries.filter(([, l]) => l.session === session).sort(byOpenFirst)
  const earlier = entries.filter(([, l]) => l.session !== session).sort(byOpenFirst).slice(0, 30)
  const showEarlier = toggles['cl-earlier'] ?? current.length === 0

  const section = (label: string, count: number) => (
    <Text color={MUTED} bold>
      {label.toUpperCase()} <Text color={MUTED}>· {count}</Text>
    </Text>
  )

  return (
    <Box flexDirection="column" rowGap="sm" paddingY="xs">
      {current.length > 0 && section('This conversation', current.length)}
      {current.map(([id, list]) => drawCard($, els, id, list, toggles[`cl:${id}`] ?? false, false))}
      {earlier.length > 0 && (
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" marginTop={current.length > 0 ? 'sm' : 0}>
          {section('Earlier', earlier.length)}
          <Button key="cl-earlier" plain dimColor label={showEarlier ? '▾ hide' : '▸ show'} onPress={() => toggle($, 'cl-earlier', current.length === 0)} />
        </Box>
      )}
      {showEarlier && earlier.map(([id, list]) => drawCard($, els, id, list, toggles[`cl:${id}`] ?? false, true))}
    </Box>
  )
}
