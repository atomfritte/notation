/**
 * The forms manual the assistant's `forms_guide` tool returns — the same
 * content the MCP server's `forms_guide` serves (backend
 * mcphandler/formsguide.go), phrased for the in-app tools: folders are created
 * implicitly by `write_file`, there is no separate mkdir. Keep both in step with
 * the parser in backend space/form.go.
 */
export const FORMS_GUIDE = `# Building a Form in notation

A **Form** is just a folder that contains a file named \`_form.md\`. When that file
is present, notation renders the folder as a fillable form instead of a file list:
people submit entries in the app, and each submission is stored as a sibling
Markdown file inside the folder. You only author the template; the app handles
submissions.

## How to create one

Create \`<folder>/_form.md\` — the folder is created with it, no separate step.
That's it: the folder now shows up as a form. Editing a form = editing \`_form.md\`.

## Template syntax

\`_form.md\` is ordinary Markdown. Two things are special:

- The **first \`# Heading\`** becomes the form's title.
- **Every line that contains a \`[type]\` tag becomes a form field.** The label is the
  text before the tag. A run of 2+ underscores (\`______\`) is an optional "fill in the
  blank" placeholder and is stripped.

Block style: if a field line has no label of its own, the previous non-empty line is
used as the label. Handy for big text fields:

\`\`\`
Notes:
______ [text]
\`\`\`

### Modifiers — trailing \`(...)\`

- \`(required)\` or \`(*)\` — the field must be filled.
- \`(default: some value)\` — pre-fills the field.

### Options — for choice fields

Inline in the tag, \`[select: low, mid, high]\`, and/or as a trailing group,
\`(low, mid, high)\`. Applies to \`select\`, \`buttons\`, \`multiselect\`.

### Numeric args — for slider / rating

- \`[slider: min, max, step]\` — defaults \`0, 100, 1\`.
- \`[rating: levels]\` — number of stars, default \`5\` (max 20).
- \`smiley\` is a fixed 1..5 mood scale (no args).

## Field types

Canonical name on the left; the aliases resolve to the same type. An unknown type
falls back to \`string\`.

| Type | Aliases | Input |
|---|---|---|
| \`string\` | str, line | single-line text |
| \`text\` | textarea, multiline, paragraph | multi-line text |
| \`integer\` | int, whole | whole number |
| \`number\` | num, float, decimal | decimal number |
| \`bool\` | boolean, checkbox, check, yesno | yes/no checkbox |
| \`date\` | — | date picker |
| \`time\` | — | time picker |
| \`datetime\` | timestamp | date + time |
| \`select\` | choice, dropdown, enum, option | single choice, dropdown |
| \`buttons\` | radio, toggle, choices, pills | single choice, button pills |
| \`multiselect\` | multi, checklist, tags, checkboxes, multichoice | multiple choice |
| \`smiley\` | smileys, mood, emoji | 1..5 mood scale |
| \`rating\` | stars, star | 1..N stars |
| \`slider\` | range | numeric range slider |
| \`image\` | images, photo, photos, picture, pic | image upload |
| \`email\` | mail | email address |
| \`url\` | link | URL |

## Notes

- Each field's key is derived from its label (lowercased, umlauts folded: ä→ae,
  ö→oe, ü→ue, ß→ss). Give fields distinct labels.
- The **first field** labels each submission in the entry list — put the most
  identifying one first (a name, a date…).
- Don't hand-write entry files. Submissions carry a \`notation_entry: true\`
  frontmatter flag and are created when someone fills the form in the app.

## Worked example

\`standup/_form.md\`:

\`\`\`
# Daily standup

Name: ______ [string] (required)
Date: ______ [date] (required)
Mood: ______ [smiley]
Focus today: ______ [select: feature, bug, review, ops]
Blockers? ______ [bool]
Confidence: ______ [slider: 0, 10, 1]

What did you do?
______ [text]
\`\`\`
`
