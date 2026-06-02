package space

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// FormTemplateName is the file whose presence turns a folder into a Form: the
// folder is rendered as a fillable form, submissions are stored as sibling
// entry files, and the raw files are hidden from the tree. Underscore-prefixed
// so it sorts first and reads as "special" without being a (blocked) dotfile.
const FormTemplateName = "_form.md"

// entryMarker is the frontmatter flag identifying a stored form submission.
const entryMarker = "notation_entry: true"

// FieldType is the data type of a form field, declared in the template via a
// `[type]` tag.
type FieldType string

const (
	FieldString   FieldType = "string"
	FieldText     FieldType = "text"
	FieldInteger  FieldType = "integer"
	FieldNumber   FieldType = "number"
	FieldBool     FieldType = "bool"
	FieldDate     FieldType = "date"
	FieldTime     FieldType = "time"
	FieldDateTime FieldType = "datetime"
	FieldSelect   FieldType = "select"
	FieldEmail    FieldType = "email"
	FieldURL      FieldType = "url"
)

// FormField is one parsed field of a form template.
type FormField struct {
	Key      string    `json:"key"`
	Label    string    `json:"label"`
	Type     FieldType `json:"type"`
	Required bool      `json:"required"`
	Options  []string  `json:"options,omitempty"`
	Default  string    `json:"default,omitempty"`
}

// FormSchema is a parsed `_form.md` template.
type FormSchema struct {
	Title string `json:"title"`
	// TitleField names the field whose value labels each entry (filename slug +
	// list title). Defaults to the first field.
	TitleField string      `json:"title_field"`
	Fields     []FormField `json:"fields"`
}

// FormEntry is one stored submission (metadata + values), reconstructed from an
// entry file's frontmatter.
type FormEntry struct {
	ID        string         `json:"id"`   // filename without extension
	Path      string         `json:"path"` // full slash path under files/
	CreatedAt time.Time      `json:"created_at"`
	Title     string         `json:"title"`
	Values    map[string]any `json:"values"`
}

var (
	ErrNotForm      = errors.New("not a form folder")
	ErrFormInvalid  = errors.New("form submission invalid")
	ErrFormRequired = errors.New("required field missing")
)

// tagRe matches a `[type]` or `[select: a, b, c]` field tag.
var tagRe = regexp.MustCompile(`\[([a-zA-Z]+)(?::\s*([^\]]*))?\]`)

// parenRe matches trailing `(...)` modifier groups (required, default: x).
var parenRe = regexp.MustCompile(`\(([^)]*)\)`)

// underscoreRun matches the `____` blank placeholder.
var underscoreRun = regexp.MustCompile(`_{2,}`)

// ParseFormSchema parses an inline-blanks template: free-form markdown where a
// `[type]` tag turns the line (or the line above, for block fields) into a
// field. The label is the text before the blank/tag; `(required)` /
// `(default: x)` are modifiers; `[select: a, b, c]` carries options.
func ParseFormSchema(md string) FormSchema {
	var schema FormSchema
	seen := map[string]int{}
	prevLabel := ""

	for _, raw := range strings.Split(md, "\n") {
		line := strings.TrimRight(raw, "\r")
		trimmed := strings.TrimSpace(line)

		// First heading becomes the form title.
		if schema.Title == "" && strings.HasPrefix(trimmed, "# ") {
			schema.Title = strings.TrimSpace(trimmed[2:])
			continue
		}

		loc := tagRe.FindStringSubmatchIndex(line)
		if loc == nil {
			// Not a field line. Remember it as the candidate label for a
			// following block-style field (e.g. "Notes:" then a blank line).
			if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
				prevLabel = cleanLabel(trimmed)
			}
			continue
		}

		typ := normalizeType(line[loc[2]:loc[3]])
		var inlineArgs string
		if loc[4] >= 0 {
			inlineArgs = line[loc[4]:loc[5]]
		}

		label := cleanLabel(line[:loc[0]])
		if label == "" {
			label = prevLabel
		}
		prevLabel = ""

		field := FormField{Type: typ, Label: label}

		// Modifiers + select options live in trailing (...) groups and/or the
		// inline `[select: ...]` argument.
		var optionSrc []string
		if inlineArgs != "" {
			optionSrc = splitCSV(inlineArgs)
		}
		for _, pg := range parenRe.FindAllStringSubmatch(line[loc[1]:], -1) {
			for _, tok := range splitCSV(pg[1]) {
				low := strings.ToLower(tok)
				switch {
				case low == "required" || low == "*":
					field.Required = true
				case strings.HasPrefix(low, "default:"):
					field.Default = strings.TrimSpace(tok[len("default:"):])
				default:
					if typ == FieldSelect {
						optionSrc = append(optionSrc, tok)
					}
				}
			}
		}
		if typ == FieldSelect {
			field.Options = optionSrc
		}

		field.Key = uniqueSlug(label, seen)
		schema.Fields = append(schema.Fields, field)
	}

	if len(schema.Fields) > 0 {
		schema.TitleField = schema.Fields[0].Key
	} else {
		// Never marshal a nil slice (→ JSON `null`), which the client would
		// try to iterate and crash on. An empty template yields an empty form.
		schema.Fields = []FormField{}
	}
	if schema.Title == "" {
		schema.Title = "Form"
	}
	return schema
}

func cleanLabel(s string) string {
	s = underscoreRun.ReplaceAllString(s, " ")
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "- ")
	s = strings.TrimPrefix(s, "* ")
	s = strings.TrimRight(s, " :?_")
	return strings.TrimSpace(s)
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func normalizeType(t string) FieldType {
	switch strings.ToLower(strings.TrimSpace(t)) {
	case "string", "str", "line":
		return FieldString
	case "text", "textarea", "multiline", "paragraph":
		return FieldText
	case "integer", "int", "whole":
		return FieldInteger
	case "number", "num", "float", "decimal":
		return FieldNumber
	case "bool", "boolean", "checkbox", "check", "yesno":
		return FieldBool
	case "date":
		return FieldDate
	case "time":
		return FieldTime
	case "datetime", "timestamp":
		return FieldDateTime
	case "select", "choice", "dropdown", "enum", "option":
		return FieldSelect
	case "email", "mail":
		return FieldEmail
	case "url", "link":
		return FieldURL
	default:
		return FieldString
	}
}

// uniqueSlug derives a stable field key from a label, deduplicating collisions.
func uniqueSlug(label string, seen map[string]int) string {
	var b strings.Builder
	prevUnderscore := false
	for _, r := range strings.ToLower(label) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevUnderscore = false
		case r == 'ä':
			b.WriteString("ae")
			prevUnderscore = false
		case r == 'ö':
			b.WriteString("oe")
			prevUnderscore = false
		case r == 'ü':
			b.WriteString("ue")
			prevUnderscore = false
		case r == 'ß':
			b.WriteString("ss")
			prevUnderscore = false
		default:
			if !prevUnderscore && b.Len() > 0 {
				b.WriteByte('_')
				prevUnderscore = true
			}
		}
	}
	key := strings.Trim(b.String(), "_")
	if key == "" {
		key = "field"
	}
	seen[key]++
	if n := seen[key]; n > 1 {
		key = fmt.Sprintf("%s_%d", key, n)
	}
	return key
}
