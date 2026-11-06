import type { ClientModule } from 'claude-code'

// A small pressable pill drawn by the surface itself, so its background can
// take a color (a native Button's cannot). A click posts to the hooks module,
// which reads the Client's key to know which step and status it was.
//
// With `isGhost` it draws nothing visible: on the desktop it lies over a
// rounded Svg pill and only catches the click.

type PillProps = { label: string; color: string; isOn: boolean; isDim: boolean; isGhost?: boolean }

const OFF_BG = '#3a3a3f'

const Pill: ClientModule<PillProps, true> = (props, surface) => {
  if (surface.state === undefined) {
    surface.onPointer(event => {
      if (event.type === 'up' && event.button !== 'right') surface.post({ press: true })
    })
    surface.setState(true)
  }
  const { Box, Text } = surface.elements

  if (props.isGhost) {
    return (
      <Box paddingX={1}>
        <Text>{' '.repeat(props.label.length)}</Text>
      </Box>
    )
  }
  return (
    <Box backgroundColor={props.isOn ? props.color : OFF_BG} paddingX={1}>
      <Text color={props.isOn ? '#ffffff' : undefined} bold={props.isOn} dimColor={props.isDim}>
        {props.label}
      </Text>
    </Box>
  )
}

export default Pill
