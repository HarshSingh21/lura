/**
 * Expo config plugin: wires Mappls' native SDK into a prebuild.
 *
 * mappls-map-react-native ships an app.plugin.js that points at a build output
 * it does not publish, so it cannot be used as a plugin. This one does the three
 * things its setup guide asks for by hand:
 *
 *   - Android: add Mappls' Maven repository, and copy the `<appId>.a.olf` /
 *     `<appId>.a.conf` licence pair into android/app, where the SDK's Gradle
 *     task looks for it.
 *   - iOS: call `$MAPPLS_MAPS.post_install(installer)` from the Podfile, which
 *     adds Mappls' Swift packages, and bundle the `<appId>.i.olf` /
 *     `<appId>.i.conf` pair as app resources.
 *
 * It is inert unless the build is made with LURA_MAPPLS=1 — the same switch
 * react-native.config.js uses to link the SDK at all — so the default build
 * stays the open one. The licence files are secrets of the account that issued
 * them and are never committed: they live in `credentialsDir` (default
 * ./mappls, gitignored). See docs/mappls.md.
 */
const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withDangerousMod,
  withProjectBuildGradle,
  withXcodeProject,
} = require('expo/config-plugins');

const MAVEN_URL = 'https://maven.mappls.com/repository/mappls/';
const MARKER = '// lura: mappls maven repository';
const POD_HOOK = '$MAPPLS_MAPS.post_install(installer)';

/** licencePair finds the .olf and its matching .conf for one platform. */
function licencePair(dir, platform) {
  const olfExt = `.${platform}.olf`;
  const confExt = `.${platform}.conf`;
  const label = platform === 'a' ? 'Android' : 'iOS';
  if (!fs.existsSync(dir)) {
    throw new Error(
      `[with-mappls] LURA_MAPPLS=1 but ${dir} does not exist. Download the ${label} ` +
        `licence files from https://auth.mappls.com/console/ into it (docs/mappls.md).`,
    );
  }
  const olf = fs.readdirSync(dir).find((name) => name.endsWith(olfExt));
  if (!olf) {
    throw new Error(`[with-mappls] no *${olfExt} file in ${dir} — the ${label} Mappls SDK cannot start without it.`);
  }
  const conf = olf.slice(0, -olfExt.length) + confExt;
  if (!fs.existsSync(path.join(dir, conf))) {
    throw new Error(`[with-mappls] ${olf} has no matching ${conf} in ${dir}.`);
  }
  return [path.join(dir, olf), path.join(dir, conf)];
}

function withMapplsAndroid(config, dir) {
  config = withProjectBuildGradle(config, (cfg) => {
    if (!cfg.modResults.contents.includes(MARKER)) {
      // A separate allprojects block is additive in Groovy, so this does not
      // depend on the exact shape of the template's own repositories block.
      cfg.modResults.contents += `\n${MARKER}\nallprojects {\n  repositories {\n    maven { url '${MAVEN_URL}' }\n  }\n}\n`;
    }
    return cfg;
  });

  return withDangerousMod(config, [
    'android',
    (cfg) => {
      const appDir = path.join(cfg.modRequest.platformProjectRoot, 'app');
      for (const file of licencePair(dir, 'a')) {
        fs.copyFileSync(file, path.join(appDir, path.basename(file)));
      }
      return cfg;
    },
  ]);
}

function withMapplsIos(config, dir) {
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      let contents = fs.readFileSync(podfile, 'utf8');
      if (!contents.includes(POD_HOOK)) {
        const hook = /post_install do \|installer\|\n/;
        if (!hook.test(contents)) {
          throw new Error('[with-mappls] the Podfile has no post_install block to hook Mappls into.');
        }
        contents = contents.replace(hook, (line) => `${line}    ${POD_HOOK}\n`);
        fs.writeFileSync(podfile, contents);
      }

      const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
      const target = path.join(cfg.modRequest.platformProjectRoot, projectName);
      for (const file of licencePair(dir, 'i')) {
        fs.copyFileSync(file, path.join(target, path.basename(file)));
      }
      return cfg;
    },
  ]);

  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
    for (const file of licencePair(dir, 'i')) {
      const filepath = path.join(projectName, path.basename(file));
      if (!project.hasFile(filepath)) {
        IOSConfig.XcodeUtils.addResourceFileToGroup({
          filepath,
          groupName: projectName,
          project,
          isBuildFile: true,
        });
      }
    }
    return cfg;
  });
}

module.exports = function withMappls(config, options = {}) {
  if (process.env.LURA_MAPPLS !== '1') return config;
  const dir = path.resolve(config._internal?.projectRoot ?? process.cwd(), options.credentialsDir ?? 'mappls');
  config = withMapplsAndroid(config, dir);
  config = withMapplsIos(config, dir);
  return config;
};
