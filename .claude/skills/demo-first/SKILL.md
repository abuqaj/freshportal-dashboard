---
name: demo-first
description: Shows a visible change to a freshportal-dashboard screen as a clickable demo before it is built or pushed - one self-contained page with the real texts in four languages, the system colours and no real data - then builds exactly what the user approved. Use when the user asks for a demo, a mockup or a proposal of how a screen should look ("zrob demo", "daj mi demo zanim wrzucisz na testa", "makieta", "zaproponuj zmiany wizualne", "zebym mogl ocenic flow"), or before pushing a redesign, a new dialog or an animation the user has not seen.
---

# demo-first

The user decides on a screen by looking at it, not by reading about it. On
2026-09-30 and 2026-10-01 three changes went this way (the paid temporary
format's dialogs, the redesign of delivery import, the running mascot). Each
was settled on a demo, in a line or two from the user, and built as shown;
the first needed a second demo before it was right.

## When

- The user asks for a demo, a mockup or a proposal of a screen.
- Before pushing a change the user has not seen and cannot judge from a
  description: a redesign, a new dialog or flow, an animation.
- Not for a fix the user described exactly: a label, a colour, a column.

## What the demo is

One self-contained page: a private artifact when the session can publish
one, otherwise an `.html` file in the scratchpad for the user to open. It is
never a route in the app and never a file in `public/`.

1. **The real screen, not a sketch.** Rebuild the screen it changes from its
   component, with the system colours by name from the `@theme` block of
   `src/app/globals.css` (`emerald`, `brick`, `blush`, `sage`, `sand`,
   `taupe`, `ink`…). No colour from outside the palette.
2. **The real texts, in four languages.** A switch PL / EN / NL / ES, with
   the strings that will go into `src/lib/i18n.ts`.
3. **No data and no cost.** Made-up rows in the real shape. No API call, no
   tokens, no login; a flow that spends money runs on a timer instead.
4. **Every state the user has to judge**, behind a scenario switch: it
   works, it fails, the limit is used up. A user and an admin, where they
   see different things. Before and after, for a redesign, with a table
   "now → after" of every text: a long sentence moves into a tooltip, it
   does not vanish.
5. **Variants side by side** when there is a real choice, each named with
   one letter, so the answer can be one letter.
6. **As the team will see it.** No notes for IT on the screen itself; the
   demo's own switches sit under a small "Demo" below it.

The standing rule for every screen holds in a demo too: a button is an icon
and at most two words, a message is a short phrase, the full sentence goes
into the tooltip, and an admin's tools show for an admin only.

## Then

1. Send the link with the open choices as a numbered list, your proposal
   beside each. The user answers by number.
2. Build what was approved, as shown. Whatever had to differ, or was added,
   goes into the report under "Beyond the demo".
3. When a second demo replaces the first, say that the first is out of date.
4. Ship with `ship-to-test`. There is no Node.js on this laptop, so the
   Vercel build is the first type check; say in the report whether anyone
   has clicked through the real screen yet.

## Traps

- **An artifact link opens only for its owner.** It is fine in the chat.
  Anywhere else it is a dead link, so say what the demo showed.
- A screenshot of the user's screen may be refused by a permission rule;
  rebuild the "before" view in HTML instead.
- **An image the app will load is part of the change:** check its weight.
  The mascot's vectorised SVG was 153 KB, half of it leftover edging, and
  went to about 8 KB; compare the slimmed file with the original at the
  app's size and at twice that before swapping it in.
- To settle a position or a frame of an animation, render it in Chromium
  through Playwright rather than guessing.

## Never

- Put a demo, or anything made only for it, into the repository.
- Use real invoices, customers or prices in a demo.
- Call a paid API to make a demo look real.
