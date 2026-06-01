package mcphandler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strings"

	"github.com/yoogie27/notation/internal/gitrepo"
	"github.com/yoogie27/notation/internal/space"
)

func (s *Server) toolDefs() []toolDef {
	return []toolDef{
		{
			Name:        "list_files",
			Description: "Return a flat list of files in the Space, with size and modtime. Useful for getting an overview.",
			InputSchema: schemaObject(
				prop("directory", "string", "Optional subdirectory (slash-delimited, e.g. 'notes/'). Defaults to the Space root."),
			),
		},
		{
			Name:        "get_tree",
			Description: "Return the full nested directory tree of the Space as JSON.",
			InputSchema: schemaObject(),
		},
		{
			Name:        "read_file",
			Description: "Read the contents of a file. Path is slash-delimited, relative to the Space's files/ root.",
			InputSchema: schemaObject(requiredProp("path", "string", "Path to the file, e.g. 'notes/today.md'.")),
		},
		{
			Name:        "write_file",
			Description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
			InputSchema: schemaObject(
				requiredProp("path", "string", "Path to the file."),
				requiredProp("content", "string", "Full new content."),
			),
		},
		{
			Name:        "create_file",
			Description: "Create a new file. Fails if the file already exists. Use write_file to overwrite.",
			InputSchema: schemaObject(
				requiredProp("path", "string", "Path to the file."),
				requiredProp("content", "string", "Initial content."),
			),
		},
		{
			Name:        "replace_in_file",
			Description: "Find-and-replace inside a single text file (sed-style), without rewriting the whole file. Literal match by default; set regex=true for Go (RE2) regular expressions with $1/${name} capture refs in the replacement. RE2 has no catastrophic backtracking, so patterns are safe. Returns the number of replacements and only writes (and commits) when there's at least one match — a no-match call changes nothing. Refuses binary files.",
			InputSchema: schemaObject(
				requiredProp("path", "string", "Path to the file."),
				requiredProp("find", "string", "Text to search for (literal, or a Go regex when regex=true)."),
				requiredProp("replace", "string", "Replacement text. With regex=true, $1 / ${name} expand capture groups; literal mode inserts it verbatim. May be empty to delete matches."),
				prop("regex", "boolean", "Treat `find` as a Go (RE2) regex. Default false (literal)."),
				prop("case_sensitive", "boolean", "Default true."),
				prop("count", "number", "Max replacements (from the start). 0 or omitted = replace all."),
				prop("dry_run", "boolean", "If true, report how many matches would change without writing. Default false."),
			),
		},
		{
			Name:        "delete_file",
			Description: "Delete a file or empty directory.",
			InputSchema: schemaObject(requiredProp("path", "string", "Path to the file or directory.")),
		},
		{
			Name:        "rename_file",
			Description: "Rename or move a file. Creates parent dirs of the target as needed.",
			InputSchema: schemaObject(
				requiredProp("from", "string", "Current path."),
				requiredProp("to", "string", "New path."),
			),
		},
		{
			Name:        "mkdir",
			Description: "Create an empty directory (and any missing parents).",
			InputSchema: schemaObject(requiredProp("path", "string", "Directory path.")),
		},
		{
			Name:        "search",
			Description: "Substring search across all files (case-insensitive). Simpler than `grep` — use `grep` when you need regex, context lines, or precise glob filtering.",
			InputSchema: schemaObject(
				requiredProp("query", "string", "Substring to search for."),
				prop("glob", "string", "Optional glob filter, e.g. '*.md' (single-segment only)."),
				prop("max_results", "number", "Maximum matches to return (default 200)."),
			),
		},
		{
			Name:        "grep",
			Description: "Ripgrep-style regex search. Supports Go regex syntax, case-insensitive by default, optional context lines, and full ** glob filtering. Returns path, line, content, and the requested before/after context.",
			InputSchema: schemaObject(
				requiredProp("pattern", "string", "Go regex pattern. Use anchors and groups as needed."),
				prop("glob", "string", "Optional file filter. Supports '**' (any depth), '*' (segment), '?'. E.g. '**/*.md', 'notes/**'."),
				prop("case_sensitive", "boolean", "Default false."),
				prop("context_before", "number", "Lines of context before each match (default 0, max 50)."),
				prop("context_after", "number", "Lines of context after each match (default 0, max 50)."),
				prop("max_results", "number", "Maximum matches (default 200, max 1000)."),
			),
		},
		{
			Name:        "glob",
			Description: "List files in the Space whose paths match a glob. Returns slash-delimited paths relative to the files root.",
			InputSchema: schemaObject(
				requiredProp("pattern", "string", "Glob pattern. '**' matches any depth, '*' a single segment. E.g. '**/*.md', 'notes/*'."),
				prop("max_results", "number", "Maximum paths to return (default 1000, max 5000)."),
			),
		},
		{
			Name:        "outline",
			Description: "Return the heading outline (level, text, line) of a markdown file. Useful for picking the right read_file range before fetching content.",
			InputSchema: schemaObject(
				requiredProp("path", "string", "File path."),
			),
		},
		{
			Name:        "git_log",
			Description: "Return recent commits for the Space (latest first).",
			InputSchema: schemaObject(prop("limit", "number", "Maximum commits to return (default 50, max 500).")),
		},
		{
			Name:        "git_diff",
			Description: "Return the unified diff of a specific commit hash.",
			InputSchema: schemaObject(requiredProp("hash", "string", "Commit hash (7-40 hex chars).")),
		},
	}
}

func schemaObject(props ...map[string]any) map[string]any {
	properties := map[string]any{}
	required := []string{}
	for _, p := range props {
		name, _ := p["__name"].(string)
		req, _ := p["__required"].(bool)
		delete(p, "__name")
		delete(p, "__required")
		properties[name] = p
		if req {
			required = append(required, name)
		}
	}
	out := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		out["required"] = required
	}
	return out
}

func prop(name, typ, desc string) map[string]any {
	return map[string]any{"__name": name, "type": typ, "description": desc}
}

func requiredProp(name, typ, desc string) map[string]any {
	return map[string]any{"__name": name, "__required": true, "type": typ, "description": desc}
}

// dispatchTool routes a tool call to the right implementation.
func (s *Server) dispatchTool(_ context.Context, spaceID, tokenID, name string, args map[string]any) (*toolResult, error) {
	pathArg := stringArg(args, "path")
	var actionPath = pathArg

	defer func() {
		// audit happens in each branch where we know the err state — see callers.
		_ = actionPath
	}()

	switch name {
	case "list_files":
		dir := stringArg(args, "directory")
		entries, err := s.store.Tree(spaceID)
		if err != nil {
			s.auditCall(spaceID, tokenID, "mcp.list_files", dir, err)
			return errResult(err.Error()), nil
		}
		flat := flatten(entries, "")
		if dir != "" {
			prefix := strings.TrimRight(dir, "/") + "/"
			filtered := flat[:0]
			for _, e := range flat {
				if strings.HasPrefix(e["path"].(string), prefix) {
					filtered = append(filtered, e)
				}
			}
			flat = filtered
		}
		s.auditCall(spaceID, tokenID, "mcp.list_files", dir, nil)
		return jsonResult(flat)

	case "get_tree":
		entries, err := s.store.Tree(spaceID)
		if err != nil {
			s.auditCall(spaceID, tokenID, "mcp.get_tree", "", err)
			return errResult(err.Error()), nil
		}
		s.auditCall(spaceID, tokenID, "mcp.get_tree", "", nil)
		return jsonResult(entries)

	case "read_file":
		if pathArg == "" {
			return errResult("path required"), nil
		}
		data, err := s.store.ReadFile(spaceID, pathArg)
		s.auditCall(spaceID, tokenID, "mcp.read_file", pathArg, err)
		if err != nil {
			return errResult(err.Error()), nil
		}
		return textResult(string(data)), nil

	case "write_file":
		content := stringArg(args, "content")
		if pathArg == "" {
			return errResult("path required"), nil
		}
		if _, err := s.store.WriteFile(spaceID, pathArg, strings.NewReader(content), s.cfg.MaxUploadBytes); err != nil {
			s.auditCall(spaceID, tokenID, "mcp.write_file", pathArg, err)
			return errResult(err.Error()), nil
		}
		s.scheduleCommit(spaceID, tokenID)
		s.auditCall(spaceID, tokenID, "mcp.write_file", pathArg, nil)
		return textResult("wrote " + pathArg), nil

	case "create_file":
		content := stringArg(args, "content")
		if pathArg == "" {
			return errResult("path required"), nil
		}
		if _, err := s.store.Stat(spaceID, pathArg); err == nil {
			return errResult("file already exists"), nil
		} else if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, space.ErrPathEscape) && !errors.Is(err, space.ErrPathDot) {
			// existence check itself failed for unexpected reasons
			s.auditCall(spaceID, tokenID, "mcp.create_file", pathArg, err)
			return errResult(err.Error()), nil
		}
		if _, err := s.store.WriteFile(spaceID, pathArg, strings.NewReader(content), s.cfg.MaxUploadBytes); err != nil {
			s.auditCall(spaceID, tokenID, "mcp.create_file", pathArg, err)
			return errResult(err.Error()), nil
		}
		s.scheduleCommit(spaceID, tokenID)
		s.auditCall(spaceID, tokenID, "mcp.create_file", pathArg, nil)
		return textResult("created " + pathArg), nil

	case "replace_in_file":
		if pathArg == "" {
			return errResult("path required"), nil
		}
		find := stringArg(args, "find")
		if find == "" {
			return errResult("find required"), nil
		}
		replacement := stringArg(args, "replace")
		useRegex := boolArg(args, "regex")
		caseSensitive := true
		if _, ok := args["case_sensitive"]; ok {
			caseSensitive = boolArg(args, "case_sensitive")
		}
		limit := intArg(args, "count", 0)
		dryRun := boolArg(args, "dry_run")

		// Guard the pattern size — RE2 is linear-time (no ReDoS), but an
		// enormous pattern is still pointless and a cheap thing to bound.
		if len(find) > 4096 {
			return errResult("find pattern too long (max 4096 chars)"), nil
		}

		// Build an RE2 matcher. Literal mode quotes the needle so regex
		// metacharacters in `find` are matched verbatim; the only difference
		// from regex mode is that the replacement is inserted literally rather
		// than expanding $-references.
		pat := find
		if !useRegex {
			pat = regexp.QuoteMeta(find)
		}
		if !caseSensitive {
			pat = "(?i)" + pat
		}
		re, err := regexp.Compile(pat)
		if err != nil {
			return errResult("invalid regex: " + err.Error()), nil
		}

		data, err := s.store.ReadFile(spaceID, pathArg)
		if err != nil {
			s.auditCall(spaceID, tokenID, "mcp.replace_in_file", pathArg, err)
			return errResult(err.Error()), nil
		}
		// Never rewrite a binary blob — a stray match would corrupt it.
		if bytes.IndexByte(data, 0) >= 0 {
			return errResult("refusing to edit a binary file"), nil
		}

		out, n := replaceN(re, string(data), replacement, !useRegex, limit)
		if n == 0 {
			s.auditCall(spaceID, tokenID, "mcp.replace_in_file", pathArg, nil)
			return textResult("0 replacements — no match for `" + find + "` in " + pathArg), nil
		}
		if dryRun {
			return textResult(fmt.Sprintf("dry run: %d replacement(s) would be made in %s", n, pathArg)), nil
		}
		if _, err := s.store.WriteFile(spaceID, pathArg, strings.NewReader(out), s.cfg.MaxUploadBytes); err != nil {
			s.auditCall(spaceID, tokenID, "mcp.replace_in_file", pathArg, err)
			return errResult(err.Error()), nil
		}
		s.scheduleCommit(spaceID, tokenID)
		s.auditCall(spaceID, tokenID, "mcp.replace_in_file", pathArg, nil)
		return textResult(fmt.Sprintf("replaced %d occurrence(s) in %s", n, pathArg)), nil

	case "delete_file":
		if pathArg == "" {
			return errResult("path required"), nil
		}
		err := s.store.DeleteFile(spaceID, pathArg)
		s.auditCall(spaceID, tokenID, "mcp.delete_file", pathArg, err)
		if err != nil {
			return errResult(err.Error()), nil
		}
		s.scheduleCommit(spaceID, tokenID)
		return textResult("deleted " + pathArg), nil

	case "rename_file":
		from := stringArg(args, "from")
		to := stringArg(args, "to")
		if from == "" || to == "" {
			return errResult("from and to are required"), nil
		}
		err := s.store.RenameFile(spaceID, from, to)
		s.auditCall(spaceID, tokenID, "mcp.rename_file", from+" -> "+to, err)
		if err != nil {
			return errResult(err.Error()), nil
		}
		s.scheduleCommit(spaceID, tokenID)
		return textResult("renamed " + from + " -> " + to), nil

	case "mkdir":
		if pathArg == "" {
			return errResult("path required"), nil
		}
		err := s.store.Mkdir(spaceID, pathArg)
		s.auditCall(spaceID, tokenID, "mcp.mkdir", pathArg, err)
		if err != nil {
			return errResult(err.Error()), nil
		}
		return textResult("mkdir " + pathArg), nil

	case "search":
		query := stringArg(args, "query")
		glob := stringArg(args, "glob")
		max := intArg(args, "max_results", 200)
		matches, err := s.store.Search(spaceID, query, glob, max)
		s.auditCall(spaceID, tokenID, "mcp.search", query, err)
		if err != nil {
			return errResult(err.Error()), nil
		}
		return jsonResult(matches)

	case "grep":
		pattern := stringArg(args, "pattern")
		if pattern == "" {
			return errResult("pattern required"), nil
		}
		matches, err := s.store.Grep(spaceID, space.GrepOpts{
			Pattern:       pattern,
			Glob:          stringArg(args, "glob"),
			CaseSensitive: boolArg(args, "case_sensitive"),
			ContextBefore: intArg(args, "context_before", 0),
			ContextAfter:  intArg(args, "context_after", 0),
			MaxResults:    intArg(args, "max_results", 200),
		})
		s.auditCall(spaceID, tokenID, "mcp.grep", pattern, err)
		if err != nil {
			return errResult(err.Error()), nil
		}
		return jsonResult(matches)

	case "glob":
		pattern := stringArg(args, "pattern")
		if pattern == "" {
			return errResult("pattern required"), nil
		}
		max := intArg(args, "max_results", 1000)
		paths, err := s.store.Glob(spaceID, pattern, max)
		s.auditCall(spaceID, tokenID, "mcp.glob", pattern, err)
		if err != nil {
			return errResult(err.Error()), nil
		}
		return jsonResult(paths)

	case "outline":
		if pathArg == "" {
			return errResult("path required"), nil
		}
		outline, err := s.store.Outline(spaceID, pathArg)
		s.auditCall(spaceID, tokenID, "mcp.outline", pathArg, err)
		if err != nil {
			return errResult(err.Error()), nil
		}
		return jsonResult(outline)

	case "git_log":
		limit := intArg(args, "limit", 50)
		commits, err := s.git.Log(spaceID, limit)
		s.auditCall(spaceID, tokenID, "mcp.git_log", "", err)
		if err != nil {
			return errResult(err.Error()), nil
		}
		return jsonResult(commits)

	case "git_diff":
		hash := stringArg(args, "hash")
		if hash == "" {
			return errResult("hash required"), nil
		}
		diff, err := s.git.Diff(spaceID, hash)
		s.auditCall(spaceID, tokenID, "mcp.git_diff", hash, err)
		if err != nil {
			return errResult(err.Error()), nil
		}
		return textResult(diff), nil

	default:
		return nil, fmt.Errorf("%w: %s", ErrUnknownTool, name)
	}
}

// replaceN rewrites up to `limit` matches of re in src (limit <= 0 means all).
// When literal is true the replacement is inserted verbatim; otherwise it's
// expanded as a regex template ($1, ${name}). Returns the new string and the
// number of replacements actually made. RE2's linear-time guarantee means this
// can't be driven into catastrophic backtracking.
func replaceN(re *regexp.Regexp, src, repl string, literal bool, limit int) (string, int) {
	matches := re.FindAllStringSubmatchIndex(src, -1)
	if len(matches) == 0 {
		return src, 0
	}
	var b strings.Builder
	last := 0
	n := 0
	for _, m := range matches {
		if limit > 0 && n >= limit {
			break
		}
		b.WriteString(src[last:m[0]])
		if literal {
			b.WriteString(repl)
		} else {
			b.Write(re.ExpandString(nil, repl, src, m))
		}
		last = m[1]
		n++
	}
	b.WriteString(src[last:])
	return b.String(), n
}

func (s *Server) scheduleCommit(spaceID, tokenID string) {
	s.git.Schedule(spaceID, gitrepo.Author{
		Name:  "mcp:" + tokenID,
		Email: tokenID + "@notation.mcp",
	})
}

func stringArg(m map[string]any, key string) string {
	v, _ := m[key].(string)
	return v
}

func intArg(m map[string]any, key string, def int) int {
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	default:
		return def
	}
}

func boolArg(m map[string]any, key string) bool {
	switch v := m[key].(type) {
	case bool:
		return v
	case string:
		return v == "true" || v == "1" || v == "yes"
	case float64:
		return v != 0
	default:
		return false
	}
}

// flatten produces a flat representation of the recursive tree for list_files.
func flatten(entries []space.Entry, prefix string) []map[string]any {
	var out []map[string]any
	for _, e := range entries {
		p := e.Path
		if prefix != "" {
			p = prefix + "/" + e.Name
		}
		if !e.IsDir {
			out = append(out, map[string]any{
				"path":     p,
				"size":     e.Size,
				"modified": e.Modified,
			})
		}
		if e.IsDir && e.Children != nil {
			out = append(out, flatten(e.Children, p)...)
		}
	}
	return out
}
