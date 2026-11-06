// Callouts: colored text inside Claude's replies, no boxes. Claude wraps an
// important part in a marker, and the reply is drawn with that part colored:
//
//   [[imp: ...]]   orange, bold   the key point, the thing to remember
//   [[warn: ...]]  yellow, bold   a risk, a caveat, something that can break
//   [[ok: ...]]    green, bold    done, verified, working
//   [[tip: ...]]   blue, bold     a suggestion, a shortcut
//   [[next: ...]]  purple, bold   what Claude will do next
//
// Only the drawing changes: the stored reply keeps the markers. Paragraphs
// without a marker are drawn as ordinary markdown; a paragraph with one is
// drawn line by line as colored text runs (bold and `code` kept, list bullets
// and headings kept).

export type CalloutKind = 'imp' | 'warn' | 'ok' | 'tip' | 'next'

export const CALLOUT_COLOR: Record<CalloutKind, string> = {
  imp: '#f97316',
  warn: '#eab308',
  ok: '#22c55e',
  tip: '#60a5fa',
  next: '#a78bfa',
}

const MARKER = /\[\[(imp|warn|ok|tip|next):\s*([\s\S]*?)\]\]/
const TOKENS = /\[\[(imp|warn|ok|tip|next):\s*([\s\S]*?)\]\]|\*\*([^*]+)\*\*|`([^`]+)`/g

export function hasCallouts(text: string): boolean {
  return MARKER.test(text)
}

type Run = { text: string; kind?: CalloutKind; isBold?: boolean; isCode?: boolean }

function runsOf(line: string): Run[] {
  const runs: Run[] = []
  let at = 0
  for (const match of line.matchAll(TOKENS)) {
    const start = match.index ?? 0
    if (start > at) runs.push({ text: line.slice(at, start) })
    if (match[1]) runs.push({ text: match[2].replace(/\*\*|`/g, ''), kind: match[1] as CalloutKind })
    else if (match[3]) runs.push({ text: match[3], isBold: true })
    else if (match[4]) runs.push({ text: match[4], isCode: true })
    at = start + match[0].length
  }
  if (at < line.length) runs.push({ text: line.slice(at) })
  return runs
}

// Paragraphs split on blank lines, never inside a code fence.
function paragraphsOf(text: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) inFence = !inFence
    if (!inFence && line.trim() === '') {
      if (current.length) out.push(current.join('\n'))
      current = []
    } else current.push(line)
  }
  if (current.length) out.push(current.join('\n'))
  return out
}

function drawLine(els: any, line: string, n: number) {
  const { Box, Text } = els
  const indent = line.match(/^\s*/)?.[0].length ?? 0
  let body = line.trim()
  let lead = ''
  let isHeading = false
  const bullet = body.match(/^[-*+]\s+/)
  const numbered = body.match(/^(\d+)[.)]\s+/)
  const heading = body.match(/^#{1,6}\s+/)
  const quote = body.match(/^>\s?/)
  if (bullet) {
    lead = '• '
    body = body.slice(bullet[0].length)
  } else if (numbered) {
    lead = `${numbered[1]}. `
    body = body.slice(numbered[0].length)
  } else if (heading) {
    isHeading = true
    body = body.slice(heading[0].length)
  } else if (quote) {
    lead = '│ '
    body = body.slice(quote[0].length)
  }

  return (
    <Box key={`callout-line-${n}`} flexDirection="row" paddingLeft={Math.floor(indent / 2) * 2}>
      {lead !== '' && <Text dimColor={!!quote}>{lead}</Text>}
      <Box flexShrink={1}>
        <Text bold={isHeading}>
          {runsOf(body).map(run =>
            run.kind ? (
              <Text color={CALLOUT_COLOR[run.kind]} bold>
                {run.text}
              </Text>
            ) : run.isCode ? (
              <Text color="#e4a0c8">{run.text}</Text>
            ) : run.isBold ? (
              <Text bold>{run.text}</Text>
            ) : (
              run.text
            ),
          )}
        </Text>
      </Box>
    </Box>
  )
}

export function drawCallouts(els: any, text: string) {
  const { Box, Markdown } = els
  return (
    <Box flexDirection="column" rowGap="sm">
      {paragraphsOf(text).map((para, p) =>
        hasCallouts(para) ? (
          <Box key={`callout-para-${p}`} flexDirection="column">
            {para.split('\n').map((line, n) => drawLine(els, line, p * 1000 + n))}
          </Box>
        ) : (
          <Markdown key={`callout-md-${p}`} text={para} />
        ),
      )}
    </Box>
  )
}
