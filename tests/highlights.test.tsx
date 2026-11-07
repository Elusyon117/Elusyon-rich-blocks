import { expect, test } from 'claude-code/testing'

const pane = (requestId: string, title: string) =>
  ({
    plugin: 'rich-blocks',
    component: 'Pane',
    requestId,
    props: {
      title,
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

// Answers the pane's state reads as the engine would, from these values.
function seed(on: any, values: Record<string, unknown>) {
  on('state.get', (_: unknown, e: any) => ({
    value: e.key in values ? { value: values[e.key], version: 1 } : { value: undefined, version: 0 },
  }))
  on('session.id', () => ({ value: 'session-now' }))
}

test('the highlights pane groups callouts into cards, newest first', async ($, on) => {
  seed(on, {
    highlights: {
      shape: 'highlights-1',
      value: [
        { kind: 'imp', text: 'the key point' },
        { kind: 'warn', text: 'a risk' },
        { kind: 'imp', text: 'a newer key point' },
      ],
    },
  })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...pane('rb-highlights', 'Highlights'), surface })
    expect((await ui.find({ type: 'Text', text: /the key point/ }))?.text).toBe('the key point')
    expect((await ui.find({ type: 'Text', text: /3 highlights/ }))?.text).toContain('3 highlights')
    await ui.unmount()
  }
})

test('the checklists pane shows a card, and its steps when expanded', async ($, on) => {
  seed(on, {
    checklists: {
      shape: 'checklists-2',
      value: {
        t1: {
          title: 'Install Node',
          steps: ['Download it', 'Run the installer'],
          status: ['done', 'failed'],
          notes: ['', 'needs admin'],
          reported: '',
          session: 'session-now',
        },
      },
    },
    paneToggles: { 'cl:t1': true },
  })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...pane('rb-checklists', 'Checklists'), surface })
    expect((await ui.find({ type: 'Text', text: /Install Node/ }))?.text).toBe('Install Node')
    expect((await ui.find({ type: 'Text', text: /Run the installer/ }))?.text).toBe('2. Run the installer')
    expect((await ui.find({ type: 'Text', text: /needs admin/ }))?.text).toBe('needs admin')
    await ui.unmount()
  }
})
