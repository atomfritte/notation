package mcphandler

// formsGuide is the complete manual returned by the `forms_guide` tool. It
// teaches a model how to author a Notation Form from scratch using the other
// MCP tools (mkdir + create_file). Keep it in sync with the parser in
// internal/space/form.go — the field types, aliases and modifiers below are the
// exact ones normalizeType / ParseFormSchema accept.
const formsGuide = "# Building a Form in Notation\n" +
	"\n" +
	"A **Form** is just a folder that contains a file named `_form.md`. When that file\n" +
	"is present, Notation renders the folder as a fillable form instead of a file list:\n" +
	"people submit entries in the app, and each submission is stored as a sibling\n" +
	"Markdown file inside the folder. You only have to author the template; the app\n" +
	"handles submissions.\n" +
	"\n" +
	"## How to create one\n" +
	"\n" +
	"1. `mkdir <folder>` — create an empty folder, e.g. `feedback`.\n" +
	"2. `create_file <folder>/_form.md` with the template (syntax below).\n" +
	"\n" +
	"That's it. The folder now shows up as a form. (You can also use `write_file` to\n" +
	"overwrite an existing `_form.md` when editing a form.)\n" +
	"\n" +
	"## Template syntax\n" +
	"\n" +
	"`_form.md` is ordinary Markdown. Two things are special:\n" +
	"\n" +
	"- The **first `# Heading`** becomes the form's title.\n" +
	"- **Every line that contains a `[type]` tag becomes a form field.** The field's\n" +
	"  label is the text before the tag. The `______` (a run of 2+ underscores) is an\n" +
	"  optional visual \"fill in the blank\" placeholder — it's stripped, so use it or\n" +
	"  not, purely for looks.\n" +
	"\n" +
	"Block style: if a field line has no label of its own, the previous non-empty\n" +
	"line is used as the label. Handy for big text fields:\n" +
	"\n" +
	"```\n" +
	"Notes:\n" +
	"______ [text]\n" +
	"```\n" +
	"\n" +
	"### Modifiers — trailing `(...)`\n" +
	"\n" +
	"- `(required)` or `(*)` — the field must be filled.\n" +
	"- `(default: some value)` — pre-fills the field.\n" +
	"\n" +
	"### Options — for choice fields\n" +
	"\n" +
	"Provide the choices inline in the tag, `[select: low, mid, high]`, and/or as a\n" +
	"trailing group, `(low, mid, high)`. Applies to `select`, `buttons`, `multiselect`.\n" +
	"\n" +
	"### Numeric args — for slider / rating\n" +
	"\n" +
	"- `[slider: min, max, step]` — defaults `0, 100, 1`.\n" +
	"- `[rating: levels]` — number of stars, default `5` (max 20).\n" +
	"- `smiley` is a fixed 1..5 mood scale (no args).\n" +
	"\n" +
	"## Field types\n" +
	"\n" +
	"Use the canonical name on the left; the aliases all resolve to the same type.\n" +
	"An unrecognised type falls back to `string`.\n" +
	"\n" +
	"| Type         | Aliases                                            | Input                         |\n" +
	"|--------------|----------------------------------------------------|-------------------------------|\n" +
	"| `string`     | str, line                                          | single-line text              |\n" +
	"| `text`       | textarea, multiline, paragraph                     | multi-line text               |\n" +
	"| `integer`    | int, whole                                         | whole number                  |\n" +
	"| `number`     | num, float, decimal                                | decimal number                |\n" +
	"| `bool`       | boolean, checkbox, check, yesno                    | yes/no checkbox               |\n" +
	"| `date`       | —                                                  | date picker                   |\n" +
	"| `time`       | —                                                  | time picker                   |\n" +
	"| `datetime`   | timestamp                                          | date + time                   |\n" +
	"| `select`     | choice, dropdown, enum, option                     | single choice, dropdown       |\n" +
	"| `buttons`    | radio, toggle, choices, pills                      | single choice, button pills   |\n" +
	"| `multiselect`| multi, checklist, tags, checkboxes, multichoice    | multiple choice (stored list) |\n" +
	"| `smiley`     | smileys, mood, emoji                               | 1..5 mood scale               |\n" +
	"| `rating`     | stars, star                                        | 1..N star rating              |\n" +
	"| `slider`     | range                                              | numeric range slider          |\n" +
	"| `image`      | images, photo, photos, picture, pic                | image upload (stored paths)   |\n" +
	"| `email`      | mail                                               | email address                 |\n" +
	"| `url`        | link                                               | URL                           |\n" +
	"\n" +
	"## Notes\n" +
	"\n" +
	"- Each field's internal key is auto-derived from its label (lowercased, umlauts\n" +
	"  folded: ä→ae, ö→oe, ü→ue, ß→ss). Give fields distinct labels so keys don't\n" +
	"  collide (collisions get a numeric suffix).\n" +
	"- The **first field** is the \"title field\": its value labels each submission in\n" +
	"  the entry list. Put the most identifying field first (a name, a date…).\n" +
	"- Don't hand-write entry files. Submissions carry a `notation_entry: true`\n" +
	"  frontmatter flag and are created when someone fills the form in the app.\n" +
	"\n" +
	"## Worked example\n" +
	"\n" +
	"`mkdir standup`, then `create_file standup/_form.md`:\n" +
	"\n" +
	"```\n" +
	"# Daily standup\n" +
	"\n" +
	"Name: ______ [string] (required)\n" +
	"Date: ______ [date] (required)\n" +
	"Mood: ______ [smiley]\n" +
	"Focus today: ______ [select: feature, bug, review, ops]\n" +
	"Blockers? ______ [bool]\n" +
	"Confidence: ______ [slider: 0, 10, 1]\n" +
	"\n" +
	"What did you do?\n" +
	"______ [text]\n" +
	"```\n" +
	"\n" +
	"This yields a form titled \"Daily standup\" with a required name + date, a mood\n" +
	"scale, a single-choice focus dropdown, a yes/no blockers checkbox, a 0–10\n" +
	"confidence slider, and a multi-line notes box.\n"
