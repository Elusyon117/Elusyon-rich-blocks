import type { ClientModule } from 'claude-code'

// The suggestion band's header line, drawn by the surface itself. Clawd's band
// redraws on every animation frame; a native Button rebuilt that often loses
// its hover. A Client keeps its own state across redraws, so the hover and the
// click stay steady. Clicking "show"/"hide" (or the title) posts `toggle`;
// clicking ✕ posts `dismiss`.

type HeaderProps = { done: number; steps: number; word: string; isFailed: boolean; isOpen: boolean }
type HeaderState = { hover: 'toggle' | 'dismiss' | null }

const TITLE = 'Checklist'
const DISMISS = '✕'

const Header: ClientModule<HeaderProps, HeaderState> = (props, surface) => {
  const action = props.isOpen ? 'hide' : 'show'
  const lead = `${TITLE} ${props.done}/${props.steps} ${props.word} · suggested reply `
  // Columns: the lead and the toggle word are one target at the left; ✕ sits
  // alone at the far right edge, so it is hard to hit by accident.
  const toggleEnd = lead.length + action.length
  const targetAt = (x: number): HeaderState['hover'] =>
    x < toggleEnd ? 'toggle' : surface.columns > 0 && x >= surface.columns - 2 ? 'dismiss' : null

  if (surface.state === undefined) {
    surface.onPointer(event => {
      const now = surface.state ?? { hover: null }
      if (event.type === 'leave') {
        if (now.hover !== null) surface.setState({ hover: null })
        return
      }
      const target = targetAt(event.x)
      if (event.type === 'move' && target !== now.hover) surface.setState({ hover: target })
      if (event.type === 'up' && event.button !== 'right' && target !== null) surface.post({ action: target })
    })
    surface.setState({ hover: null })
  }
  const hover = surface.state?.hover ?? null
  const { Box, Text } = surface.elements

  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Text wrap="truncate">
        <Text bold color="#d97757">{TITLE}</Text>
        <Text dimColor> {props.done}/{props.steps} </Text>
        <Text color={props.isFailed ? '#ef4444' : '#efb154'}>{props.word}</Text>
        <Text dimColor> · </Text>
        <Text color="#7aa2f7">suggested reply </Text>
        <Text color={hover === 'toggle' ? '#ffffff' : '#7aa2f7'} bold={hover === 'toggle'} underline>
          {action}
        </Text>
      </Text>
      <Text color={hover === 'dismiss' ? '#ffffff' : undefined} dimColor={hover !== 'dismiss'}>
        {DISMISS}
      </Text>
    </Box>
  )
}

export default Header
