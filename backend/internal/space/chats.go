package space

// Chat store for the in-app Claude assistant.
//
// The assistant runs entirely in the browser; the server only keeps its chat
// history so a conversation survives reloads and follows the owner across
// devices. Each chat is TWO opaque records under .notation/chats/ — OUTSIDE
// files/, so chats are never part of the Space's content, its git history, its
// exports or a folder sync:
//
//	<chatId>.meta.<ext>   small: title, timestamps, model (listed in bulk)
//	<chatId>.<ext>        the conversation itself (fetched on open)
//
// <ext> is the record's FORMAT, not a hint: "json" for a plaintext Space, and
// "sealed" for a zero-knowledge Space, where both records are AES-GCM frames the
// browser sealed with the Space key. The server never parses either — it only
// recognises a sealed frame by its 2-byte header, which is enough to enforce the
// one rule that matters: a zero-knowledge Space never stores a plaintext chat.
//
// The required format follows the Space's mode, and during a conversion the
// TARGET mode. So a to-encrypted conversion can write sealed copies while the
// plaintext originals still exist (the client migrates them), finalize drops
// the source format, and abort drops the staged one — the same
// stage-then-finalize shape as the content itself, and just as abort-safe.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	chatsDir      = "chats"
	chatExtPlain  = ".json"
	chatExtSealed = ".sealed"
	chatMetaInfix = ".meta"

	// MaxChatMetaBytes bounds the per-chat metadata record (title, a few dates).
	MaxChatMetaBytes = 64 << 10

	// sealedHeaderLen + nonce + tag: the smallest possible sealed frame.
	minSealedLen = 2 + 12 + 16
)

var (
	// ErrInvalidChatID is returned for an id that isn't 32 lowercase hex chars.
	ErrInvalidChatID = errors.New("invalid chat id")
	// ErrChatFormat is returned when a record's format doesn't match what the
	// Space requires (plaintext on a zero-knowledge Space, or the reverse), or
	// when the meta and body records disagree.
	ErrChatFormat = errors.New("chat record format does not match the space mode")
	// ErrChatTooLarge is returned for an oversized record.
	ErrChatTooLarge = errors.New("chat record too large")
)

var chatIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

// ValidChatID reports whether id is a well-formed chat id.
func ValidChatID(id string) bool { return chatIDPattern.MatchString(id) }

// IsSealedRecord reports whether b looks like an AES-GCM frame produced by the
// client crypto core: version 1, suite 1, and long enough for nonce + tag. A
// plaintext JSON record starts with '{' and can never match.
func IsSealedRecord(b []byte) bool {
	return len(b) >= minSealedLen && b[0] == 1 && b[1] == 1
}

// ChatInfo is one entry of a chat listing.
type ChatInfo struct {
	ID       string    `json:"id"`
	Sealed   bool      `json:"sealed"`
	Modified time.Time `json:"modified"`
	Size     int64     `json:"size"`
	// Meta is the raw metadata record (JSON bytes or a sealed frame); the HTTP
	// layer base64-encodes it.
	Meta []byte `json:"meta"`
}

func (s *Store) chatsPath(spaceID string) string {
	return filepath.Join(s.MetaDir(spaceID), chatsDir)
}

func chatExt(sealed bool) string {
	if sealed {
		return chatExtSealed
	}
	return chatExtPlain
}

// chatFormatFor returns whether records for this Space must be sealed: the
// Space's mode, or — mid-conversion — the mode it is converting TO.
func chatFormatFor(m Meta) bool {
	switch m.Converting {
	case ConvertToEncrypted:
		return true
	case ConvertToPlaintext:
		return false
	}
	return m.Encrypted
}

// ListChats returns every chat of the Space with its metadata record, newest
// first. Outside a conversion only records in the Space's own format are
// listed; mid-conversion both formats are, so the client can read the source
// and see what it has already migrated.
func (s *Store) ListChats(spaceID string) ([]ChatInfo, error) {
	m, err := s.Get(spaceID)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.chatsPath(spaceID))
	if errors.Is(err, fs.ErrNotExist) {
		return []ChatInfo{}, nil
	}
	if err != nil {
		return nil, err
	}
	want := chatFormatFor(m)
	both := m.Converting != ""
	out := []ChatInfo{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasPrefix(name, ".") {
			continue
		}
		var sealed bool
		var stem string
		switch {
		case strings.HasSuffix(name, chatMetaInfix+chatExtSealed):
			sealed, stem = true, strings.TrimSuffix(name, chatMetaInfix+chatExtSealed)
		case strings.HasSuffix(name, chatMetaInfix+chatExtPlain):
			sealed, stem = false, strings.TrimSuffix(name, chatMetaInfix+chatExtPlain)
		default:
			continue // a body record; listed via its meta
		}
		if !ValidChatID(stem) || (!both && sealed != want) {
			continue
		}
		info, statErr := os.Stat(filepath.Join(s.chatsPath(spaceID), stem+chatExt(sealed)))
		if statErr != nil {
			continue // meta without a body: a write that never finished
		}
		meta, readErr := readCapped(filepath.Join(s.chatsPath(spaceID), name), MaxChatMetaBytes)
		if readErr != nil {
			continue
		}
		out = append(out, ChatInfo{
			ID:       stem,
			Sealed:   sealed,
			Modified: info.ModTime().UTC(),
			Size:     info.Size(),
			Meta:     meta,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Modified.After(out[j].Modified) })
	return out, nil
}

// ReadChat returns a chat's conversation record. sealed selects the format;
// pass nil for "the Space's current format".
func (s *Store) ReadChat(spaceID, chatID string, sealed *bool) ([]byte, error) {
	if !ValidChatID(chatID) {
		return nil, ErrInvalidChatID
	}
	m, err := s.Get(spaceID)
	if err != nil {
		return nil, err
	}
	want := chatFormatFor(m)
	if sealed != nil {
		// Outside a conversion only the Space's own format exists for the client.
		if m.Converting == "" && *sealed != m.Encrypted {
			return nil, fs.ErrNotExist
		}
		want = *sealed
	}
	return os.ReadFile(filepath.Join(s.chatsPath(spaceID), chatID+chatExt(want)))
}

// WriteChat stores both records of a chat. They must share one format, and that
// format must be the one the Space requires (see chatFormatFor).
func (s *Store) WriteChat(spaceID, chatID string, meta, body []byte, maxBytes int64) error {
	if !ValidID(spaceID) {
		return ErrInvalidID
	}
	if !ValidChatID(chatID) {
		return ErrInvalidChatID
	}
	if len(meta) == 0 || len(body) == 0 {
		return fmt.Errorf("%w: empty record", ErrChatFormat)
	}
	if len(meta) > MaxChatMetaBytes || (maxBytes > 0 && int64(len(body)) > maxBytes) {
		return ErrChatTooLarge
	}
	sealed := IsSealedRecord(body)
	if IsSealedRecord(meta) != sealed {
		return fmt.Errorf("%w: meta and body formats differ", ErrChatFormat)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m, err := s.readMeta(spaceID)
	if err != nil {
		return err
	}
	if sealed != chatFormatFor(m) {
		return ErrChatFormat
	}
	dir := s.chatsPath(spaceID)
	ext := chatExt(sealed)
	// Body first: a meta record is what makes a chat visible in the listing, so
	// a crash between the two writes leaves an invisible body, never a listed
	// chat that can't be opened.
	if err := atomicWrite(filepath.Join(dir, chatID+ext), body, 0o640); err != nil {
		return err
	}
	return atomicWrite(filepath.Join(dir, chatID+chatMetaInfix+ext), meta, 0o640)
}

// DeleteChat removes a chat in every format. fs.ErrNotExist if there was none.
func (s *Store) DeleteChat(spaceID, chatID string) error {
	if !ValidChatID(chatID) {
		return ErrInvalidChatID
	}
	if _, err := s.Get(spaceID); err != nil {
		return err
	}
	dir := s.chatsPath(spaceID)
	removed := false
	for _, ext := range []string{chatExtPlain, chatExtSealed} {
		// Meta first, so a half-finished delete never leaves a listed chat
		// without a body.
		for _, name := range []string{chatID + chatMetaInfix + ext, chatID + ext} {
			err := os.Remove(filepath.Join(dir, name))
			if err == nil {
				removed = true
			} else if !errors.Is(err, fs.ErrNotExist) {
				return err
			}
		}
	}
	if !removed {
		return fs.ErrNotExist
	}
	return nil
}

// PurgeChats deletes every chat record of one format. Conversion uses it to
// drop the source format on finalize and the staged format on abort; the legacy
// sweep uses it to remove plaintext chats from a zero-knowledge Space.
func (s *Store) PurgeChats(spaceID string, sealed bool) error {
	if !ValidID(spaceID) {
		return ErrInvalidID
	}
	dir := s.chatsPath(spaceID)
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	ext := chatExt(sealed)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ext) {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

// hasChats reports whether any record of the given format exists.
func (s *Store) hasChats(spaceID string, sealed bool) (bool, error) {
	entries, err := os.ReadDir(s.chatsPath(spaceID))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	ext := chatExt(sealed)
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ext) {
			return true, nil
		}
	}
	return false, nil
}

func readCapped(path string, max int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > max {
		return nil, ErrChatTooLarge
	}
	return os.ReadFile(path)
}
