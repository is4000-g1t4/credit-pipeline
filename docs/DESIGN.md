---
version: "alpha"
name: "UBS Credit Desk"
description: "The UBS public-web visual language, adapted into a calm, data-dense credit-decision workspace."
colors:
  primary: "#1C1C1C"
  on-primary: "#FFFFFF"
  secondary: "#5A5D5C"
  tertiary: "#E60000"
  tertiary-hover: "#8A000A"
  tertiary-bright: "#DA0000"
  neutral: "#FFFFFF"
  neutral-warm: "#F4F3EE"
  neutral-raised: "#F9F9F7"
  neutral-cream: "#FBF9EE"
  border-subtle: "#E0DFD7"
  border-strong: "#8E8D83"
  border-illustrative: "#CCCABC"
  disabled: "#B8B3A2"
  success: "#CAD67A"
  success-ink: "#295B40"
  warning: "#E4A911"
  warning-ink: "#654D16"
  danger: "#DA0000"
  danger-ink: "#78212B"
  focus: "#0769A6"
  tag-sand: "#F4F3EE"
  tag-amber: "#F3E8C3"
  tag-red: "#F2CFD4"
  tag-blue: "#D7D9EE"
  tag-green: "#BDE5CD"
  chart-1: "#00759E"
  chart-2: "#879420"
  chart-3: "#4B2D58"
  chart-4: "#AF8626"
  chart-5: "#469A6C"
  chart-6: "#AD3E4A"
typography:
  display-xl:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 60px
    fontWeight: 300
    lineHeight: 72px
    letterSpacing: -0.01em
  display-lg:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 48px
    fontWeight: 300
    lineHeight: 57px
    letterSpacing: -0.01em
  display-md:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 40px
    fontWeight: 300
    lineHeight: 48px
    letterSpacing: -0.01em
  heading-lg:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 32px
    fontWeight: 300
    lineHeight: 40px
    letterSpacing: -0.005em
  heading-md:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 28px
    fontWeight: 300
    lineHeight: 33px
    letterSpacing: 0em
  heading-sm:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 24px
    fontWeight: 300
    lineHeight: 32px
    letterSpacing: 0em
  title-lg:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 20px
    fontWeight: 300
    lineHeight: 28px
    letterSpacing: 0em
  title-md:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 18px
    fontWeight: 300
    lineHeight: 26px
    letterSpacing: 0em
  body-lg:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 17px
    fontWeight: 300
    lineHeight: 27px
    letterSpacing: 0em
  body-md:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 300
    lineHeight: 24px
    letterSpacing: 0em
  body-sm:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 300
    lineHeight: 20px
    letterSpacing: 0em
  caption:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 300
    lineHeight: 16px
    letterSpacing: 0em
  overline:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0.04em
  label:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
    letterSpacing: 0em
  button:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0em
  button-sm:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 16px
    letterSpacing: 0em
  kpi:
    fontFamily: "Frutiger, 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: 40px
    fontWeight: 300
    lineHeight: 48px
    letterSpacing: -0.01em
    fontFeature: "tnum"
rounded:
  none: 0px
  xs: 2px
  sm: 4px
  pill: 999px
spacing:
  3xs: 4px
  2xs: 8px
  xs: 12px
  sm: 16px
  md: 24px
  lg: 32px
  xl: 40px
  2xl: 48px
  3xl: 64px
  4xl: 80px
  5xl: 96px
  6xl: 120px
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.xs}"
    padding: "0 24px"
    height: 48px
  button-primary-hover:
    backgroundColor: "{colors.tertiary-hover}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.xs}"
    padding: "0 24px"
    height: 48px
  button-secondary:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.button}"
    rounded: "{rounded.xs}"
    padding: "0 24px"
    height: 48px
  button-secondary-hover:
    backgroundColor: "{colors.neutral-warm}"
    textColor: "{colors.primary}"
    typography: "{typography.button}"
    rounded: "{rounded.xs}"
    padding: "0 24px"
    height: 48px
  button-header:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-sm}"
    rounded: "{rounded.xs}"
    padding: "0 12px"
    height: 32px
  button-header-hover:
    backgroundColor: "{colors.tertiary-hover}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-sm}"
    rounded: "{rounded.xs}"
    padding: "0 12px"
    height: 32px
  button-disabled:
    backgroundColor: "{colors.disabled}"
    textColor: "{colors.primary}"
    typography: "{typography.button}"
    rounded: "{rounded.xs}"
    padding: "0 24px"
    height: 48px
  button-link:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.label}"
    height: 24px
  link-inline:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.tertiary-bright}"
    typography: "{typography.body-md}"
  input:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xs}"
    padding: "0 16px"
    height: 48px
  input-label:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    typography: "{typography.caption}"
  card:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    rounded: "{rounded.xs}"
    padding: 24px
  card-warm:
    backgroundColor: "{colors.neutral-warm}"
    textColor: "{colors.primary}"
    rounded: "{rounded.xs}"
    padding: 24px
  card-raised:
    backgroundColor: "{colors.neutral-raised}"
    textColor: "{colors.primary}"
    rounded: "{rounded.xs}"
    padding: 24px
  callout-cream:
    backgroundColor: "{colors.neutral-cream}"
    textColor: "{colors.primary}"
    rounded: "{rounded.xs}"
    padding: 24px
  panel-ink:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.xs}"
    padding: 32px
  divider:
    backgroundColor: "{colors.border-subtle}"
    height: 1px
  input-rule:
    backgroundColor: "{colors.border-strong}"
    height: 1px
  table-rule:
    backgroundColor: "{colors.border-illustrative}"
    height: 1px
  table-header:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    typography: "{typography.overline}"
    height: 40px
  nav-link:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
    height: 40px
  breadcrumb:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.secondary}"
    typography: "{typography.body-sm}"
  tag-neutral:
    backgroundColor: "{colors.tag-sand}"
    textColor: "{colors.primary}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "4px 8px"
  tag-success:
    backgroundColor: "{colors.tag-green}"
    textColor: "{colors.success-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "4px 8px"
  tag-warning:
    backgroundColor: "{colors.tag-amber}"
    textColor: "{colors.warning-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "4px 8px"
  tag-danger:
    backgroundColor: "{colors.tag-red}"
    textColor: "{colors.danger-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "4px 8px"
  tag-info:
    backgroundColor: "{colors.tag-blue}"
    textColor: "{colors.primary}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "4px 8px"
  tag-brand:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "4px 8px"
  progress-success:
    backgroundColor: "{colors.success}"
    height: 4px
  progress-warning:
    backgroundColor: "{colors.warning}"
    height: 4px
  progress-danger:
    backgroundColor: "{colors.danger}"
    height: 4px
  focus-ring:
    backgroundColor: "{colors.focus}"
    height: 2px
  kpi-value:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.kpi}"
  ai-panel:
    backgroundColor: "{colors.neutral-warm}"
    textColor: "{colors.primary}"
    rounded: "{rounded.xs}"
    padding: 24px
  ai-message-user:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xs}"
    padding: 16px
  ai-message-assistant:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xs}"
    padding: 16px
  ai-prompt:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.primary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.xs}"
    padding: "0 16px"
    height: 48px
  citation-chip:
    backgroundColor: "{colors.neutral-warm}"
    textColor: "{colors.tertiary-bright}"
    typography: "{typography.caption}"
    rounded: "{rounded.xs}"
    padding: "2px 6px"
  artifact:
    backgroundColor: "{colors.neutral-raised}"
    textColor: "{colors.primary}"
    rounded: "{rounded.xs}"
    padding: 24px
  chart-series-1:
    backgroundColor: "{colors.chart-1}"
  chart-series-2:
    backgroundColor: "{colors.chart-2}"
  chart-series-3:
    backgroundColor: "{colors.chart-3}"
  chart-series-4:
    backgroundColor: "{colors.chart-4}"
  chart-series-5:
    backgroundColor: "{colors.chart-5}"
  chart-series-6:
    backgroundColor: "{colors.chart-6}"
---

## Overview

**UBS Credit Desk** brings the public UBS visual language — Swiss editorial
calm, warm paper surfaces, Frutiger Light, and a single red thread — into an
internal credit-decision workspace. The interface should feel like a UBS
research publication that happens to be operable: confident, quiet, and
precise, never like a generic SaaS dashboard.

The design rests on five ideas:

1. **One red thread.** UBS red is the only saturated colour. It marks the
   primary action, the active tab, the page-headline bar, and live links. If
   two things on a screen are red, one of them is probably wrong.
2. **Warm paper, not grey chrome.** Neutral surfaces are white, warm greige
   (`#F4F3EE`), or off-white (`#F9F9F7`). The warmth is what makes the red feel
   UBS rather than generic banking.
3. **Light typography, strong hierarchy.** Headlines are Frutiger Light at
   large sizes; body is Light at 16–17px. Hierarchy comes from size, space and
   rules — not from weight, colour or shadow.
4. **Rules, not boxes.** Thin 1px rules, generous whitespace and aligned
   columns do the structural work. Radii stay at 2px; shadows are almost
   absent. Cards are surfaces, not floating objects.
5. **Evidence over decoration.** In an AI-assisted credit workflow, the
   interface must show the source, the reasoning and the human decision.
   Citations, quotes and confidence live in the layout; they are not hidden in
   a modal.

Use UBS marks, typefaces and photography only for the UBS-facing prototype.
The system itself is a design reference, not a redistribution licence.

## Colors

The palette is 90% white and warm neutrals, 9% ink, 1% red.

- **Primary (#1C1C1C):** UBS ink. All headlines, body copy, rules and dark
  panels. Not pure black.
- **Secondary (#5A5D5C):** Slate for metadata, labels, table headers and
  secondary navigation. Passes AA on white and on warm greige.
- **Tertiary (#E60000):** UBS red. Primary buttons, the page-headline bar,
  active navigation, focus accents. White text on it passes WCAG AA at 4.8:1.
- **Tertiary Hover (#8A000A):** Oxblood hover/pressed state. Never use it as a
  large surface.
- **Tertiary Bright (#DA0000):** Link and icon red. The public site uses this
  slightly deeper red for inline links; keep it for text links and citation
  markers, not for large fields.
- **Neutral (#FFFFFF):** Default page and card.
- **Neutral Warm (#F4F3EE):** The signature warm greige. Section bands, AI
  panels, sidebars, footers, secondary cards.
- **Neutral Raised (#F9F9F7):** A half-step above white for grouped rows and
  artifacts.
- **Neutral Cream (#FBF9EE):** Rare editorial callouts and quiet emphasis.
- **Border Strong (#8E8D83):** Input borders and structural rules.
- **Border Illustrative (#CCCABC):** Table rules and decorative separators.
- **Border Subtle (#E0DFD7):** Dividers inside a surface.
- **Disabled (#B8B3A2):** Disabled control fills; use with Secondary text.
- **Success (#CAD67A):** Lime progress/status. Ink on it is Success Ink
  (#295B40).
- **Warning (#E4A911):** Amber progress/status. Ink is Warning Ink (#654D16).
- **Danger (#DA0000):** Error and decline states. Ink is Danger Ink (#78212B).
- **Focus (#0769A6):** The one cool colour in the system. A 2px inner focus
  ring is the only place blue is allowed.
- **Tags:** Sand, amber, red, blue and green pastels carry status. They are
  small, flat and always paired with dark ink; never use a tag as a button.
- **Charts:** Muted earth tones (teal, olive, aubergine, ochre, green, rose) on
  white with warm grid lines. Red is reserved for the primary series or a
  highlighted point.

Rules: never tint white surfaces with blue or grey-blue; never use red for
non-action decoration; never place red text on the warm greige unless it is a
link at 14px or larger.

## Typography

Frutiger is the voice of the system. Use **300 Light** for nearly everything,
including headlines. Use **500 Medium** only for labels, buttons, table
headers, active navigation and inline emphasis. Do not use 600/700.

- **Display XL (60/72), Display LG (48/57), Display MD (40/48):** Page
  headlines, hero panels, KPI values. Light, tight, sentence case.
- **Heading LG (32/40), Heading MD (28/33):** Section headers. Pair with the
  60 × 4px red underline from the public site.
- **Heading SM (24/32):** Card and panel titles, dialog titles.
- **Title LG (20/28), Title MD (18/26):** Subheads, list titles, table section
  labels.
- **Body LG (17/27):** Long-form policy text, AI answers, memo prose.
- **Body MD (16/24):** Default UI copy, navigation, table cells.
- **Body SM (14/20):** Dense metadata, secondary rows, footer links.
- **Caption (13/16):** Labels above values, timestamps, chart axes.
- **Overline (12/16, 500, uppercase, 0.04em):** Table headers and eyebrow
  labels only. Never uppercase a sentence.
- **Button (14/16, 500), Button SM (13/16, 500):** All buttons.
- **KPI (40/48, 300, tabular):** Numbers that matter.

Numeric data uses `font-variant-numeric: tabular-nums` everywhere. Money,
percentages and IDs align on the decimal or final digit. Do not use a
monospace face for IDs; UBS keeps the humanist sans and lets letter-spacing do
the work.

The prototype falls back to Segoe UI or Helvetica when Frutiger is not
licensed. Preserve the 300/500 rhythm in the fallback; do not compensate with
bold weights.

## Layout

The public UBS grid is a 12-column mobile grid and a 24-column desktop grid
with **1290px of content inside 40px gutters** (a 1370px outer container) at
desktop, 24px at tablet and 20px at mobile. The prototype uses a 12-column
working grid with the same container and gutters.

- **Page rhythm.** 64px above a page headline, 48px below; 64–96px between
  editorial sections. Dense working screens (tables, review queues) may use
  32–48px.
- **Headline block.** A 4px red bar sits to the left of the title and subtitle,
  20px away, stretching the full text block (roughly 89–118px). The title is
  60/72 Light; the subtitle is 24/32 Light, max 62ch. Do not put an uppercase
  eyebrow or breadcrumb above the title; UBS uses “You are here” in the footer
  instead.
- **Two-tier navigation.** 106px total: 10px top pad + 64px utility row + 31px
  primary navigation + 1px rule. The logo is 29px tall on the first row.
  Primary navigation is 16px Light with a 2px red underline on the active item
  and 42px between items; the search icon anchors the right edge.
- **Content columns.** Editorial copy maxes at 820px. Data screens use the
  full 1290px. An AI/assist rail is 380–440px and sits on the right, separated
  by whitespace or a warm surface — never by a heavy card border.
- **Working-page template.** Page head → summary strip (KPI or case facts) →
  primary data region (7–8 columns) + assist/decision rail (4–5 columns) →
  timeline/footer. The eye should travel left to right, not down a stack of
  cards.
- **Editorial template.** Page head → 820px prose column + 380px warm aside →
  footer breadcrumb. This is used by policy answers and memos.
- **Responsive.** Below 1024px the assist rail stacks under the primary
  region; below 768px the navigation collapses to a hamburger, the two-tier
  header becomes one row plus a search icon, and tables become stacked rows
  with the amount and status on the right.

Use whitespace as the primary grouping device. If a border is doing work that
24px of space could do, remove the border.

## Elevation & Depth

The system is almost flat. Depth comes from surface temperature and
translucency, not shadows.

- **Level 0:** white page.
- **Level 1:** warm greige bands (`#F4F3EE`) and off-white raised rows
  (`#F9F9F7`).
- **Level 2:** a floating white panel over photography, using
  `rgba(255,255,255,0.8)` plus a 1px `rgba(28,28,28,0.08)` rim — the UBS hero
  treatment. No blur is required; the translucency is the effect.
- **Level 3:** only dialogs and the mobile menu, with a 1px rule and a soft
  ambient shadow (`0 8px 24px rgba(28,28,28,0.10)`). Use sparingly.

Never use coloured glows, glassmorphism beyond the hero panel, or drop shadows
on every card. Focus is shown with a 2px `#0769A6` ring inset or offset 2px,
never with elevation.

## Shapes

- **Radius:** 2px (`rounded.xs`) for inputs, buttons, cards, tags, filter
  chips and panels. 4px is allowed only for the mobile menu sheet. 999px is
  reserved for avatars and status dots. Everything else is square.
- **Rules:** 1px. Structural rules are Border Illustrative; input borders are
  Border Strong; inside-surface dividers are Border Subtle.
- **Imagery:** square corners, full-bleed when the image is the section. Use a
  warm neutral overlay rather than a dark scrim. People are photographed in
  real environments, never cut out on gradients.
- **Icons:** 1.5px stroke, 16/20/24px, rounded joins. Icons are ink or red,
  never multicoloured. The chevron (`›`) is the signature affordance and is
  always red when it marks a link or primary action.

## Components

**Buttons.** Primary: UBS red, 48px high, 2px radius, 24px side padding, 14/16
Medium white. Include a 16px chevron with 8px gap. Hover to oxblood. Secondary:
transparent with a 1px ink inset, same geometry; hover fills warm greige.
Header CTA: 32px high, 13/16 Medium, `0 12px` padding. Link CTA: 14/16 Medium
ink text with a red chevron, no underline until hover. Never stack two primary
buttons; the secondary sits to its left.

**Inputs.** 48px high, white fill, 1px Border Strong, 2px radius, 16px inner
padding. Labels are 13/16 Medium slate above the field; helper text is 13/16
slate below. Focus uses the blue 2px ring, not red. Selects keep the native
chevron language. Checkboxes are 20px squares with ink checks; never use red
for a checked box.

**Cards and panels.** Editorial sections use rules and whitespace, not boxes.
In data-dense working screens, a panel may use a 1px Border Subtle outline to
group a table or a definition list; do not nest cards inside cards. Use 24px
padding; 32px for the main assist panel. No hover lift. A panel title is
Heading SM (24/32), followed by 16px body and a single link CTA at the bottom.
KPI cards use the KPI type token, with the label above in Overline and a 1px
rule below.

**Tables and queues.** Header row 40px, Overline slate, 1px Border
Illustrative rule; rows are 56–64px with 16/24 body, aligned to a shared
column grid. Amounts and dates are right-aligned and tabular. Row hover is
`#F9F9F7`. The reference/ID is an ink link, not a blue one. Status is a tag,
never a coloured dot alone. Filters are 32px buttons with a 2px radius and a
1px Border Strong rule; the active filter is ink with white text. The overall
page is not wrapped in a card.

**Navigation.** Two tiers as described in Layout. Primary links are 16/28
Light ink with 42px between items; active gets a 2px red underline. Utility
links are 13/16 Light slate. The logo is never placed on a warm background
without clear space equal to the logo height. Footer is warm greige, four
columns, 28px column gap, 13/20 Light links on a 34px pitch, and no extra
rules above the legal block.

**Status language.** Use sentence case for human statuses (“In review”,
“Booked”, “Declined”), keep machine codes (`AMOUNT_ABOVE_AUTO_LIMIT`) in
13/16 with letter-spacing 0.02em and a warm tag. Never encode status by colour
alone; pair the tag with its label.

**AI surfaces.** AI is an editorial aside, not a chatbot mascot.

- **Panel:** warm greige, 24px padding, 2px radius, title “Case assist” in
  Heading SM with a small red rule. No gradient, no sparkle emoji.
- **Conversation:** vertical transcript with 24px gaps. User turns are ink
  blocks with white 14/20 text and a 2px radius; assistant turns are plain
  white/transparent prose at 16/24 with no bubble. Avatars are 24px circles
  with initials, not illustrations.
- **Message / Response:** assistant content is 14/22 in the assist rail and
  Body LG (17/27) in the editorial policy template, with 12px paragraph gaps.
  Key numbers are Medium, not bold. Do not use markdown headings inside a
  chat turn; use overline labels instead.
- **Prompt input:** 48px white field with 1px Border Strong, 2px radius, a
  paperclip and a red send button. Suggestions are 32px pill or text chips in
  slate; the first suggestion may be ink.
- **Reasoning:** collapsible row with a 16px brain/step icon, “Reasoning”
  label, elapsed time in slate, chevron. Open state is 12/18 slate prose on
  warm white. No animated shimmer; use a static 3-dot or a thin progress rule.
- **Tool:** bordered white block with a 32px header (icon + tool name +
  status tag + chevron), 1px Border Subtle. Tool input/output use body-sm;
  JSON is tabular but not monospace-heavy.
- **Sources:** a numbered list of source cards in the warm panel. Each source
  shows index, type (Policy, Document, Bureau, Bank data), title, section and
  page. Opening an inline citation reveals a 320px white card with the exact
  quote, source title and “Open source”.
- **Inline citation:** a 15px superscript chip with red index on warm greige.
  It is a button, not a link; clicking or tapping opens the citation card.
  Never use a footnote asterisk.
- **Task:** collapsible checklist with pending / in-progress / completed
  states. Completed uses ink check in a 1px circle; in-progress uses a 1px
  partial ring; no green.
- **Artifact:** an off-white document card for the credit memo / adverse
  action letter. Header: 13/16 Overline + title + version tag. Body: 17/27
  prose, 820px max measure. Actions sit in a 1px top rule.
- **Suggestion:** 13/16 Medium, 32px high, 1px Border Strong, 2px radius,
  ink text. Hover warm greige.
- **AI guardrails:** every assistant claim carries a citation or a visible
  “unverified” tag; the human decision control is always outside the AI panel
  and never red-labelled “Approve” inside it. AI never owns the final button.

**Data visualisation.** 1px warm grid, 13/16 caption axes, no chart borders.
Line series are 2px; the primary series is UBS red, secondary series use the
chart palette. Bars are 8px wide with 2px radius. Label the unit once, not on
every tick. Tooltips are white cards with a 1px rule.

## Do's and Don'ts

**Do**

- Lead with a light, large headline and a short red rule.
- Let warm greige carry grouping; leave white space around data.
- Use red for one primary action per view and for the active/current state.
- Keep every number tabular and every source citable.
- Use sentence case, Swiss plain language and specific nouns.
- Put the human decision beside the AI evidence, never inside it.
- Test the fallback font: hierarchy must survive without Frutiger.

**Don't**

- Don't use blue links, blue primary buttons, or blue-tinted greys.
- Don't use gradients, glass cards, large radii, or shadows for hierarchy.
- Don't use bold for emphasis; use size or 500 Medium.
- Don't put red on warm greige as a background for large text.
- Don't wrap every section in a card or give tables their own card chrome.
- Don't make AI a floating bubble or a full-width chat toy; it is a rail.
- Don't auto-approve, auto-decline, or place the decision inside an AI
  response. The officer decides.
- Don't reproduce UBS marks outside this UBS-facing prototype.

---

*Provenance: derived from publicly reachable ubs.com pages captured 27 October
2026 (home, Wealth Management, Investment Bank, Our firm, Media, Careers,
CIO Insights, Contact, Our brand, Swiss private/corporate banking). Reference
screenshots and page metadata live in `.scratch/ubs-reference/`.*
