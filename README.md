<p align="center"><img src="docs/logo.gif" alt="rich-blocks: a pixel crab stacks green, red and yellow blocks, and the stack falls over" width="600"></p>

# rich-blocks

A Claude Code mod that makes Claude's answers easier to act on.

![A copy box, a checklist with Done pills, and the suggested reply above the prompt](docs/overview.png)

- **Copy boxes:** commands, configs and snippets in a color-coded box with a Copy button, with tabs when a command differs by OS or shell.
- **Choices:** when Claude needs a decision, 2–4 clickable options with a one-line tradeoff each; your click is sent as your reply.
- **`/highlights`:** a side pane listing every colored line from the conversation, grouped by color, each copyable.
- **`/checklists`:** a side pane with every checklist and its progress, unfinished first.
- **Checklists:** steps you do yourself, each with Done / Failed / Skip pills and a line for why a step failed or was skipped. Your progress reaches Claude with your next message.
- **Suggested reply:** a line above the prompt that opens to a ready-made progress message, with **Put in prompt**.
- **Colored callouts:** key lines in Claude's replies colored by meaning: orange (important), yellow (warning), green (done), blue (tip), purple (Claude's next steps).
- **Concise style:** short, on-topic answers that end with next steps when work continues. Switch it off in the config settings (Response style: `off`).
- **Compaction:** when a conversation compacts (or is handed off with `/clear`), the steps you marked Done are kept and the rest is dropped.

### Choices, tabbed copy boxes and callouts

A choice (the pick is sent as your reply), a copy box with PowerShell and bash tabs, a checklist, and two colored callouts:

![A choice with Option A picked, a copy box on its bash tab, a three-step checklist, and orange and blue callouts](docs/blocks-0.6.png)

### Suggested reply

Collapsed to one line above the prompt until you click **show**:

![The collapsed suggestion line above the prompt](docs/suggestion-line.png)

### Compaction

After `/compact`, Claude still has the steps you finished, and only those:

![Claude quoting the completed-steps note after compaction](docs/compaction.png)

### Token use

Built to stay cheap: the guidance Claude reads is one short section, cached once per conversation; tool descriptions are a line each; checklist progress reaches Claude as one compact line (`"Install": 1✓ 2✗(needs admin) 3○`); tool results are a few words; and the panes and the suggestion line never enter Claude's context.

Works in the Claude Code desktop app and terminal. Requires a Claude Code build with mods (function-hook plugins).

Unofficial fan project, not affiliated with Anthropic. The crab in the logo is drawn in the style of Clawd, Anthropic's Claude Code mascot.

## Install

At the prompt of a terminal session:

```
/plugin install rich-blocks --marketplace Elusyon117/Elusyon-rich-blocks
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install rich-blocks --marketplace Elusyon117/Elusyon-rich-blocks
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Elusyon117/Elusyon-rich-blocks`, then **Add plugin**.

The usage instructions reach Claude in conversations started after install.
