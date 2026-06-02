package space

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/mail"
	"sort"
	"strconv"
	"strings"
	"time"
)

// formAttachDir is the (non-dotfile, hidden-in-tree) subdirectory inside a form
// folder where uploaded image attachments live, so they travel with the folder
// on export and can be cleaned up when their entry is deleted.
const formAttachDir = "_att"

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
	sanitizeFormImages(clean, schema, folder)
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
	content := renderEntry(schema, clean, ts, folder)
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

		// Array-valued fields (multi-select, image) carry a JSON array of strings.
		if f.Type == FieldMulti || f.Type == FieldImage {
			vals := toStringSlice(raw)
			if f.Type == FieldMulti && len(f.Options) > 0 {
				for i, v := range vals {
					c, ok := canonicalOption(f.Options, v)
					if !ok {
						return nil, fmt.Errorf("%w: %q is not an allowed option for %q", ErrFormInvalid, v, f.Label)
					}
					vals[i] = c
				}
			}
			if len(vals) == 0 {
				if f.Required {
					return nil, fmt.Errorf("%w: %s", ErrFormRequired, f.Label)
				}
				continue
			}
			out[f.Key] = vals
			continue
		}

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
		case FieldSmiley, FieldRating:
			n, err := strconv.ParseInt(sv, 10, 64)
			if err != nil || n < 0 {
				return nil, fmt.Errorf("%w: %q must be a rating", ErrFormInvalid, f.Label)
			}
			max := int64(f.Levels)
			if max <= 0 {
				max = 5
			}
			if n > max {
				n = max
			}
			out[f.Key] = n
		case FieldSlider:
			n, err := strconv.ParseFloat(strings.Replace(sv, ",", ".", 1), 64)
			if err != nil {
				return nil, fmt.Errorf("%w: %q must be a number", ErrFormInvalid, f.Label)
			}
			if f.Min != nil && n < *f.Min {
				n = *f.Min
			}
			if f.Max != nil && n > *f.Max {
				n = *f.Max
			}
			out[f.Key] = sliderNumber(n)
		case FieldButtons, FieldSelect:
			if len(f.Options) > 0 {
				c, ok := canonicalOption(f.Options, sv)
				if !ok {
					return nil, fmt.Errorf("%w: %q is not an allowed option for %q", ErrFormInvalid, sv, f.Label)
				}
				sv = c
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

func renderEntry(schema FormSchema, values map[string]any, ts time.Time, folder string) string {
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
		var cell string
		if f.Type == FieldImage {
			// Embed as entry-relative markdown so the .md is self-contained.
			cell = imageCell(values[f.Key], folder)
		} else {
			cell = cellEscape(displayValue(f, values[f.Key]))
		}
		b.WriteString("| " + cellEscape(f.Label) + " | " + cell + " |\n")
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
	switch f.Type {
	case FieldBool:
		if b, ok := v.(bool); ok {
			if b {
				return "Yes"
			}
			return "No"
		}
	case FieldSmiley:
		return smileyFace(toInt(v))
	case FieldRating:
		return starBar(toInt(v), f.Levels)
	case FieldMulti:
		return strings.Join(toStringSlice(v), ", ")
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

// ---- value helpers for the richer field types ----

// toStringSlice coerces a submitted value into a trimmed, non-empty []string.
// JSON arrays decode to []any; a lone string is treated as a one-element list.
func toStringSlice(raw any) []string {
	var out []string
	switch v := raw.(type) {
	case []any:
		for _, e := range v {
			if e == nil {
				continue
			}
			if s := strings.TrimSpace(fmt.Sprintf("%v", e)); s != "" {
				out = append(out, s)
			}
		}
	case []string:
		for _, e := range v {
			if s := strings.TrimSpace(e); s != "" {
				out = append(out, s)
			}
		}
	case string:
		if s := strings.TrimSpace(v); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// canonicalOption matches v against the declared options case-insensitively and
// returns the option in its declared casing.
func canonicalOption(opts []string, v string) (string, bool) {
	v = strings.TrimSpace(v)
	for _, o := range opts {
		if strings.EqualFold(strings.TrimSpace(o), v) {
			return strings.TrimSpace(o), true
		}
	}
	return "", false
}

// sliderNumber stores an integral slider value as int64 so it renders cleanly.
func sliderNumber(n float64) any {
	if n == float64(int64(n)) {
		return int64(n)
	}
	return n
}

func toInt(v any) int {
	switch n := v.(type) {
	case int64:
		return int(n)
	case int:
		return n
	case float64:
		return int(n)
	case string:
		if i, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
			return i
		}
	}
	return 0
}

var smileyFaces = []string{"😢", "🙁", "😐", "🙂", "😄"}

func smileyFace(n int) string {
	if n < 1 {
		return ""
	}
	if n > len(smileyFaces) {
		n = len(smileyFaces)
	}
	return fmt.Sprintf("%s (%d/%d)", smileyFaces[n-1], n, len(smileyFaces))
}

func starBar(n, levels int) string {
	if levels <= 0 {
		levels = 5
	}
	if n < 0 {
		n = 0
	}
	if n > levels {
		n = levels
	}
	return strings.Repeat("★", n) + strings.Repeat("☆", levels-n) + fmt.Sprintf(" (%d/%d)", n, levels)
}

// imageCell renders an image field's stored paths as entry-relative markdown.
func imageCell(v any, folder string) string {
	paths := toStringSlice(v)
	if len(paths) == 0 {
		return ""
	}
	var parts []string
	for _, p := range paths {
		rel := strings.TrimPrefix(p, folder+"/")
		name := p[strings.LastIndex(p, "/")+1:]
		parts = append(parts, fmt.Sprintf("![%s](%s)", name, rel))
	}
	return strings.Join(parts, " ")
}

// ---- image attachment safety ----

// sanitizeFormImages drops any image-field path that doesn't live inside this
// form folder's attachment dir, so an entry can only reference images uploaded
// for it (never an arbitrary file). Mutates and returns values.
func sanitizeFormImages(values map[string]any, schema FormSchema, folder string) map[string]any {
	prefix := folder + "/" + formAttachDir + "/"
	for _, f := range schema.Fields {
		if f.Type != FieldImage {
			continue
		}
		raw, ok := values[f.Key]
		if !ok {
			continue
		}
		kept := make([]string, 0)
		for _, p := range toStringSlice(raw) {
			if strings.HasPrefix(p, prefix) && !strings.Contains(p, "..") {
				kept = append(kept, p)
			}
		}
		if len(kept) == 0 {
			delete(values, f.Key)
		} else {
			values[f.Key] = kept
		}
	}
	return values
}

// entryImagePaths returns the in-folder attachment paths an entry references.
func entryImagePaths(schema FormSchema, values map[string]any, folder string) []string {
	prefix := folder + "/" + formAttachDir + "/"
	var out []string
	for _, f := range schema.Fields {
		if f.Type != FieldImage {
			continue
		}
		for _, p := range toStringSlice(values[f.Key]) {
			if strings.HasPrefix(p, prefix) && !strings.Contains(p, "..") {
				out = append(out, p)
			}
		}
	}
	return out
}

// ---- entry edit / delete ----

// validEntryID guards an entry ID (filename stem) against path tricks before it
// is joined into the form folder.
func validEntryID(id string) bool {
	if id == "" || strings.ContainsAny(id, "/\\") || strings.Contains(id, "..") || strings.HasPrefix(id, ".") {
		return false
	}
	return true
}

// resolveFormEntry locates an entry file by ID within a form folder and parses
// it. It rejects IDs that try to escape the folder or name a non-entry file.
func (s *Store) resolveFormEntry(spaceID, folder, entryID string) (string, FormEntry, error) {
	if !validEntryID(entryID) {
		return "", FormEntry{}, ErrFormInvalid
	}
	path := folder + "/" + entryID + ".md"
	data, err := s.ReadFile(spaceID, path)
	if err != nil {
		return "", FormEntry{}, err
	}
	e, ok := parseEntry(path, data)
	if !ok {
		return "", FormEntry{}, ErrNotForm
	}
	return path, e, nil
}

// GetFormEntry returns a single stored entry with its derived title.
func (s *Store) GetFormEntry(spaceID, folder, entryID string, schema FormSchema) (FormEntry, error) {
	_, e, err := s.resolveFormEntry(spaceID, folder, entryID)
	if err != nil {
		return FormEntry{}, err
	}
	e.Title = entryTitle(schema, e.Values, e.ID)
	return e, nil
}

// UpdateFormEntry re-validates values and rewrites an existing entry in place,
// preserving its created_at and cleaning up any images it no longer references.
func (s *Store) UpdateFormEntry(spaceID, folder, entryID string, schema FormSchema, in map[string]any, now time.Time, maxBytes int64) (FormEntry, error) {
	path, old, err := s.resolveFormEntry(spaceID, folder, entryID)
	if err != nil {
		return FormEntry{}, err
	}
	clean, err := validateFormValues(schema, in)
	if err != nil {
		return FormEntry{}, err
	}
	sanitizeFormImages(clean, schema, folder)
	created := old.CreatedAt
	if created.IsZero() {
		created = now.UTC()
	}
	content := renderEntry(schema, clean, created, folder)
	if _, err := s.WriteFile(spaceID, path, strings.NewReader(content), maxBytes); err != nil {
		return FormEntry{}, err
	}
	s.deleteRemovedImages(spaceID, folder, schema, old.Values, clean)
	return FormEntry{
		ID:        entryID,
		Path:      path,
		CreatedAt: created,
		Title:     entryTitle(schema, clean, entryID),
		Values:    clean,
	}, nil
}

// DeleteFormEntry removes an entry file and (best-effort) its uploaded images.
func (s *Store) DeleteFormEntry(spaceID, folder, entryID string, schema FormSchema) error {
	path, old, err := s.resolveFormEntry(spaceID, folder, entryID)
	if err != nil {
		return err
	}
	if err := s.DeleteFile(spaceID, path); err != nil {
		return err
	}
	for _, p := range entryImagePaths(schema, old.Values, folder) {
		_ = s.DeleteFile(spaceID, p)
	}
	return nil
}

func (s *Store) deleteRemovedImages(spaceID, folder string, schema FormSchema, oldV, newV map[string]any) {
	keep := map[string]bool{}
	for _, p := range entryImagePaths(schema, newV, folder) {
		keep[p] = true
	}
	for _, p := range entryImagePaths(schema, oldV, folder) {
		if !keep[p] {
			_ = s.DeleteFile(spaceID, p)
		}
	}
}

// ---- image upload ----

// SaveFormImage writes an uploaded image into a form folder's attachment dir
// under a server-generated random name and returns its slash path under files/.
func (s *Store) SaveFormImage(spaceID, folder string, data []byte, ext string, maxBytes int64) (string, error) {
	if !s.IsFormFolder(spaceID, folder) {
		return "", ErrNotForm
	}
	name, err := randomName(ext)
	if err != nil {
		return "", err
	}
	path := folder + "/" + formAttachDir + "/" + name
	if _, err := s.WriteFile(spaceID, path, bytes.NewReader(data), maxBytes); err != nil {
		return "", err
	}
	return path, nil
}

func randomName(ext string) (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]) + "." + ext, nil
}
