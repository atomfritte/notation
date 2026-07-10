package http

import (
	"testing"

	"github.com/yoogie27/notation/internal/space"
)

func sampleTree() []space.Entry {
	return []space.Entry{
		{Name: "readme.md", Path: "readme.md"},
		{Name: "notes", Path: "notes", IsDir: true, Children: []space.Entry{
			{Name: "a.md", Path: "notes/a.md"},
			{Name: "deep", Path: "notes/deep", IsDir: true, Children: []space.Entry{
				{Name: "b.md", Path: "notes/deep/b.md"},
			}},
		}},
		{Name: "survey", Path: "survey", IsDir: true, Form: true, Entries: 3},
	}
}

func TestScopeTree_EmptyScope_ReturnsAll(t *testing.T) {
	got := scopeTree(sampleTree(), "")
	if len(got) != 3 {
		t.Fatalf("want full tree (3 roots), got %d", len(got))
	}
}

func TestScopeTree_FolderScope_ReturnsChildren(t *testing.T) {
	got := scopeTree(sampleTree(), "notes")
	if len(got) != 2 || got[0].Path != "notes/a.md" || got[1].Path != "notes/deep" {
		t.Fatalf("folder scope should expose the subtree's children, got %+v", got)
	}
}

func TestScopeTree_NestedFileScope_ReturnsSingleNode(t *testing.T) {
	got := scopeTree(sampleTree(), "notes/deep/b.md")
	if len(got) != 1 || got[0].Path != "notes/deep/b.md" || got[0].IsDir {
		t.Fatalf("file scope should expose exactly that file, got %+v", got)
	}
}

// A form folder scope must return the folder node itself (Form=true, children
// hidden) so the reader opens the FormView, not an empty listing.
func TestScopeTree_FormFolderScope_ReturnsNode(t *testing.T) {
	got := scopeTree(sampleTree(), "survey")
	if len(got) != 1 || !got[0].Form || got[0].Path != "survey" {
		t.Fatalf("form scope should expose the form node, got %+v", got)
	}
}

// A deleted/renamed scope target yields an empty tree — never a fallback to
// the whole space.
func TestScopeTree_MissingScope_ReturnsEmpty(t *testing.T) {
	got := scopeTree(sampleTree(), "gone.md")
	if len(got) != 0 {
		t.Fatalf("missing scope must yield empty tree, got %+v", got)
	}
}
