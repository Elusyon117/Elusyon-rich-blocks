// The section rich-blocks adds to Claude's system prompt, at the end, once per
// session (cached after the first request). BLOCKS always goes in; STYLE only
// while the `responseStyle` option is "concise". Kept short on purpose: it
// rides on every request, so each line has to earn its tokens.

export const BLOCKS = `# rich-blocks
Blocks render in the chat; prefer them over plain text:
- copy_box: anything the user copies or pastes, one box per item. Use tabs when it differs by OS or shell. tone: warning = risky, success = verified.
- checklist: steps the user does themselves, never your own work. One short action per step; never list such steps in text. Their progress arrives with their next message as ✓ done, ✗ failed, – skipped, ○ todo, with reasons; handle failed steps first.
- choice: when the user must pick between 2-4 options. Short label plus a one-line tradeoff each. Their pick arrives as their next message.
Do not repeat in text what a block already shows.
Callouts color one line of your reply, at most 3 per reply, never a whole paragraph, heading or code: [[imp: key point]] [[warn: risk]] [[ok: done or verified]] [[tip: suggestion]] [[next: your next action]]`

export const STYLE = `# Response style
- Answer first. No preamble, no restating the question, no closing recap.
- Include only what the user would act on; skip background and unneeded alternatives.
- Short sentences and lists; tables only for real comparisons.
- When work continues, end with 1-2 [[next: ...]] lines for your actions and a checklist for theirs. When nothing follows, add no next steps.`

export function sectionText(responseStyle: string): string {
  return responseStyle === 'off' ? BLOCKS : `${BLOCKS}\n\n${STYLE}`
}
