import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, Card, Dot, EmptyState, Field, styles as ui } from '@/components/ui/primitives';
import { Mono, SectionLabel, Txt } from '@/theme/text';
import { color, palette, radius, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';
import { useStore } from '@/state/store';

import { describeInviteError, useInvitePerson, usePeople } from './api';
import { joinNames, partitionPeople, watched, watchers } from './peer';
import { IncomingRow, OutgoingRow, PeerRow } from './rows';

/**
 * People: mutual, two-way live sharing between accounts.
 *
 * The screen exists to answer one question — "who can see me, and whom can I
 * see?" — and the layout answers it twice: once at the top, where the two
 * directions are counted separately, and again in every row, where they are drawn
 * as two labelled lanes. HLD §11 forbids covert sharing and requires mutual
 * consent, so the client's job is to make a one-sided state impossible to mistake
 * for a mutual one: either side can pause, and a paused side says who paused it.
 */
export function PeopleScreen() {
  const { isPhone } = useLayoutMode();
  const { data, isLoading, error } = usePeople();
  const positions = useStore((s) => s.positions);
  const invite = useInvitePerson();

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ email: string; accepted: boolean } | null>(null);

  const people = data?.people ?? [];
  const { incoming, outgoing, accepted } = partitionPeople(people);
  const canSeeMe = watchers(people);
  const iCanSee = watched(people);

  const submit = () => {
    const address = email.trim();
    if (!address) return;
    setSent(null);
    invite.mutate(address, {
      onSuccess: (res) => {
        // The server folds "invite someone who already invited me" into an
        // accept, so the confirmation has to be able to say "connected" too.
        setSent({ email: address, accepted: res.connection.status === 'accepted' });
        setEmail('');
      },
    });
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Txt variant="h1">People</Txt>
        <Txt variant="body" color={color.textMuted} style={styles.subtitle}>
          Live sharing between accounts on this server. Every connection is two separate switches — you
          decide what they see, they decide what you see — and either side can pause without removing
          anything.
        </Txt>
      </View>

      <View style={[styles.summary, isPhone && styles.summaryPhone]}>
        <SummaryTile
          title="WHO CAN SEE ME"
          tone="sharing"
          count={canSeeMe.length}
          empty="No one can see you right now"
          names={joinNames(canSeeMe)}
          note="Your live position is going to these people."
        />
        <SummaryTile
          title="WHOM I CAN SEE"
          tone="receiving"
          count={iCanSee.length}
          empty="No one is sharing with you"
          names={joinNames(iCanSee)}
          note="They are sending you their live position."
        />
      </View>

      <Card style={styles.inviteCard}>
        <Txt variant="cardTitle">Invite someone</Txt>
        <Txt variant="small" color={color.textSubtle} style={styles.cardHint}>
          They need an account on this Lura server. Nothing is shared until they accept.
        </Txt>

        <View style={[styles.inviteRow, isPhone && styles.inviteRowPhone]}>
          <Field
            label="Their email"
            placeholder="nistha@lura.local"
            value={email}
            onChangeText={(next) => {
              setEmail(next);
              if (sent) setSent(null);
            }}
            onSubmitEditing={submit}
            accessibilityLabel="Email address of the person to invite"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="send"
            style={ui.flex}
            error={invite.error ? describeInviteError(invite.error) : undefined}
          />
          <Button
            label="Send invite"
            loading={invite.isPending}
            disabled={email.trim().length === 0}
            onPress={submit}
            style={[styles.inviteButton, isPhone && styles.inviteButtonPhone]}
          />
        </View>

        {sent ? (
          <View style={styles.sentNote}>
            <Dot size={7} color={palette.accent} />
            <Txt variant="micro" color={palette.accentInk} style={ui.flex}>
              {sent.accepted
                ? `You are connected with ${sent.email}. They had already invited you, so accepting was enough.`
                : `Invitation sent to ${sent.email}. They will see it under People, and nothing moves until they accept.`}
            </Txt>
          </View>
        ) : null}
      </Card>

      {incoming.length > 0 ? (
        <View>
          <SectionLabel>INVITATIONS FOR YOU</SectionLabel>
          <View style={styles.list}>
            {incoming.map((peer) => (
              <IncomingRow key={peer.id} peer={peer} />
            ))}
          </View>
        </View>
      ) : null}

      {outgoing.length > 0 ? (
        <View>
          <SectionLabel>INVITATIONS YOU SENT</SectionLabel>
          <View style={styles.list}>
            {outgoing.map((peer) => (
              <OutgoingRow key={peer.id} peer={peer} />
            ))}
          </View>
        </View>
      ) : null}

      <View>
        <SectionLabel>CONNECTED PEOPLE</SectionLabel>
        <View style={styles.list}>
          {error ? (
            <Card>
              <EmptyState
                title="Cannot load your people"
                body={error instanceof Error ? error.message : 'Unknown error'}
              />
            </Card>
          ) : isLoading ? (
            <Card>
              <EmptyState title="Loading…" />
            </Card>
          ) : accepted.length === 0 ? (
            <Card>
              <EmptyState
                title="No one is connected yet"
                body={
                  incoming.length + outgoing.length > 0
                    ? 'An invitation is still waiting above. A connection starts once it is accepted.'
                    : 'Invite someone by the email they use on this server. Both sides have to agree, and both keep their own switch afterwards.'
                }
              />
            </Card>
          ) : (
            accepted.map((peer) => <PeerRow key={peer.id} peer={peer} positions={positions} />)
          )}
        </View>
      </View>
    </ScrollView>
  );
}

/**
 * SummaryTile counts one direction. The two tiles are never merged into a single
 * "2 connections" number: that number would be the one thing this screen must not
 * say, because it implies the two directions are the same.
 */
function SummaryTile({
  title,
  tone,
  count,
  names,
  empty,
  note,
}: {
  title: string;
  tone: 'sharing' | 'receiving';
  count: number;
  names: string;
  empty: string;
  note: string;
}) {
  const live = count > 0;
  const accent = tone === 'sharing' ? palette.amber : palette.accent;
  const ink = tone === 'sharing' ? palette.amberInk : palette.accentInk;

  return (
    <View
      style={[
        styles.tile,
        live
          ? { backgroundColor: tone === 'sharing' ? color.amberSoft : color.accentSoft, borderColor: accent }
          : null,
      ]}
    >
      <View style={styles.tileHead}>
        <Dot size={8} color={live ? accent : color.neutralDot} blink={live && tone === 'sharing'} />
        <Mono heading color={live ? ink : color.textFaint} style={styles.tileTitle}>
          {title}
        </Mono>
      </View>
      <Txt variant="h2" color={live ? ink : color.textMuted}>
        {live ? `${count} ${count === 1 ? 'person' : 'people'}` : empty}
      </Txt>
      <Txt variant="micro" color={live ? color.textBody : color.textFaint} style={styles.tileNames}>
        {live ? names : note}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.page, paddingHorizontal: space.pageX, gap: space.page, maxWidth: 820 },
  header: { gap: 5 },
  subtitle: { maxWidth: 640 },

  summary: { flexDirection: 'row', gap: space.xl },
  summaryPhone: { flexDirection: 'column' },
  tile: {
    flex: 1,
    minWidth: 0,
    gap: 3,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    padding: space.xl,
  },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2 },
  tileTitle: { letterSpacing: 0.85 },
  tileNames: { lineHeight: 16 },

  inviteCard: { gap: space.md, borderRadius: radius.cardLg, padding: space.xxl },
  cardHint: { marginTop: -4 },
  inviteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.lg, marginTop: 4 },
  inviteRowPhone: { flexDirection: 'column', alignItems: 'stretch' },
  inviteButton: { marginTop: 21 },
  inviteButtonPhone: { marginTop: 0 },
  sentNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    backgroundColor: color.accentSofter,
    borderRadius: radius.md,
    paddingVertical: 9,
    paddingHorizontal: 11,
  },

  list: { gap: 9 },
});
