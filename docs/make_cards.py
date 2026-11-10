"""The README's pictures: one 880x500 card per feature, all the same size so the README reads as one even column.
Each card holds a real screenshot from docs/screenshots (cut to the part that matters, embedded, so GitHub shows
it) beside or under a few words on what the feature does; the callouts card draws its lines itself.

    py -I docs/make_cards.py            writes docs/cards/<name>.svg

Take a new screenshot into docs/screenshots and run this again when a block's look changes.
"""
import base64
import os
import struct
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "screenshots")
CW, CH = 880, 500
FONT = "Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif"
BG, BORDER = "#141312", "#3d3c38"
TEXT, DIM = "#ececea", "#a3a29c"
GREEN = "#22c55e"                      # the accent: the logo's green block
CALLOUT = {"orange": "#f97316", "yellow": "#eab308", "green": "#22c55e", "blue": "#60a5fa", "purple": "#a78bfa"}


def shot(name):
    """(data URI, width, height) of a screenshot."""
    data = open(os.path.join(SHOTS, name), "rb").read()
    w, h = struct.unpack(">II", data[16:24])
    return "data:image/png;base64," + base64.b64encode(data).decode(), w, h


def wrap(s, chars):
    lines, cur = [], ""
    for w in s.split():
        if cur and len(cur) + len(w) + 1 > chars:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    return lines + ([cur] if cur else [])


def frame(body, alt):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{CW}" height="{CH}" viewBox="0 0 {CW} {CH}" '
            f'font-family="{FONT}" role="img"><title>{escape(alt)}</title><defs>'
            f'<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d1c1a"/>'
            f'<stop offset="1" stop-color="{BG}"/></linearGradient>'
            f'<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="{GREEN}" '
            f'stop-opacity="0.13"/><stop offset="1" stop-color="{GREEN}" stop-opacity="0"/></radialGradient>'
            f'<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{BG}" '
            f'stop-opacity="0"/><stop offset="1" stop-color="{BG}"/></linearGradient>'
            f'<filter id="shadow" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="8" '
            f'stdDeviation="10" flood-color="#000" flood-opacity="0.55"/></filter>'
            f'<clipPath id="card"><rect width="{CW}" height="{CH}" rx="16"/></clipPath></defs>'
            f'<g clip-path="url(#card)"><rect width="{CW}" height="{CH}" fill="url(#bg)"/>{body}</g>'
            f'<rect x="0.5" y="0.5" width="{CW - 1}" height="{CH - 1}" rx="16" fill="none" stroke="{BORDER}"/></svg>')


def chip(x, y, s):
    w = len(s) * 7.2 + 22
    return (f'<rect x="{x}" y="{y}" width="{w:.0f}" height="26" rx="13" fill="{GREEN}" fill-opacity="0.12" '
            f'stroke="{GREEN}" stroke-opacity="0.5"/><text x="{x + w / 2:.0f}" y="{y + 13}" font-size="12.5" '
            f'fill="{GREEN}" font-family="Consolas, Menlo, monospace" text-anchor="middle" '
            f'dominant-baseline="central">{escape(s)}</text>')


def picture(name, crop, x, y, w, h_max):
    """The `crop` (x, y, w, h in the screenshot's pixels) of a screenshot, `w` wide at (x, y), in a rounded frame;
    cut at `h_max` with a fade when taller. Returns (svg, drawn height)."""
    uri, iw, ih = shot(name)
    cx, cy, cw, ch = crop
    s = w / cw
    dh = ch * s
    shown = min(dh, h_max)
    cid = "pic-" + name[:-4]
    out = (f'<defs><clipPath id="{cid}"><rect x="{x}" y="{y}" width="{w}" height="{shown:.0f}" rx="10"/></clipPath>'
           f'</defs><rect x="{x}" y="{y}" width="{w}" height="{shown:.0f}" rx="10" fill="#1a1a1a" '
           f'filter="url(#shadow)"/><g clip-path="url(#{cid})"><image href="{uri}" x="{x - cx * s:.1f}" '
           f'y="{y - cy * s:.1f}" width="{iw * s:.1f}" height="{ih * s:.1f}"/></g>'
           f'<rect x="{x + 0.5}" y="{y + 0.5}" width="{w - 1}" height="{shown - 1:.0f}" rx="10" fill="none" '
           f'stroke="{BORDER}"/>')
    if dh > h_max:
        out += f'<rect x="{x - 20}" y="{y + shown - 80:.0f}" width="{w + 40}" height="80" fill="url(#fade)"/>'
    return out, shown


def words(command, title, tagline, bullets, width_chars):
    out = [chip(48, 48, command),
           f'<text x="48" y="118" font-size="30" font-weight="700" fill="{TEXT}">{escape(title)}</text>']
    y = 152
    for line in wrap(tagline, width_chars):
        out.append(f'<text x="48" y="{y}" font-size="15" fill="{DIM}">{escape(line)}</text>')
        y += 22
    y += 20
    for b in bullets:
        for k, line in enumerate(wrap(b, width_chars)):
            if k == 0:
                out.append(f'<text x="48" y="{y}" font-size="14" fill="{GREEN}" font-weight="700">›</text>')
            out.append(f'<text x="66" y="{y}" font-size="13.5" fill="{TEXT}">{escape(line)}</text>')
            y += 20
        y += 10
    return "".join(out)


def wide_card(command, title, tagline, name, crop, alt):
    """Words on top, a wide screenshot under them."""
    out = [chip(48, 40, command),
           f'<text x="48" y="106" font-size="30" font-weight="700" fill="{TEXT}">{escape(title)}</text>']
    for k, line in enumerate(wrap(tagline, 96)):
        out.append(f'<text x="48" y="{138 + 22 * k}" font-size="15" fill="{DIM}">{escape(line)}</text>')
    top, h_max = 200, CH - 200 - 30
    w = min(CW - 96, crop[2] * h_max / crop[3])
    out.append(f'<ellipse cx="{CW / 2}" cy="{CH - 120}" rx="{CW * 0.5}" ry="{CH * 0.45}" fill="url(#glow)"/>')
    out.append(picture(name, crop, (CW - w) / 2, top, round(w), h_max)[0])
    return frame("".join(out), alt)


def callouts_card():
    """The callouts drawn as a reply shows them: plain paragraphs, and the marked lines in their colors."""
    lines = [("The settings page is in place and the form saves.", None),
             ("Done: all 42 tests pass.", "green"),
             ("The API key goes in .env, never in the code.", "orange"),
             ("Risk: the migration rewrites the users table.", "yellow"),
             ("Tip: run the tests with --watch while you work.", "blue"),
             ("Next: I'll wire the page into the menu.", "purple")]
    x, w = 440, CW - 440 - 34
    rows = sum(len(wrap(t, 48)) for t, _ in lines)
    h = 30 + rows * 21 + (len(lines) - 1) * 19 + 22        # the box fits its lines, centred in the card
    y = (CH - h) // 2
    out = [f'<ellipse cx="{x + w / 2}" cy="{CH / 2}" rx="{w * 0.75}" ry="{CH * 0.6}" fill="url(#glow)"/>',
           f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="#1a1a1a" stroke="{BORDER}" '
           f'filter="url(#shadow)"/>']
    ty = y + 36
    for text, color in lines:
        for line in wrap(text, 48):
            out.append(f'<text x="{x + 22}" y="{ty}" font-size="14.5" fill="{CALLOUT[color] if color else TEXT}" '
                       f'font-weight="{600 if color else 400}">{escape(line)}</text>')
            ty += 21
        ty += 19
    legend = " · ".join(("orange key point", "yellow risk", "green done", "blue tip", "purple next steps"))
    return frame(words("[[imp: ...]]", "Colored callouts", "The lines worth finding again, colored by what they "
                       "mean. Everything else in a reply looks as usual.",
                       ["Orange: the key point", "Yellow: a risk or caveat", "Green: done or verified",
                        "Blue: a tip", "Purple: Claude's next steps"], 44) + "".join(out),
                 "Colored callouts: a reply with plain text and lines in orange, yellow, green, blue and purple: "
                 + legend)


def cards():
    return {
        "blocks": wide_card(
            "copy_box · checklist · choice", "Blocks in the chat",
            "A choice you answer with one click, a copy box with a tab per shell and a Copy button, and a "
            "checklist whose Done / Failed / Skip pills reach Claude with your next message.",
            "blocks.png", (0, 62, 771, 360),
            "A choice with Option A picked, a copy box on its bash tab with a Copy button, and a three-step "
            "checklist with Done, Failed and Skip pills"),
        "callouts": callouts_card(),
        "suggested": wide_card(
            "above the prompt", "Suggested reply",
            "When you tick a checklist, a line above the prompt offers a ready-made progress message: open it "
            "and press Put in prompt.",
            "overview.png", (0, 572, 797, 210),
            "The suggested reply above the prompt: a finished checklist written out as a progress message, with "
            "Put in prompt"),
        "highlights": wide_card(
            "/highlights", "Highlights pane",
            "Every colored line from the conversation in a side pane, grouped into cards: important, warnings, "
            "next steps, done and tips. Copy any line; the pane never enters Claude's context.",
            "highlights-pane.png", (0, 92, 744, 300),
            "The highlights pane: colored cards for important lines, warnings, Claude's next steps, done items "
            "and tips"),
        "checklists": wide_card(
            "/checklists", "Checklists pane",
            "Every checklist in the conversation with a colored progress bar; open one to see its steps and your "
            "marks. The pane never enters Claude's context.",
            "checklists-pane.png", (0, 318, 746, 300),
            "The checklists pane: cards with colored progress bars, one open to show its steps"),
        "compaction": wide_card(
            "/compact · /clear", "Kept through compaction",
            "When a conversation compacts or is handed off, the steps you finished are kept and the rest is "
            "dropped, so Claude never redoes your work.",
            "compaction.png", (0, 190, 820, 320),
            "After /compact, Claude quotes the completed-steps note rich-blocks kept: the steps marked done"),
    }


if __name__ == "__main__":
    out = os.path.join(HERE, "cards")
    os.makedirs(out, exist_ok=True)
    for name, svg in cards().items():
        with open(os.path.join(out, f"{name}.svg"), "w", encoding="utf-8", newline="\n") as f:
            f.write(svg)
    print(", ".join(f"{n}.svg" for n in cards()))
