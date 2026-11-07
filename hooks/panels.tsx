import { atom, read, update } from 'claude-code'

import type { Checklist, Highlight, StepStatus } from '../types'

import { CALLOUT_COLOR } from './callouts'

// Defined here as well as in register.tsx: the loader traces each read to an
// atom of the same file. Same plugin, key and shape, so the same value.
const checklists = atom({ plugin: 'rich-blocks', key: 'checklists' } as const, {}, { shape: 'checklists-2' })
const highlights = atom({ plugin: 'rich-blocks', key: 'highlights' } as const, [], { shape: 'highlights-1' })

// Two side panes, both display only: they cost no tokens, since nothing in
// them reaches Claude's context.
//   /highlights  every callout from this conversation, grouped by color, each copyable
//   /checklists  every checklist with its progress, unfinished first

export const HIGHLIGHTS_PANE = 'rb-highlights'
export const CHECKLISTS_PANE = 'rb-checklists'

const KINDS: { kind: Highlight['kind']; label: string }[] = [
  { kind: 'imp', label: 'Important' },
  { kind: 'warn', label: 'Warnings' },
  { kind: 'next', label: "Claude's next steps" },
  { kind: 'ok', label: 'Done' },
  { kind: 'tip', label: 'Tips' },
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
  if (list.length === 0) {
    return <Text dimColor>No highlights yet. Colored lines in Claude's replies show up here.</Text>
  }
  return (
    <Box flexDirection="column" rowGap="sm">
      {KINDS.map(({ kind, label }) => {
        // Never name a variable `h`: JSX compiles to calls of the global `h`.
        const rows = list.map((item, i) => ({ item, i })).filter(({ item }) => item.kind === kind)
        if (rows.length === 0) return null
        return (
          <Box key={`hl-${kind}`} flexDirection="column">
            <Text bold color={CALLOUT_COLOR[kind]}>
              {label} <Text dimColor>{rows.length}</Text>
            </Text>
            {rows.reverse().map(({ item, i }) => (
              <Box key={`hl-${kind}-${i}`} flexDirection="row" alignItems="center" columnGap={1}>
                <Box flexGrow={1} flexShrink={1}>
                  <Text color={CALLOUT_COLOR[kind]}>{item.text}</Text>
                </Box>
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
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

const GLYPH: Record<StepStatus, { glyph: string; color: string }> = {
  done: { glyph: '✓', color: '#22c55e' },
  failed: { glyph: '✗', color: '#ef4444' },
  skipped: { glyph: '–', color: '#eab308' },
  todo: { glyph: '○', color: '#71717a' },
}

export async function drawChecklists($: any, e: any) {
  const { Box, Text } = $.ui.resolve(e)
  const session = await $.session.id()
  const all: Record<string, Checklist> = await read($, checklists)
  const isOpen = (l: Checklist) => l.status.some(s => s === 'todo' || s === 'failed')
  const lists = Object.values(all)
    .reverse()
    .sort((a, b) => Number(b.session === session) - Number(a.session === session) || Number(isOpen(b)) - Number(isOpen(a)))
    .slice(0, 30)
  if (lists.length === 0) return <Text dimColor>No checklists yet.</Text>

  return (
    <Box flexDirection="column" rowGap="sm">
      {lists.map((list, n) => {
        const done = list.status.filter(s => s === 'done').length
        const failed = list.status.filter(s => s === 'failed').length
        const color = failed > 0 ? '#ef4444' : done === list.steps.length ? '#22c55e' : '#7aa2f7'
        return (
          <Box key={`cl-${n}`} flexDirection="column">
            <Text wrap="truncate">
              <Text bold color={color}>{list.title}</Text>
              <Text dimColor>
                {'  '}
                {done}/{list.steps.length}
                {failed > 0 ? ` · ${failed} failed` : ''}
                {list.session === session ? '' : ' · earlier session'}
              </Text>
            </Text>
            <Text>
              {list.steps.map((_, i) => {
                const g = GLYPH[list.status[i] ?? 'todo']
                return <Text color={g.color}>{g.glyph} </Text>
              })}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
