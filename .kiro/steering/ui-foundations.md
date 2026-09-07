---
inclusion: fileMatch
fileMatchPattern: ['**/*.html', '**/*.scss', '**/*.css', '**/*.ts', '**/*.js', '**/*.jsx']
description: UI design specification defining layout, colour palette, typography, components, dark mode, animations, and responsive breakpoints for the portal dashboard style.
---

# UI Design Specification — Default Portal Dashboard Style

## Layout Structure
- **Icon sidebar** (108px): Default logo at top, icon navigation with bold labels below icons.
- **Top header bar**: right-aligned with inline search bar, dark mode toggle, chat, notifications, profile.
- **Content area**: centred, max-width ~1200px, vertically stacked cards.
- **Content order**: Search (in header) → Greeting → Page content cards → Footer.
- **Main layout**: sidebar is `position: fixed`, content uses `margin-left: 108px`.

---

## Color Palette (CSS Custom Properties)

```css
:root {
  --color-nw-purple: #5A287D;
  --color-nw-purple-l: #7A4A9E;
  --color-nw-purple-bg: #F3EFF8;
  --color-bg: #F5F5F8;
  --color-bg-muted: #F8F7FA;
  --color-card: #FFFFFF;
  --color-line: #E8E4EE;
  --color-ink: #1A1A2E;
  --color-ink-2: #5B5B6E;
  --color-ink-3: #9B9BAE;
  --color-red: #D5281B;
  --color-green: #23A656;
  --color-amber: #F2A900;

  /* Dark mode */
  --color-bg-dark: #1A1A2E;
  --color-card-dark: #2A2A4A;
  --color-line-dark: #3A3A5C;
  --color-ink-dark: #F5F5F8;
  --color-ink-2-dark: #E0E0F0;
  --color-ink-3-dark: #A0A0C2;
}
```

---

## Typography

- **Font family**: `'Default Sans', 'Segoe UI', system-ui, sans-serif`
- **Base size**: 14px, line-height 1.5
- **Greeting heading**: 28px, weight 600
- **Section/card heading**: 16px, weight 700
- **Body text**: 14px, weight 400
- **Small/meta text**: 12px
- **Labels (form)**: 12px, weight 600, uppercase, letter-spacing 0.4px
- **Sidebar nav labels**: 10px, weight 700, bold

---

## Greeting Logic

- UK English (en-GB) only.
- Client-side time from user's browser:
  - 05:00–11:59 → "Good Morning"
  - 12:00–17:59 → "Good Afternoon"
  - 18:00–04:59 → "Good Evening"
- Format: "Good [Period], [Username]"

---

## Search Bar

- Positioned inline in the top header bar, next to dark mode toggle.
- Pill shape (full border-radius), height 36px, width 320px (expands to 380px on focus).
- Purple glow shadow: `0 0 12px rgba(90,40,125,0.12)` default, stronger on focus.
- Search icon inside on the left.
- Functional: filters a searchable index of pages, tools, patterns, and docs.
- Results appear in a dropdown below the input.

---

## Sidebar Navigation

- Width: `108px`, background: `var(--color-card)`.
- Right border: `1px solid var(--color-line)`.
- Icons: 20px for main items, 18px for sub-items. Meaningful, contextual SVG icons.
- Labels: 10px bold below icons, max-width 96px, ellipsis overflow.
- Active state: `var(--color-nw-purple-bg)` background, `var(--color-nw-purple)` icon colour, left 3px purple border.
- Header aligns with top header bar (same min-height so border lines match).

---

## Top Header Bar

- Right-aligned flex row: search → dark toggle → chat → notifications → profile.
- Same `min-height` as sidebar header so horizontal borders align.
- Background: `var(--color-card)`, bottom border: `1px solid var(--color-line)`.

---

## Content Cards

- Background: `var(--color-card)` / dark: `var(--color-card-dark)`.
- Border: `1px solid var(--color-line)` / dark: `var(--color-line-dark)`.
- Border-radius: `12px`.
- Padding: `20px`.
- Shadow: `0 1px 3px rgba(0,0,0,0.04)`.
- Margin-bottom: `16px`.

---

## Buttons

- Primary: background `var(--color-nw-purple)`, white text, 8px radius, 12px 32px padding.
- Hover: `var(--color-nw-purple-l)`, subtle lift (-1px translateY).
- Disabled: `var(--color-ink-3)` background.
- All interactive targets: minimum 24x24px (WCAG 2.5.8).

---

## Form Fields

- Inputs/selects/textareas: 1px border `var(--color-line)`, 8px radius, 10px 12px padding.
- Focus: border becomes `var(--color-nw-purple)`, 3px purple box-shadow ring.
- Labels: uppercase, 12px, weight 600, purple colour.
- Required indicator: red asterisk.

---

## Chat / AI Assistant

- Two modes: **Sidebar** (default) and **Floating** (opt-in).
- **Sidebar mode**: full-height right panel (380px), rounded left corners (16px), pushes main content left via `margin-right`.
- **Floating mode**: 360x480px, bottom-right overlay, 16px border-radius all around, does NOT push content.
- Toggle buttons in the assistant header to switch between modes.
- Purple header, message bubbles (bot = purple-bg left-aligned, user = purple right-aligned).
- **Suggestion chips**: pill-shaped tappable buttons shown as initial suggestions. On tap, send as a message and hide.

---

## Bar Charts (Dashboard)

- Use `.bar-row` layout: label (120–180px) → track (flex) → value.
- Track: 8px height, muted background, 4px radius.
- Fill: purple (primary) or purple-light (secondary), animated width.
- Value: 11px bold, right-aligned.

---

## Kanban / Tracker Cards

- Cards inside columns: white background, 1px border, 8px radius, 12px padding.
- Header: ID (purple, bold) + priority badge (colour-coded).
- Title: 13px, weight 500.
- Footer: project code + date, 11px muted.
- Delete button: hidden by default, appears on card hover.
- Priority colours: Critical = red, High = amber, Medium = purple.

---

## Workflow Steps (Horizontal)

- Horizontal scrollable row of step cards.
- Each step: icon in a 44x44px rounded card + label below.
- Connectors: 24px horizontal lines between steps.
- **Sequence enforcement**: future steps greyed out (35% opacity + grayscale filter), locked cursor.
- Completed steps: green border on icon card, green step number badge.
- Running step: purple pulse animation.
- On click: show detail panel below with description, risk level, duration, and API calls.
- Step number badge: top-right corner of each node.

---

## Dark Mode

- Toggle in header (sun/moon icon).
- `html.dark` class drives all dark variants.
- Persisted in `localStorage`.
- All colour tokens have dark counterparts applied via `html.dark` selectors.

---

## Footer

- Centred, below all content.
- Brand name: `var(--color-nw-purple)`, 14px, semibold.
- Privacy link.
- "© 2026 Default Group. All rights reserved.": 12px, muted.
- System status: 12px, muted, italic.

---

## Responsive Breakpoints

- **≤ 900px (tablet)**: single-column form rows, single-column charts, single-column kanban, stat cards 2x2.
- **≤ 768px (mobile)**: sidebar hidden (toggle button), no content margin-left, compact padding, chat goes full-width.
- **Print**: hide sidebar, header, footer, chat. Cards lose borders/shadows. White background.

---

## Animations

```css
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- Default animation: `fadeIn 0.35s ease` on page content and cards.
- All animations disabled under `prefers-reduced-motion: reduce`.
