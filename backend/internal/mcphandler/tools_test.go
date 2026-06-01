package mcphandler

import (
	"regexp"
	"testing"
)

func TestReplaceN(t *testing.T) {
	cases := []struct {
		name    string
		pattern string // already-built RE2 source (as dispatch would build it)
		src     string
		repl    string
		literal bool
		limit   int
		wantOut string
		wantN   int
	}{
		{
			name:    "literal all",
			pattern: regexp.QuoteMeta("foo"),
			src:     "foo bar foo baz foo",
			repl:    "X",
			literal: true,
			limit:   0,
			wantOut: "X bar X baz X",
			wantN:   3,
		},
		{
			name:    "literal limited count",
			pattern: regexp.QuoteMeta("foo"),
			src:     "foo foo foo",
			repl:    "X",
			literal: true,
			limit:   2,
			wantOut: "X X foo",
			wantN:   2,
		},
		{
			name:    "literal metachars are quoted",
			pattern: regexp.QuoteMeta("a.b"),
			src:     "a.b axb a.b",
			repl:    "Z",
			literal: true,
			limit:   0,
			wantOut: "Z axb Z",
			wantN:   2,
		},
		{
			name:    "literal deletion (empty replacement)",
			pattern: regexp.QuoteMeta("--"),
			src:     "a--b--c",
			repl:    "",
			literal: true,
			limit:   0,
			wantOut: "abc",
			wantN:   2,
		},
		{
			name:    "regex capture groups",
			pattern: `(\w+)@(\w+)`,
			src:     "ping alice@host and bob@host",
			repl:    "$2:$1",
			literal: false,
			limit:   0,
			wantOut: "ping host:alice and host:bob",
			wantN:   2,
		},
		{
			name:    "regex literal-dollar in literal mode is not expanded",
			pattern: regexp.QuoteMeta("price"),
			src:     "price is price",
			repl:    "$1",
			literal: true,
			limit:   0,
			wantOut: "$1 is $1",
			wantN:   2,
		},
		{
			name:    "case-insensitive via inline flag",
			pattern: `(?i)` + regexp.QuoteMeta("todo"),
			src:     "TODO Todo todo",
			repl:    "done",
			literal: true,
			limit:   0,
			wantOut: "done done done",
			wantN:   3,
		},
		{
			name:    "no match leaves source untouched",
			pattern: regexp.QuoteMeta("zzz"),
			src:     "nothing here",
			repl:    "x",
			literal: true,
			limit:   0,
			wantOut: "nothing here",
			wantN:   0,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			re := regexp.MustCompile(c.pattern)
			out, n := replaceN(re, c.src, c.repl, c.literal, c.limit)
			if n != c.wantN {
				t.Errorf("count = %d, want %d", n, c.wantN)
			}
			if out != c.wantOut {
				t.Errorf("out = %q, want %q", out, c.wantOut)
			}
		})
	}
}
