import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { useCreateNote, useDeleteNote, useOverview, useSuggest, useUpdateNote } from '@/api/hooks';
import type { Note, Place, Suggestion } from '@/api/types';
import { Icon } from '@/components/ui/Icon';
import {
  Button,
  Card,
  Checkbox,
  Chip,
  EmptyState,
  TriggerBadge,
  styles as ui,
} from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, font, palette, radius, size, space } from '@/theme/tokens';

/**
 * Notes: the AI-assisted composer plus the list.
 *
 * The suggestion row is the visible half of HLD §5.7/§7.3 — as you type, the
 * server's AI Brain proposes a place, tags and a trigger, and you accept or edit
 * it. Two details matter for it to feel honest rather than magical:
 *
 *   - The confidence and the engine are shown ("92% match · on-device"), so the
 *     user can tell a guess from a certainty and can see that nothing left the box.
 *   - Suggesting never blocks saving. A dead AI Brain degrades to a plain note
 *     (HLD §10), and the composer says so instead of failing.
 */
export function NotesScreen() {
  const { data } = useOverview();
  const createNote = useCreateNote();
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const suggest = useSuggest();

  const [text, setText] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggestFailed, setSuggestFailed] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const places = data?.places ?? [];
  const notes = data?.notes ?? [];

  // Debounced suggestion: a request per keystroke would be rude to a CPU-bound
  // embedding service, and 350 ms is below the threshold where typing feels laggy.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const trimmed = text.trim();
    if (trimmed.length < 4) {
      setSuggestion(null);
      setSuggestFailed(false);
      return;
    }
    debounce.current = setTimeout(() => {
      suggest.mutate(trimmed, {
        onSuccess: (res) => {
          setSuggestion(res.suggestion);
          setSuggestFailed(false);
        },
        onError: () => {
          setSuggestion(null);
          setSuggestFailed(true);
        },
      });
    }, 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
    // suggest.mutate is stable; depending on it would re-fire on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    createNote.mutate(
      {
        text: trimmed,
        // Send the accepted suggestion explicitly rather than relying on the
        // server to re-derive it: what the user saw is what gets saved.
        placeId: suggestion?.placeId,
        trigger: suggestion?.trigger,
        tags: suggestion?.tags,
      },
      {
        onSuccess: () => {
          setText('');
          setSuggestion(null);
        },
      },
    );
  };

  const open = notes.filter((n) => !n.done);
  const done = notes.filter((n) => n.done);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Txt variant="h1">Notes</Txt>
        <Txt variant="body" color={color.textMuted} style={styles.subtitle}>
          Type a note — Lura suggests the place and tag. It fires when the trigger fires.
        </Txt>
      </View>

      <Card style={styles.composer}>
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          placeholder="e.g. buy oat milk when I pass the store…"
          placeholderTextColor={color.textFaint}
          style={styles.composerInput}
          returnKeyType="done"
          multiline={false}
        />

        <View style={styles.suggestRow}>
          <Mono size={size.monoTiny} color={color.textFaint} style={styles.suggestLabel}>
            SUGGESTED
          </Mono>

          {suggestion ? (
            <>
              {suggestion.placeName ? (
                <Chip label={`📍 ${suggestion.placeName}`} tone="accent" />
              ) : (
                <Chip label="no place matched" />
              )}
              {suggestion.tags.slice(0, 2).map((tag) => (
                <Chip key={tag} label={tag} />
              ))}
              <Chip
                label={suggestion.trigger === 'passby' ? 'pass-by' : suggestion.trigger}
                tone={suggestion.trigger === 'passby' ? 'amber' : 'neutral'}
              />
              <Mono size={size.monoXs} color={color.textFaint}>
                {Math.round(suggestion.confidence * 100)}% match ·{' '}
                {suggestion.onDevice ? 'on-device' : suggestion.engine}
              </Mono>
            </>
          ) : suggestFailed ? (
            <Txt variant="micro" color={palette.amberInk}>
              Suggestions unavailable — the note will still save.
            </Txt>
          ) : (
            <Txt variant="micro" color={color.textFaint}>
              {text.trim().length < 4 ? 'keep typing…' : 'thinking…'}
            </Txt>
          )}

          <View style={ui.flex} />
          <Button label="Add note" small onPress={submit} loading={createNote.isPending} />
        </View>

        {createNote.error ? (
          <Txt variant="micro" color={palette.dangerInk} style={styles.composerError}>
            {createNote.error instanceof Error ? createNote.error.message : 'Could not save the note'}
          </Txt>
        ) : null}
      </Card>

      <View style={styles.list}>
        {notes.length === 0 ? (
          <Card>
            <EmptyState
              title="No notes yet"
              body="A note is a reminder bound to a place and a trigger. Write one above."
            />
          </Card>
        ) : (
          <>
            {open.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                places={places}
                onToggle={() => updateNote.mutate({ id: note.id, done: !note.done })}
                onDelete={() => deleteNote.mutate(note.id)}
              />
            ))}

            {done.length > 0 ? (
              <>
                <Mono heading color={color.textFaint} style={styles.doneHeading}>
                  DONE
                </Mono>
                {done.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    places={places}
                    onToggle={() => updateNote.mutate({ id: note.id, done: !note.done })}
                    onDelete={() => deleteNote.mutate(note.id)}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </View>
    </ScrollView>
  );
}

function NoteRow({
  note,
  places,
  onToggle,
  onDelete,
}: {
  note: Note;
  places: Place[];
  onToggle: () => void;
  onDelete: () => void;
}) {
  const place = places.find((p) => p.id === note.placeId);

  return (
    <Card style={styles.noteCard}>
      <Checkbox checked={note.done} onPress={onToggle} />

      <View style={ui.flex}>
        <Txt
          variant="bodyMedium"
          color={note.done ? color.textFaint : color.textStrong}
          style={note.done ? styles.noteDone : undefined}
        >
          {note.text}
        </Txt>
        <View style={styles.noteMeta}>
          <TriggerBadge trigger={note.trigger} />
          <Txt variant="micro" color={color.textSubtle}>
            {place ? place.name : 'no place bound — it will not fire'}
          </Txt>
          {note.firedAt ? (
            <Mono size={size.monoTiny} color={color.textFaint}>
              fired {new Date(note.firedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </Mono>
          ) : null}
        </View>
      </View>

      {note.tags[0] ? <Chip label={note.tags[0]} mono /> : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete note: ${note.text}`}
        onPress={onDelete}
        hitSlop={8}
        style={({ pressed }) => [styles.deleteButton, pressed && { opacity: 0.6 }]}
      >
        <Icon name="close" size={14} color={color.textFaint} />
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.page, paddingHorizontal: space.pageX, gap: space.xxl, maxWidth: 780 },
  header: { gap: 5 },
  subtitle: { maxWidth: 620 },

  composer: { gap: 12, borderRadius: radius.cardLg, padding: 15 },
  composerInput: {
    fontFamily: font.sans,
    fontSize: 14,
    color: color.textStrong,
    paddingVertical: 4,
    outlineStyle: 'none' as never,
  },
  suggestRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' },
  suggestLabel: { letterSpacing: 0.6 },
  composerError: { marginTop: 2 },

  list: { gap: 9 },
  noteCard: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16 },
  noteDone: { textDecorationLine: 'line-through' },
  noteMeta: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 4, flexWrap: 'wrap' },
  deleteButton: { padding: 6, borderRadius: radius.md },
  doneHeading: { marginTop: space.md },
});
