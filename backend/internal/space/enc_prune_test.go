package space

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"sync"
	"testing"
)

// frameOp builds a sealed-op envelope with the given cleartext Lamport in its
// framing meta (uint32-BE metaLen || meta JSON || ciphertext). The server only
// peeks the Lamport for prune safety and never decrypts, so a fake ciphertext is
// fine here — this mirrors exactly what the client's encodeEnvelope emits.
func frameOp(lamport int64) []byte {
	meta := fmt.Sprintf(`{"opId":"%016x","lamport":%d,"actorId":"dev"}`, lamport, lamport)
	out := make([]byte, 4+len(meta)+3)
	binary.BigEndian.PutUint32(out[:4], uint32(len(meta)))
	copy(out[4:], meta)
	copy(out[4+len(meta):], []byte{0xAA, 0xBB, 0xCC})
	return out
}

// appendLamports appends one op per Lamport value (seq follows 1..N) and returns
// the assigned seqs. Lamport[i] is the framing Lamport of the op at seq i+1.
func appendLamports(t *testing.T, s *Store, spaceID string, lamports ...int64) {
	t.Helper()
	for i, lam := range lamports {
		opID := fmt.Sprintf("%016x", i+1)
		if _, err := s.AppendOp(spaceID, opID, frameOp(lam), encMax); err != nil {
			t.Fatalf("AppendOp #%d: %v", i, err)
		}
	}
}

// withMargin temporarily lowers the causal-stability margin for a test.
func withMargin(t *testing.T, m int64) {
	t.Helper()
	prev := PruneLamportMargin
	PruneLamportMargin = m
	t.Cleanup(func() { PruneLamportMargin = prev })
}

func prunableSpace(t *testing.T) (*Store, string) {
	t.Helper()
	s := newEncStore(t)
	if _, err := s.CreateEncrypted("spc", "spc", "admin"); err != nil {
		t.Fatal(err)
	}
	// A latest checkpoint must exist for a prune to be allowed at all.
	if err := s.WriteCheckpoint("spc", bytes.NewReader([]byte("cp")), encMax); err != nil {
		t.Fatal(err)
	}
	return s, "spc"
}

// TestPruneHappyPath: a clean cut with ample margin deletes the prefix, installs
// the base, advances the floor, and leaves only the retained ops served.
func TestPruneHappyPath(t *testing.T) {
	withMargin(t, 5)
	s, id := prunableSpace(t)
	// Lamports 1..20 at seqs 1..20 (strictly increasing → any cut is clean).
	lams := make([]int64, 20)
	for i := range lams {
		lams[i] = int64(i + 1)
	}
	appendLamports(t, s, id, lams...)

	base := []byte("prune-base-checkpoint")
	floor, err := s.PruneOps(id, 10, base, encMax)
	if err != nil {
		t.Fatalf("PruneOps: %v", err)
	}
	if floor != 10 {
		t.Fatalf("floor = %d, want 10", floor)
	}

	got, err := s.ReadOpsFloor(id)
	if err != nil || got != 10 {
		t.Fatalf("ReadOpsFloor = %d, %v; want 10", got, err)
	}
	gotBase, err := s.ReadCheckpointBase(id)
	if err != nil || !bytes.Equal(gotBase, base) {
		t.Fatalf("ReadCheckpointBase = %q, %v; want %q", gotBase, err, base)
	}
	// Only the retained suffix survives, contiguous from seq 11.
	ops, err := s.ListOps(id, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(ops) != 10 {
		t.Fatalf("ListOps(0) after prune = %d ops, want 10", len(ops))
	}
	for i, op := range ops {
		if op.Seq != int64(11+i) {
			t.Fatalf("retained op[%d].Seq = %d, want %d", i, op.Seq, 11+i)
		}
	}
}

// TestPruneRefusesInsufficientMargin: the pruned prefix must sit MARGIN below the
// frontier; otherwise the prune is a no-op (the client retries later).
func TestPruneRefusesInsufficientMargin(t *testing.T) {
	withMargin(t, 100)
	s, id := prunableSpace(t)
	// Frontier only 20; pruning up to Lamport 10 leaves margin 10 < 100 → refuse.
	lams := make([]int64, 20)
	for i := range lams {
		lams[i] = int64(i + 1)
	}
	appendLamports(t, s, id, lams...)

	floor, err := s.PruneOps(id, 10, []byte("base"), encMax)
	if err != nil {
		t.Fatalf("PruneOps: %v", err)
	}
	if floor != 0 {
		t.Fatalf("floor = %d, want 0 (refused)", floor)
	}
	if _, err := s.ReadCheckpointBase(id); err == nil {
		t.Fatalf("a refused prune must NOT write the base checkpoint")
	}
	if ops, _ := s.ListOps(id, 0); len(ops) != 20 {
		t.Fatalf("a refused prune must delete nothing; got %d ops, want 20", len(ops))
	}
}

// TestPruneRefusesUncleanCut: if a retained op (seq>upTo) has a Lamport at/below
// the pruned prefix's max, the cut is not clean and the prune is refused — this
// is exactly the concurrent stale-writer case that must NOT be pruned across.
func TestPruneRefusesUncleanCut(t *testing.T) {
	withMargin(t, 2)
	s, id := prunableSpace(t)
	// seqs 1..10 have Lamports 1..10; seq 11 is a STALE op with Lamport 5 (<= max
	// pruned Lamport 10 for upTo=10). Frontier is 100 (seq 12) so margin is fine —
	// the refusal must come from the clean-cut check alone.
	lams := []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 5, 100}
	appendLamports(t, s, id, lams...)

	floor, err := s.PruneOps(id, 10, []byte("base"), encMax)
	if err != nil {
		t.Fatalf("PruneOps: %v", err)
	}
	if floor != 0 {
		t.Fatalf("floor = %d, want 0 (unclean cut must be refused)", floor)
	}
	if ops, _ := s.ListOps(id, 0); len(ops) != 12 {
		t.Fatalf("unclean-cut refusal must delete nothing; got %d ops, want 12", len(ops))
	}
}

// TestPruneRefusesWithoutCheckpoint: no durable latest checkpoint → nothing to
// seed a reload from → refuse.
func TestPruneRefusesWithoutCheckpoint(t *testing.T) {
	withMargin(t, 2)
	s := newEncStore(t)
	if _, err := s.CreateEncrypted("spc", "spc", "admin"); err != nil {
		t.Fatal(err)
	}
	appendLamports(t, s, "spc", 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
	floor, err := s.PruneOps("spc", 5, []byte("base"), encMax)
	if err != nil {
		t.Fatalf("PruneOps: %v", err)
	}
	if floor != 0 {
		t.Fatalf("floor = %d, want 0 (no checkpoint → refuse)", floor)
	}
	if ops, _ := s.ListOps("spc", 0); len(ops) != 10 {
		t.Fatalf("refusal must delete nothing; got %d ops, want 10", len(ops))
	}
}

// TestPruneStaleIsNoOp: a request at/below the current floor is a no-op that does
// not overwrite the (newer) base with an older one.
func TestPruneStaleIsNoOp(t *testing.T) {
	withMargin(t, 2)
	s, id := prunableSpace(t)
	lams := make([]int64, 30)
	for i := range lams {
		lams[i] = int64(i + 1)
	}
	appendLamports(t, s, id, lams...)

	if floor, err := s.PruneOps(id, 20, []byte("base-20"), encMax); err != nil || floor != 20 {
		t.Fatalf("first prune floor = %d, %v; want 20", floor, err)
	}
	// A stale prune at 10 (<= floor 20) must be rejected without touching base.
	if floor, err := s.PruneOps(id, 10, []byte("base-10-STALE"), encMax); err != nil || floor != 20 {
		t.Fatalf("stale prune floor = %d, %v; want 20 (unchanged)", floor, err)
	}
	if got, _ := s.ReadCheckpointBase(id); !bytes.Equal(got, []byte("base-20")) {
		t.Fatalf("stale prune overwrote the base: got %q, want %q", got, "base-20")
	}
}

// TestPruneConcurrentWithAppends is the core no-loss invariant under contention:
// appends running concurrently with a prune must never lose a retained op nor
// have one of their (higher-seq) entries deleted.
func TestPruneConcurrentWithAppends(t *testing.T) {
	withMargin(t, 5)
	s, id := prunableSpace(t)
	// Seed a prunable prefix: Lamports 1..50 at seqs 1..50.
	lams := make([]int64, 50)
	for i := range lams {
		lams[i] = int64(i + 1)
	}
	appendLamports(t, s, id, lams...)

	var wg sync.WaitGroup
	// 50 concurrent appends, all with HIGH Lamports (well above the pruned prefix)
	// so they can never be mistaken for the pruned region.
	const extra = 50
	wg.Add(extra)
	for i := 0; i < extra; i++ {
		go func(i int) {
			defer wg.Done()
			opID := fmt.Sprintf("f%015x", i)
			_, _ = s.AppendOp(id, opID, frameOp(1000+int64(i)), encMax)
		}(i)
	}
	// Concurrently prune the low prefix.
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = s.PruneOps(id, 25, []byte("base"), encMax)
	}()
	wg.Wait()

	floor, _ := s.ReadOpsFloor(id)
	ops, err := s.ListOps(id, 0)
	if err != nil {
		t.Fatal(err)
	}
	// Whatever the interleaving: every op still on disk has seq>floor, the seqs are
	// strictly ascending (no duplicates), and the 50 high-Lamport appends all
	// survived (none deleted). Retained low ops = 50-floor.
	seen := map[int64]bool{}
	high := 0
	for _, op := range ops {
		if op.Seq <= floor {
			t.Fatalf("op seq %d <= floor %d survived the prune", op.Seq, floor)
		}
		if seen[op.Seq] {
			t.Fatalf("duplicate seq %d", op.Seq)
		}
		seen[op.Seq] = true
		if lam, ok := peekOpLamport(op.Blob); ok && lam >= 1000 {
			high++
		}
	}
	if high != extra {
		t.Fatalf("lost concurrent appends: %d of %d high-Lamport ops survived", high, extra)
	}
	// The final total must be exactly the retained low ops + all appends.
	wantLow := 50 - int(floor)
	if len(ops) != wantLow+extra {
		t.Fatalf("op count = %d, want %d (retained low %d + appends %d)", len(ops), wantLow+extra, wantLow, extra)
	}
}

// TestReadOpsFloorDefaultZero: a never-pruned space reports floor 0.
func TestReadOpsFloorDefaultZero(t *testing.T) {
	s, id := prunableSpace(t)
	if floor, err := s.ReadOpsFloor(id); err != nil || floor != 0 {
		t.Fatalf("ReadOpsFloor on fresh space = %d, %v; want 0", floor, err)
	}
}
