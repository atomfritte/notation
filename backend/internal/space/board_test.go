package space

import (
	"errors"
	"testing"
)

func TestSetBoardBatch(t *testing.T) {
	st := NewStore(t.TempDir())
	for _, id := range []string{"alpha", "beta", "gamma"} {
		if _, err := st.Create(id, id, "admin"); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}

	err := st.SetBoardBatch([]BoardUpdate{
		{ID: "alpha", Status: "active", Order: 1},
		{ID: "beta", Status: "active", Order: 2},
		{ID: "gamma", Status: "archive", Order: 1},
	})
	if err != nil {
		t.Fatalf("SetBoardBatch: %v", err)
	}

	want := map[string]struct {
		status string
		order  int
	}{
		"alpha": {"active", 1},
		"beta":  {"active", 2},
		"gamma": {"archive", 1},
	}
	for id, exp := range want {
		m, err := st.Get(id)
		if err != nil {
			t.Fatalf("get %s: %v", id, err)
		}
		if m.Status != exp.status || m.Order != exp.order {
			t.Errorf("%s: got status=%q order=%d, want status=%q order=%d", id, m.Status, m.Order, exp.status, exp.order)
		}
		if m.UpdatedAt.Before(m.CreatedAt) {
			t.Errorf("%s: UpdatedAt %v should be >= CreatedAt %v", id, m.UpdatedAt, m.CreatedAt)
		}
	}
}

func TestSetBoardBatchRejectsBadStatus(t *testing.T) {
	st := NewStore(t.TempDir())
	if _, err := st.Create("alpha", "Alpha", "admin"); err != nil {
		t.Fatal(err)
	}
	err := st.SetBoardBatch([]BoardUpdate{{ID: "alpha", Status: "bogus", Order: 1}})
	if !errors.Is(err, ErrInvalidBoard) {
		t.Fatalf("got %v, want ErrInvalidBoard", err)
	}
}

// A batch that references a missing space must fail validation before writing
// anything — the valid sibling in the same batch must stay untouched.
func TestSetBoardBatchAtomicOnMissing(t *testing.T) {
	st := NewStore(t.TempDir())
	if _, err := st.Create("alpha", "Alpha", "admin"); err != nil {
		t.Fatal(err)
	}
	err := st.SetBoardBatch([]BoardUpdate{
		{ID: "alpha", Status: "active", Order: 5},
		{ID: "ghost", Status: "active", Order: 6},
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
	m, err := st.Get("alpha")
	if err != nil {
		t.Fatal(err)
	}
	if m.Status != "" || m.Order != 0 {
		t.Errorf("alpha was mutated despite batch failure: status=%q order=%d", m.Status, m.Order)
	}
}

func TestSetBoardBatchRejectsNegativeOrder(t *testing.T) {
	st := NewStore(t.TempDir())
	if _, err := st.Create("alpha", "Alpha", "admin"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetBoardBatch([]BoardUpdate{{ID: "alpha", Status: "active", Order: -1}}); !errors.Is(err, ErrInvalidBoard) {
		t.Fatalf("got %v, want ErrInvalidBoard", err)
	}
	m, _ := st.Get("alpha")
	if m.Status != "" {
		t.Errorf("alpha mutated despite rejected order: status=%q", m.Status)
	}
}

func TestSetBoardBatchRejectsDuplicateID(t *testing.T) {
	st := NewStore(t.TempDir())
	if _, err := st.Create("alpha", "Alpha", "admin"); err != nil {
		t.Fatal(err)
	}
	err := st.SetBoardBatch([]BoardUpdate{
		{ID: "alpha", Status: "active", Order: 1},
		{ID: "alpha", Status: "backlog", Order: 2},
	})
	if !errors.Is(err, ErrInvalidID) {
		t.Fatalf("got %v, want ErrInvalidID", err)
	}
}

func TestValidBoardStatus(t *testing.T) {
	for _, ok := range []string{"", "inbox", "backlog", "active", "archive"} {
		if !ValidBoardStatus(ok) {
			t.Errorf("ValidBoardStatus(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"done", "todo", "INBOX", "active ", "x"} {
		if ValidBoardStatus(bad) {
			t.Errorf("ValidBoardStatus(%q) = true, want false", bad)
		}
	}
}
