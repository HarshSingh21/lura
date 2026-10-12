import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

import { useCreateNote, useDeleteNote, useOverview, useSuggest, useUpdateNote } from '@/api/hooks';
import type { Note, Place, Suggestion, Trigger } from '@/api/types';
import { TRIGGERS } from '@/api/types';
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
import { usePeople } from '@/features/people/api';
import { firstName, partitionPeople } from '@/features/people/peer';
import { PersonPicker, peerOption, type PersonOption } from '@/features/people/PersonPicker';
import { Mono, Txt } from '@/theme/text';
import { color, font, palette, radius, size, space } from '@/theme/tokens';

import { describeAudience, type NameOf } from './describe';

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
 *
 * Below the suggestion sits the note's routing: where and when (the suggestion,
 * overridable), whose movement fires it, and who hears about it. Both people
 * fields default to "me", so a plain note stays a one-line affair; picking
 * Nishtha turns it into "when Nishtha passes Grocery, tell both of us". Only
 * people who share their location with me can be watched — the server could not
 * see them cross otherwise — and a note sent to someone else reaches them as a
 * reminder, never as a note in their own list.
 */
export function NotesScreen() {
  const { data } = useOverview();
  const createNote = useCreateNote();
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const suggest = useSuggest();

  const [text, setText] = useState('');
  const [lastSuggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [lastSuggestFailed, setSuggestFailed] = useState(false);
  // Text too short to suggest for shows no suggestion, whatever the last
  // request said; derived here rather than reset from the effect below.
  const suggestable = text.trim().length >= 4;
  const suggestion = suggestable ? lastSuggestion : null;
  const suggestFailed = suggestable && lastSuggestFailed;
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Manual choices override the suggestion; undefined means "use the suggestion"
  // and '' (place only) means "no place".
  const [placeChoice, setPlaceChoice] = useState<string | undefined>();
  const [triggerChoice, setTriggerChoice] = useState<Trigger | undefined>();
  const [watchUserId, setWatchUserId] = useState('');
  const [notifyIds, setNotifyIds] = useState<string[]>([]);

  const places = data?.places ?? [];
  const notes = data?.notes ?? [];
  const meId = data?.user.id ?? '';

  const peopleQuery = usePeople();
  const accepted = useMemo(() => partitionPeople(peopleQuery.data?.people ?? []).accepted, [peopleQuery.data]);
  const nameOf = useMemo<NameOf>(() => {
    const names = new Map(accepted.map((p) => [p.peerId, firstName(p)]));
    return (id) => names.get(id);
  }, [accepted]);

  // "Remind me when they arrive somewhere" on People lands here with ?watch=<id>.
  // Adopted during render so the composer never paints once with "Me" selected.
  const params = useLocalSearchParams<{ watch?: string }>();
  const [presetSeen, setPresetSeen] = useState<string | undefined>();
  if (params.watch && params.watch !== presetSeen) {
    setPresetSeen(params.watch);
    setWatchUserId(params.watch);
    setTriggerChoice('arrive');
  }

  // "Me" is always the first option. In the notify list its id is the owner's,
  // so what is sent is explicit rather than relying on [] meaning me.
  const watchOptions: PersonOption[] = [
    { id: '', label: 'Me' },
    ...accepted.map((p) => peerOption(p, { requireSharing: true })),
  ];
  const notifyOptions: PersonOption[] = [{ id: meId, label: 'Me' }, ...accepted.map((p) => peerOption(p))];
  const notifySelected = notifyIds.length > 0 ? notifyIds : [meId];

  const effectivePlaceId = placeChoice !== undefined ? placeChoice || undefined : suggestion?.placeId;
  const effectiveTrigger: Trigger = triggerChoice ?? suggestion?.trigger ?? 'arrive';
  const effectivePlace = places.find((p) => p.id === effectivePlaceId);
  const preview = describeAudience({
    ownerId: meId,
    watchUserId,
    notifyUserIds: notifySelected,
    trigger: effectiveTrigger,
    placeName: effectivePlace?.name,
    nameOf,
  });
  const watchedPeer = accepted.find((p) => p.peerId === watchUserId);

  // Debounced suggestion: a request per keystroke would be rude to a CPU-bound
  // embedding service, and 350 ms is below the threshold where typing feels laggy.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const trimmed = text.trim();
    if (trimmed.length < 4) return;
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
        placeId: effectivePlaceId,
        trigger: triggerChoice ?? suggestion?.trigger,
        tags: suggestion?.tags,
        watchUserId,
        notifyUserIds: meId ? notifySelected : [],
      },
      {
        onSuccess: () => {
          setText('');
          setSuggestion(null);
          setPlaceChoice(undefined);
          setTriggerChoice(undefined);
          setWatchUserId('');
          setNotifyIds([]);
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

        <View style={styles.routing}>
          <RoutingRow label="WHERE">
            <View style={styles.choiceRow}>
              {places.length === 0 ? (
                <Txt variant="micro" color={color.textFaint}>
                  No places yet — draw one on the Live map.
                </Txt>
              ) : (
                places.map((place) => (
                  <ChoicePill
                    key={place.id}
                    label={place.name}
                    selected={place.id === effectivePlaceId}
                    suggested={placeChoice === undefined && place.id === suggestion?.placeId}
                    onPress={() => setPlaceChoice(place.id === effectivePlaceId ? '' : place.id)}
                  />
                ))
              )}
            </View>
          </RoutingRow>

          <RoutingRow label="WHEN">
            <View style={styles.choiceRow}>
              {TRIGGERS.map((trigger) => (
                <ChoicePill
                  key={trigger}
                  label={trigger === 'passby' ? 'Pass-by' : trigger.charAt(0).toUpperCase() + trigger.slice(1)}
                  selected={trigger === effectiveTrigger}
                  suggested={!triggerChoice && trigger === suggestion?.trigger}
                  onPress={() => setTriggerChoice(trigger)}
                />
              ))}
            </View>
          </RoutingRow>

          <RoutingRow label="WHOSE MOVEMENT">
            <PersonPicker
              accessibilityLabel="Whose movement fires this note"
              options={watchOptions}
              selected={[watchUserId]}
              onToggle={setWatchUserId}
            />
          </RoutingRow>

          <RoutingRow label="NOTIFY">
            <PersonPicker
              multiple
              accessibilityLabel="Who is notified"
              options={notifyOptions}
              selected={notifySelected}
              onToggle={(id) => {
                const next = notifySelected.includes(id)
                  ? notifySelected.filter((x) => x !== id)
                  : [...notifySelected, id];
                // Someone has to hear about it: deselecting the last person
                // falls back to me rather than saving a reminder for nobody.
                setNotifyIds(next.length > 0 ? next : [meId]);
              }}
            />
          </RoutingRow>

          <View style={styles.preview}>
            <Txt variant="small" color={color.textBody}>
              {preview.when}
              <Txt variant="small" color={color.textFaint}>
                {'  →  '}
              </Txt>
              {preview.notify}
            </Txt>
            {watchedPeer && !watchedPeer.sharingWithMe ? (
              <Txt variant="micro" color={palette.amberInk}>
                {firstName(watchedPeer)} is not sharing with you, so this cannot fire until they turn sharing back on.
              </Txt>
            ) : !effectivePlace ? (
              <Txt variant="micro" color={palette.amberInk}>
                Pick a place — a note with no place never fires.
              </Txt>
            ) : null}
          </View>
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
                nameOf={nameOf}
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
                    nameOf={nameOf}
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
  nameOf,
  onToggle,
  onDelete,
}: {
  note: Note;
  places: Place[];
  nameOf: NameOf;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const place = places.find((p) => p.id === note.placeId);
  // An older server omits the people fields; read them defensively.
  const audience = describeAudience({
    ownerId: note.userId,
    watchUserId: note.watchUserId ?? '',
    notifyUserIds: note.notifyUserIds ?? [],
    trigger: note.trigger,
    placeName: place?.name,
    nameOf,
  });

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
          {place && !audience.isDefault ? (
            <Txt variant="micro" color={color.textBody}>
              {audience.when} → {audience.notify}
            </Txt>
          ) : null}
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

function RoutingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.routingRow}>
      <Mono size={size.monoTiny} color={color.textFaint} style={styles.routingLabel}>
        {label}
      </Mono>
      <View style={styles.routingBody}>{children}</View>
    </View>
  );
}

/** ChoicePill is a single-choice pill; a dashed border marks the AI's pick until you choose. */
function ChoicePill({
  label,
  selected,
  suggested,
  onPress,
}: {
  label: string;
  selected: boolean;
  suggested?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      aria-selected={selected}
      accessibilityLabel={suggested ? `${label}, suggested` : label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        selected && styles.choiceOn,
        selected && suggested && styles.choiceSuggested,
        pressed && styles.pressed,
      ]}
    >
      <Txt variant="small" color={selected ? palette.accentInk : color.textBody} style={styles.choiceLabel}>
        {label}
      </Txt>
    </Pressable>
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

  routing: { gap: 10, borderTopWidth: 1, borderTopColor: color.hairline, paddingTop: 12 },
  routingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.lg, flexWrap: 'wrap' },
  routingLabel: { width: 112, letterSpacing: 0.6, paddingTop: 7 },
  routingBody: { flex: 1, minWidth: 220 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  choice: {
    borderWidth: 1,
    borderColor: color.borderInput,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  choiceOn: { borderColor: palette.accent, backgroundColor: color.accentSoft },
  choiceSuggested: { borderStyle: 'dashed' },
  choiceLabel: { fontFamily: font.sansMedium },
  pressed: { opacity: 0.85 },
  preview: {
    gap: 3,
    backgroundColor: color.surfaceMuted,
    borderRadius: radius.md,
    paddingVertical: 8,
    paddingHorizontal: 11,
  },

  list: { gap: 9 },
  noteCard: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16 },
  noteDone: { textDecorationLine: 'line-through' },
  noteMeta: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: 4, flexWrap: 'wrap' },
  deleteButton: { padding: 6, borderRadius: radius.md },
  doneHeading: { marginTop: space.md },
});
