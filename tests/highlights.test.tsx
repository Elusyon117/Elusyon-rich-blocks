import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'rich-blocks',
  component: 'Pane',
  requestId: 'rb-highlights',
  props: {
    title: 'Highlights',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the highlights pane lists callouts by color', async ($, on) => {
  on('state.get', (_, e: any) =>
    e.key === 'highlights'
      ? {
          value: {
            value: {
              shape: 'highlights-1',
              value: [
                { kind: 'imp', text: 'the key point' },
                { kind: 'warn', text: 'a risk' },
                { kind: 'next', text: 'what Claude does next' },
              ],
            },
            version: 1,
          },
        }
      : { value: { value: undefined, version: 0 } },
  )

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = await ui.find({ type: 'Text', text: /the key point/ })
    expect(row?.text).toBe('the key point')
    await ui.unmount()
  }
})
