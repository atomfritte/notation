package space

import (
	"encoding/json"
	"fmt"
	"net/mail"
	"sort"
	"strconv"
	"strings"
	"time"
)

// IsFormFolder reports whether folder is a form folder (contains _form.md).
func (s *Store) IsFormFolder(spaceID, folder string) bool {
	if folder == "" {
		return false
	}
	_, err := s.Stat(spaceID, folder+"/"+FormTemplateName)
	return err == nil
}

// FormSchema reads and parses a form folder's template.
func (s *Store) FormSchema(spaceID, folder string) (FormSchema, error) {
	data, err := s.ReadFile(spaceID, folder+"/"+FormTemplateName)
	if err != nil {
		return FormSchema{}, err
	}
	return ParseFormSchema(string(data)), nil
}

// formEntryFiles lists the entry files in a form folder (every .md except the
// template), as slash paths relative to files/.
func (s *Store) formEntryFiles(spaceID, folder string) ([]string, error) {
	rel, err := s.safeRel(spaceID, folder)
	if err != nil {
		return nil, err
	}
	root, err := s.openRoot(spaceID)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	f, err := root.Open(rel)
	if err != nil {
		return nil, err
	}
	items, err := f.ReadDir(-1)
	_ = f.Close()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(items))
	for _, it := range items {
		name := it.Name()
		if it.IsDir() || strings.HasPrefix(name, ".") || name == FormTemplateName || !strings.HasSuffix(name, ".md") {
			continue
		}
		out = append(out, folder+"/"+name)
	}
	return out, nil
}

// ListFormEntries returns every submission in a form folder, newest first, with
// a Title derived from the schema's title field.
func (s *Store) ListFormEntries(spaceID, folder string, schema FormSchema) ([]FormEntry, error) {
	paths, err := s.formEntryFiles(spaceID, folder)
	if err != nil {
		return nil, err
	}
	out := make([]FormEntry, 0, len(paths))
	for _, p := range paths {
		data, err := s.ReadFile(spaceID, p)
		if err != nil {
			continue
		}
		e, ok := parseEntry(p, data)
		if !ok {
			continue
		}
		e.Title = entryTitle(schema, e.Values, e.ID)
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// CreateFormEntry validates values against the schema and writes a new entry
// file with a server-generated, datetime-stamped name. Only declared fields are
// accepted (a submitter can't write arbitrary keys), the filename is never
// caller-controlled, and the path stays inside the form folder — so this is
// safe to expose to share guests.
func (s *Store) CreateFormEntry(spaceID, folder string, schema FormSchema, in map[string]any, now time.Time, maxBytes int64) (FormEntry, error) {
	clean, err := validateFormValues(schema, in)
	if err != nil {
		return FormEntry{}, err
	}
	ts := now.UTC()
	title := entryTitle(schema, clean, "")
	base := ts.Format("2006-01-02_150405")
	if slug := slugForFile(title); slug != "" {
		base += "_" + slug
	}
	name := base + ".md"
	for i := 2; i <= 50; i++ {
		if _, err := s.Stat(spaceID, folder+"/"+name); err != nil {
			break // free name
		}
		name = fmt.Sprintf("%s-%d.md", base, i)
	}
	path := folder + "/" + name
	content := renderEntry(schema, clean, ts)
	if _, err := s.WriteFile(spaceID, path, strings.NewReader(content), maxBytes); err != nil {
		return FormEntry{}, err
	}
	return FormEntry{
		ID:        strings.TrimSuffix(name, ".md"),
		Path:      path,
		CreatedAt: ts,
		Title:     title,
		Values:    clean,
	}, nil
}

// validateFormValues coerces + checks the submitted values against the schema,
// returning a map containing ONLY declared fields with typed values.
func validateFormValues(schema FormSchema, in map[string]any) (map[string]any, error) {
	out := make(map[string]any, len(schema.Fields))
	for _, f := range schema.Fields {
		raw, present := in[f.Key]
		sv := ""
		if present && raw != nil {
			sv = strings.TrimSpace(fmt.Sprintf("%v", raw))
		}
		if sv == "" {
			if f.Required {
				return nil, fmt.Errorf("%w: %s", ErrFormRequired, f.Label)
			}
			continue
		}
		switch f.Type {
		case FieldInteger:
			n, err := strconv.ParseInt(sv, 10, 64)
			if err != nil {
				return nil, fmt.Errorf("%w: %q must be a whole number", ErrFormInvalid, f.Label)
			}
			out[f.Key] = n
		case FieldNumber:
			n, err := strconv.ParseFloat(strings.Replace(sv, ",", ".", 1), 64)
			if err != nil {
				return nil, fmt.Errorf("%w: %q must be a number", ErrFormInvalid, f.Label)
			}
			out[f.Key] = n
		case FieldBool:
			out[f.Key] = parseFormBool(sv)
		case FieldSelect:
			if len(f.Options) > 0 && !containsFold(f.Options, sv) {
				return nil, fmt.Errorf("%w: %q is not an allowed option for %q", ErrFormInvalid, sv, f.Label)
			}
			out[f.Key] = sv
		case FieldDate:
			if _, err := time.Parse("2006-01-02", sv); err != nil {
				return nil, fmt.Errorf("%w: %q must be a date (YYYY-MM-DD)", ErrFormInvalid, f.Label)
			}
			out[f.Key] = sv
		case FieldTime:
			if _, err := time.Parse("15:04", sv); err != nil {
				return nil, fmt.Errorf("%w: %q must be a time (HH:MM)", ErrFormInvalid, f.Label)
			}
			out[f.Key] = sv
		case FieldDateTime:
			if !parseAnyDateTime(sv) {
				return nil, fmt.Errorf("%w: %q must be a date and time", ErrFormInvalid, f.Label)
			}
			out[f.Key] = sv
		case FieldEmail:
			if _, err := mail.ParseAddress(sv); err != nil {
				return nil, fmt.Errorf("%w: %q must be an email address", ErrFormInvalid, f.Label)
			}
			out[f.Key] = sv
		default:
			out[f.Key] = sv
		}
	}
	return out, nil
}

func parseEntry(path string, data []byte) (FormEntry, bool) {
	s := string(data)
	if !strings.HasPrefix(s, "---") {
		return FormEntry{}, false
	}
	rest := s[3:]
	end := strings.Index(rest, "\n---")
	if end < 0 {
		return FormEntry{}, false
	}
	fm := rest[:end]
	if !strings.Contains(fm, entryMarker) {
		return FormEntry{}, false
	}
	e := FormEntry{Path: path, Values: map[string]any{}}
	base := path[strings.LastIndex(path, "/")+1:]
	e.ID = strings.TrimSuffix(base, ".md")
	for _, line := range strings.Split(fm, "\n") {
		line = strings.TrimSpace(line)
		if v, ok := strings.CutPrefix(line, "created_at:"); ok {
			if t, err := time.Parse(time.RFC3339, strings.TrimSpace(v)); err == nil {
				e.CreatedAt = t
			}
		} else if v, ok := strings.CutPrefix(line, "values:"); ok {
			_ = json.Unmarshal([]byte(strings.TrimSpace(v)), &e.Values)
		}
	}
	return e, true
}

func renderEntry(schema FormSchema, values map[string]any, ts time.Time) string {
	vj, _ := json.Marshal(values)
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString(entryMarker + "\n")
	b.WriteString("created_at: " + ts.Format(time.RFC3339) + "\n")
	b.WriteString("values: ")
	b.Write(vj)
	b.WriteString("\n---\n\n")
	b.WriteString("# " + cellEscape(schema.Title) + " — " + ts.Format("2006-01-02 15:04") + "\n\n")
	b.WriteString("| Field | Value |\n|-------|-------|\n")
	for _, f := range schema.Fields {
		b.WriteString("| " + cellEscape(f.Label) + " | " + cellEscape(displayValue(f, values[f.Key])) + " |\n")
	}
	return b.String()
}

func entryTitle(schema FormSchema, values map[string]any, fallback string) string {
	if schema.TitleField != "" {
		if v, ok := values[schema.TitleField]; ok && v != nil {
			if s := strings.TrimSpace(fmt.Sprintf("%v", v)); s != "" {
				return s
			}
		}
	}
	return fallback
}

func displayValue(f FormField, v any) string {
	if v == nil {
		return ""
	}
	if f.Type == FieldBool {
		if b, ok := v.(bool); ok {
			if b {
				return "Yes"
			}
			return "No"
		}
	}
	return fmt.Sprintf("%v", v)
}

func cellEscape(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	return strings.ReplaceAll(s, "|", "\\|")
}

// slugForFile produces a filesystem-safe, hyphenated slug from a title value.
func slugForFile(s string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(s) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevDash = false
		case r == 'ä':
			b.WriteString("ae")
		case r == 'ö':
			b.WriteString("oe")
		case r == 'ü':
			b.WriteString("ue")
		case r == 'ß':
			b.WriteString("ss")
		default:
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 40 {
		out = strings.Trim(out[:40], "-")
	}
	return out
}

func parseFormBool(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "1", "yes", "y", "on", "ja", "x", "checked":
		return true
	default:
		return false
	}
}

func containsFold(opts []string, v string) bool {
	for _, o := range opts {
		if strings.EqualFold(strings.TrimSpace(o), v) {
			return true
		}
	}
	return false
}

func parseAnyDateTime(s string) bool {
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04", "2006-01-02T15:04", "2006-01-02 15:04:05"} {
		if _, err := time.Parse(layout, s); err == nil {
			return true
		}
	}
	return false
}
