package space

import (
	"bytes"
	"errors"
	"io/fs"
	"testing"
)

// sealedRec fakes a client-sealed AES-GCM frame: the server only ever checks
// the 2-byte header and the minimum length, never the ciphertext itself.
func sealedRec(tag byte) []byte {
	b := bytes.Repeat([]byte{tag}, 40)
	b[0], b[1] = 1, 1
	return b
}

const chatA = "0123456789abcdef0123456789abcdef"
const chatB = "fedcba9876543210fedcba9876543210"

func TestChatPlaintextRoundTrip(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.Create("plain", "Plain", "admin"); err != nil {
		t.Fatal(err)
	}
	meta := []byte(`{"title":"Hello"}`)
	body := []byte(`{"messages":[]}`)
	if err := s.WriteChat("plain", chatA, meta, body, 1<<20); err != nil {
		t.Fatalf("WriteChat: %v", err)
	}
	list, err := s.ListChats("plain")
	if err != nil || len(list) != 1 {
		t.Fatalf("ListChats = %v, %v", list, err)
	}
	if list[0].ID != chatA || list[0].Sealed || !bytes.Equal(list[0].Meta, meta) {
		t.Errorf("listing = %+v", list[0])
	}
	got, err := s.ReadChat("plain", chatA, nil)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("ReadChat = %q, %v", got, err)
	}
	if err := s.DeleteChat("plain", chatA); err != nil {
		t.Fatalf("DeleteChat: %v", err)
	}
	if err := s.DeleteChat("plain", chatA); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("second delete = %v, want ErrNotExist", err)
	}
}

// The rule the store exists to enforce: a zero-knowledge Space never holds a
// plaintext chat, and a plaintext Space never holds a sealed one.
func TestChatFormatFollowsSpaceMode(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.Create("plain", "Plain", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateEncrypted("secret", "Secret", "admin"); err != nil {
		t.Fatal(err)
	}
	plainMeta, plainBody := []byte(`{"t":1}`), []byte(`{"m":[]}`)

	if err := s.WriteChat("secret", chatA, plainMeta, plainBody, 1<<20); !errors.Is(err, ErrChatFormat) {
		t.Errorf("plaintext chat on encrypted space: err = %v, want ErrChatFormat", err)
	}
	if err := s.WriteChat("plain", chatA, sealedRec(2), sealedRec(3), 1<<20); !errors.Is(err, ErrChatFormat) {
		t.Errorf("sealed chat on plaintext space: err = %v, want ErrChatFormat", err)
	}
	// Mixed records are refused everywhere: a sealed body with a cleartext title
	// would leak exactly what the seal is for.
	if err := s.WriteChat("secret", chatA, plainMeta, sealedRec(3), 1<<20); !errors.Is(err, ErrChatFormat) {
		t.Errorf("mixed records: err = %v, want ErrChatFormat", err)
	}
	if err := s.WriteChat("secret", chatA, sealedRec(2), sealedRec(3), 1<<20); err != nil {
		t.Fatalf("sealed chat on encrypted space: %v", err)
	}
	list, err := s.ListChats("secret")
	if err != nil || len(list) != 1 || !list[0].Sealed {
		t.Fatalf("encrypted listing = %+v, %v", list, err)
	}
	// A short frame-looking blob is not a frame.
	if err := s.WriteChat("secret", chatB, []byte{1, 1, 9}, []byte{1, 1, 9}, 1<<20); !errors.Is(err, ErrChatFormat) {
		t.Errorf("truncated frame: err = %v, want ErrChatFormat", err)
	}
}

func TestChatIDAndSizeValidation(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.Create("plain", "Plain", "admin"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", "../../etc", "ABCDEF0123456789ABCDEF0123456789", chatA + "0", "zz"} {
		if err := s.WriteChat("plain", bad, []byte(`{}`), []byte(`{}`), 1<<20); !errors.Is(err, ErrInvalidChatID) {
			t.Errorf("WriteChat(%q) = %v, want ErrInvalidChatID", bad, err)
		}
		if _, err := s.ReadChat("plain", bad, nil); !errors.Is(err, ErrInvalidChatID) {
			t.Errorf("ReadChat(%q) = %v, want ErrInvalidChatID", bad, err)
		}
	}
	if err := s.WriteChat("../x", chatA, []byte(`{}`), []byte(`{}`), 1<<20); !errors.Is(err, ErrInvalidID) {
		t.Errorf("traversal space id: %v", err)
	}
	if err := s.WriteChat("plain", chatA, []byte(`{}`), bytes.Repeat([]byte("x"), 100), 50); !errors.Is(err, ErrChatTooLarge) {
		t.Errorf("oversized body: %v", err)
	}
}

// Converting to encrypted: the client stages sealed copies next to the
// plaintext originals; abort drops the copies, finalize drops the originals —
// the same stage-then-finalize shape as the content, so neither path loses a
// chat or leaves a cleartext one behind.
func TestChatConversionToEncrypted(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.Create("spc", "Spc", "admin"); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteChat("spc", chatA, []byte(`{"t":1}`), []byte(`{"m":1}`), 1<<20); err != nil {
		t.Fatal(err)
	}
	if err := s.BeginConvert("spc", ConvertToEncrypted); err != nil {
		t.Fatal(err)
	}
	// Mid to-encrypted, a cleartext write could slip past the finalize purge.
	if err := s.WriteChat("spc", chatB, []byte(`{"t":2}`), []byte(`{"m":2}`), 1<<20); !errors.Is(err, ErrChatFormat) {
		t.Errorf("plaintext write mid to-encrypted: %v, want ErrChatFormat", err)
	}
	if err := s.WriteChat("spc", chatA, sealedRec(4), sealedRec(5), 1<<20); err != nil {
		t.Fatalf("staging sealed copy: %v", err)
	}
	list, _ := s.ListChats("spc")
	if len(list) != 2 {
		t.Fatalf("mid-conversion listing should show both formats, got %+v", list)
	}
	src, err := s.ReadChat("spc", chatA, ptr(false))
	if err != nil || string(src) != `{"m":1}` {
		t.Fatalf("reading the plaintext source mid-conversion: %q %v", src, err)
	}

	if err := s.AbortConvert("spc"); err != nil {
		t.Fatal(err)
	}
	list, _ = s.ListChats("spc")
	if len(list) != 1 || list[0].Sealed {
		t.Fatalf("after abort only the plaintext original may remain: %+v", list)
	}

	if err := s.BeginConvert("spc", ConvertToEncrypted); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteChat("spc", chatA, sealedRec(4), sealedRec(5), 1<<20); err != nil {
		t.Fatal(err)
	}
	// What finalize-to-encrypted runs for the sidecars.
	if err := s.PurgeLegacyServerMetadata("spc"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FinishConvert("spc", true); err != nil {
		t.Fatal(err)
	}
	if has, _ := s.hasChats("spc", false); has {
		t.Fatal("a plaintext chat survived encryption")
	}
	list, _ = s.ListChats("spc")
	if len(list) != 1 || !list[0].Sealed {
		t.Fatalf("after finalize only the sealed copy may remain: %+v", list)
	}
}

func TestChatLegacySweepReportsPlaintextChats(t *testing.T) {
	s := newEncStore(t)
	if _, err := s.Create("spc", "Spc", "admin"); err != nil {
		t.Fatal(err)
	}
	if err := s.WriteChat("spc", chatA, []byte(`{"t":1}`), []byte(`{"m":1}`), 1<<20); err != nil {
		t.Fatal(err)
	}
	_, other, err := s.HasLegacyServerMetadata("spc")
	if err != nil || !other {
		t.Fatalf("plaintext chats must count as legacy metadata: other=%v err=%v", other, err)
	}
}

func ptr(b bool) *bool { return &b }
