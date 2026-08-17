import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import {
  useChannels,
  useCreateChannel,
  useCreateDevice,
  useDeleteChannel,
  useDeleteDevice,
  useOverview,
  useRotateDeviceToken,
  useUpdateChannel,
  useUpdateMe,
} from '@/api/hooks';
import { Button, Card, Chip, Field, Toggle, styles as ui } from '@/components/ui/primitives';
import { Mono, SectionLabel, Txt } from '@/theme/text';
import { color, palette, radius, size, space } from '@/theme/tokens';
import { useStore } from '@/state/store';

/**
 * Settings is where the invariants become switches.
 *
 * Airgap mode, quiet hours, retention and the delete-everything button are the
 * UI half of HLD §11: consent-first, exportable, erasable, and no covert egress.
 * The connection block exists because a self-hosted product has to let you say
 * *which* server is yours — on a phone, "localhost" is the phone.
 */
export function SettingsScreen() {
  const { data } = useOverview();
  const updateMe = useUpdateMe();
  const channels = useChannels();
  const createChannel = useCreateChannel();
  const updateChannel = useUpdateChannel();
  const deleteChannel = useDeleteChannel();
  const createDevice = useCreateDevice();
  const rotateToken = useRotateDeviceToken();
  const deleteDevice = useDeleteDevice();

  const connection = useStore((s) => s.connection);
  const setConnection = useStore((s) => s.setConnection);
  const pushToast = useStore((s) => s.pushToast);

  const [baseUrl, setBaseUrl] = useState(connection.baseUrl);
  const [token, setToken] = useState(connection.token);
  const [quietFrom, setQuietFrom] = useState(data?.user.quietFrom ?? '');
  const [quietTo, setQuietTo] = useState(data?.user.quietTo ?? '');
  const [tz, setTz] = useState(data?.user.tz ?? '');
  const [deviceName, setDeviceName] = useState('');
  const [newToken, setNewToken] = useState<{ id: string; token: string } | null>(null);
  const [ntfyTopic, setNtfyTopic] = useState('');

  // The overview arrives after the first render, so the quiet-hours fields start
  // empty; adopt the server's values whenever they change. The server stays the
  // authority — this is a mirror, not a second copy.
  const serverQuietFrom = data?.user.quietFrom;
  const serverQuietTo = data?.user.quietTo;
  const serverTz = data?.user.tz;
  useEffect(() => {
    if (serverQuietFrom !== undefined) setQuietFrom(serverQuietFrom);
    if (serverQuietTo !== undefined) setQuietTo(serverQuietTo);
    if (serverTz !== undefined) setTz(serverTz);
  }, [serverQuietFrom, serverQuietTo, serverTz]);

  const airgap = data?.user.airgap ?? false;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Txt variant="h1">Settings</Txt>
        <Txt variant="body" color={color.textMuted}>
          This is your deployment. Everything below is stored on the server you point this app at.
        </Txt>
      </View>

      {/* ---------------------------------------------------------------- privacy */}
      <View>
        <SectionLabel>PRIVACY</SectionLabel>
        <Card style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={ui.flex}>
              <Txt variant="cardTitle">Airgap mode</Txt>
              <Txt variant="tiny" color={color.textMuted} style={styles.hint}>
                Refuses every outbound call: no remote basemap, no hosted push, no third-party AI. Reminders
                still fire in-app and to local channels.
              </Txt>
            </View>
            <Toggle
              value={airgap}
              accessibilityLabel="Airgap mode"
              onChange={(next) => updateMe.mutate({ airgap: next })}
            />
          </View>

          <View style={styles.divider} />

          <Txt variant="cardTitle">Quiet hours</Txt>
          <Txt variant="tiny" color={color.textMuted} style={styles.hint}>
            Inside this window, reminders are recorded and shown in-app but never pushed. Evaluated in your
            timezone.
          </Txt>
          <View style={styles.row}>
            <Field label="From" placeholder="22:30" value={quietFrom} onChangeText={setQuietFrom} style={ui.flex} />
            <Field label="To" placeholder="07:00" value={quietTo} onChangeText={setQuietTo} style={ui.flex} />
            <Field label="Timezone" placeholder="Asia/Kolkata" value={tz} onChangeText={setTz} style={ui.flex} />
          </View>
          <Button
            label="Save"
            small
            loading={updateMe.isPending}
            onPress={() =>
              updateMe.mutate(
                { quietFrom, quietTo, tz },
                {
                  onSuccess: () => pushToast({ kind: 'info', title: 'Settings saved' }),
                  onError: (err) =>
                    pushToast({
                      kind: 'error',
                      title: 'Could not save settings',
                      body: err instanceof Error ? err.message : undefined,
                    }),
                },
              )
            }
            style={styles.selfStart}
          />
        </Card>
      </View>

      {/* ---------------------------------------------------------------- devices */}
      <View>
        <SectionLabel>DEVICES</SectionLabel>
        <Card style={styles.card}>
          {(data?.devices ?? []).map((device) => (
            <View key={device.id} style={styles.deviceRow}>
              <View style={ui.flex}>
                <Txt variant="bodySemi">{device.name}</Txt>
                <Mono size={size.monoXs} color={color.textFaint}>
                  {device.id} · {device.kind}
                </Mono>
              </View>
              <Button
                label="New token"
                variant="ghost"
                small
                onPress={() =>
                  rotateToken.mutate(device.id, {
                    onSuccess: (res) => setNewToken({ id: device.id, token: res.pubToken }),
                  })
                }
              />
              <Button
                label="Remove"
                variant="danger"
                small
                onPress={() => deleteDevice.mutate(device.id)}
              />
            </View>
          ))}

          {newToken ? (
            <View style={styles.tokenBox}>
              <Txt variant="micro" color={palette.amberInk}>
                New ingest token for {newToken.id} — copy it now, it is not shown again:
              </Txt>
              <Mono size={size.monoSm} selectable color={color.textBody}>
                {newToken.token}
              </Mono>
            </View>
          ) : null}

          <View style={styles.divider} />

          <Txt variant="cardTitle">Add a device</Txt>
          <Txt variant="tiny" color={color.textMuted} style={styles.hint}>
            Each device gets its own ingest token, so one can be revoked without touching the others. An
            OwnTracks client can use it directly.
          </Txt>
          <View style={styles.row}>
            <Field placeholder="Pixel 9" value={deviceName} onChangeText={setDeviceName} style={ui.flex} />
            <Button
              label="Add"
              loading={createDevice.isPending}
              onPress={() => {
                if (!deviceName.trim()) return;
                createDevice.mutate(
                  { name: deviceName.trim() },
                  {
                    onSuccess: (res) => {
                      setNewToken({ id: res.device.id, token: res.pubToken });
                      setDeviceName('');
                    },
                  },
                );
              }}
            />
          </View>
        </Card>
      </View>

      {/* ---------------------------------------------------------------- channels */}
      <View>
        <SectionLabel>NOTIFICATION CHANNELS</SectionLabel>
        <Card style={styles.card}>
          <Txt variant="tiny" color={color.textMuted}>
            Channels are tried in priority order until one accepts. In-app always runs; the log channel is the
            fallback that needs no configuration.
          </Txt>

          {(channels.data?.channels ?? []).map((channel) => (
            <View key={channel.id} style={styles.deviceRow}>
              <View style={ui.flex}>
                <View style={styles.channelHead}>
                  <Txt variant="bodySemi">{channel.type}</Txt>
                  <Chip label={`priority ${channel.priority}`} mono />
                  {channel.config.topic ? <Chip label={channel.config.topic} mono /> : null}
                </View>
                {airgap && channel.type === 'ntfy' ? (
                  <Txt variant="micro" color={palette.amberInk}>
                    Skipped while airgap mode is on if the server is not local.
                  </Txt>
                ) : null}
              </View>
              <Toggle
                value={channel.enabled}
                accessibilityLabel={`${channel.type} enabled`}
                onChange={(next) => updateChannel.mutate({ id: channel.id, enabled: next })}
              />
              <Button label="Remove" variant="danger" small onPress={() => deleteChannel.mutate(channel.id)} />
            </View>
          ))}

          <View style={styles.divider} />

          <Txt variant="cardTitle">Add an ntfy topic</Txt>
          <View style={styles.row}>
            <Field
              placeholder="lura-me"
              value={ntfyTopic}
              onChangeText={setNtfyTopic}
              style={ui.flex}
              hint="Your self-hosted ntfy topic. The server's LURA_NTFY_URL decides which instance."
            />
            <Button
              label="Add"
              loading={createChannel.isPending}
              onPress={() => {
                if (!ntfyTopic.trim()) return;
                createChannel.mutate(
                  { type: 'ntfy', config: { topic: ntfyTopic.trim() }, priority: 10 },
                  { onSuccess: () => setNtfyTopic('') },
                );
              }}
            />
          </View>
        </Card>
      </View>

      {/* ---------------------------------------------------------------- connection */}
      <View>
        <SectionLabel>CONNECTION</SectionLabel>
        <Card style={styles.card}>
          <Txt variant="tiny" color={color.textMuted}>
            Which Lura server this app talks to. On a phone, localhost is the phone — use your machine&apos;s
            address on the same network.
          </Txt>
          <Field label="Server URL" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" />
          <Field
            label="API token"
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            secureTextEntry
            hint="Phase 1 uses a static bearer token (LURA_API_TOKEN). Zitadel-issued JWTs land in Phase 2."
          />
          <Button
            label="Connect"
            small
            style={styles.selfStart}
            onPress={() => {
              setConnection({ baseUrl: baseUrl.trim(), token: token.trim() });
              pushToast({ kind: 'info', title: 'Reconnecting', body: baseUrl.trim() });
            }}
          />
        </Card>
      </View>

      {/* ---------------------------------------------------------------- about */}
      <View>
        <SectionLabel>ABOUT THIS DEPLOYMENT</SectionLabel>
        <Card style={styles.card}>
          <Row label="Version" value={data?.server.version ?? '—'} />
          <Row label="Store" value={data?.server.store ?? '—'} />
          <Row label="Phase" value={data?.server.phase ?? '—'} />
          <Row label="AI engine" value={data?.server.aiEngine ?? '—'} />
          <Row label="Push channels" value={(data?.server.pushChannels ?? []).join(', ') || '—'} />
          <Row
            label="Fly-by filter"
            value={`arrive confirms after ${Math.round((data?.server.freshWindowSeconds ?? 0) / 60)} min freshness window`}
          />
          <Row label="Cool-off" value={`${Math.round((data?.server.coolOffSeconds ?? 0) / 60)} min per place/trigger`} />
          <Txt variant="micro" color={color.textFaint} style={styles.licence}>
            Lura is open source and self-hosted: Go, PostgreSQL/PostGIS, MapLibre, OpenTelemetry, OpenSearch,
            ntfy, Expo. No component phones home.
          </Txt>
        </Card>
      </View>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.aboutRow}>
      <Txt variant="small" color={color.textMuted}>
        {label}
      </Txt>
      <Mono size={size.monoSm} color={color.textBody} style={styles.aboutValue}>
        {value}
      </Mono>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.page, paddingHorizontal: space.pageX, gap: space.page, maxWidth: 760 },
  header: { gap: 5 },

  card: { gap: space.lg, borderRadius: radius.cardLg, padding: space.xxl },
  hint: { marginTop: 2, maxWidth: 560 },
  row: { flexDirection: 'row', gap: space.lg, flexWrap: 'wrap', alignItems: 'flex-end' },
  rowBetween: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xl },
  divider: { height: 1, backgroundColor: color.hairline, marginVertical: space.sm },
  selfStart: { alignSelf: 'flex-start' },

  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' },
  channelHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  tokenBox: {
    gap: 4,
    backgroundColor: color.amberSofter,
    borderWidth: 1,
    borderColor: color.amberBorder,
    borderRadius: radius.lg,
    padding: space.lg,
  },

  aboutRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  aboutValue: { flex: 1, textAlign: 'right' },
  licence: { marginTop: space.md, lineHeight: 16 },
});
