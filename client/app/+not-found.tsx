import { StyleSheet, View } from 'react-native';
import { Link } from 'expo-router';

import { Txt } from '@/theme/text';
import { color, palette, space } from '@/theme/tokens';

/** A 404 that offers the way back rather than a dead end. */
export default function NotFound() {
  return (
    <View style={styles.root}>
      <Txt variant="h1">That page does not exist</Txt>
      <Txt variant="body" color={color.textMuted}>
        A share link looks like /share/&lt;token&gt;. Everything else lives in the control centre.
      </Txt>
      <Link href="/" style={styles.link}>
        <Txt variant="bodySemi" color={palette.accentDark}>
          Back to the live map
        </Txt>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg, padding: space.page, backgroundColor: color.bg },
  link: { marginTop: space.md },
});
