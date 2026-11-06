// Build, test and install the Android app (android/) without Android Studio open.
// `node scripts/android.mjs <build|test|install|gradle> [extra gradle args]`, exposed as
// `npm run android:build` / `android:test` / `android:install`. Windows-native: the PATH
// `java` on this PC is 1.8, which Gradle refuses, so this finds Android Studio's bundled
// JDK and the SDK itself, writes android/local.properties, and runs gradlew.bat.
// docs/android-app.md
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(root, 'android');
const isWindows = process.platform === 'win32';

const TASKS = {
  build: ['assembleDebug'],
  test: ['testDebugUnitTest'],
  install: ['installDebug'],
  gradle: [],
};

function javaOk(home) {
  return !!home && existsSync(join(home, 'bin', isWindows ? 'java.exe' : 'java'));
}

/** JAVA_HOME only if it is not the 1.8 on PATH; else Android Studio's bundled JBR. */
export function findJdk(env = process.env) {
  const candidates = [];
  if (env.ANDROID_JAVA_HOME) candidates.push(env.ANDROID_JAVA_HOME);
  const studio = isWindows
    ? [
        join(env.ProgramFiles ?? 'C:\\Program Files', 'Android', 'Android Studio', 'jbr'),
        join(env.LOCALAPPDATA ?? '', 'Programs', 'Android Studio', 'jbr'),
      ]
    : process.platform === 'darwin'
      ? ['/Applications/Android Studio.app/Contents/jbr/Contents/Home']
      : ['/opt/android-studio/jbr', join(homedir(), 'android-studio', 'jbr')];
  candidates.push(...studio);
  // A JAVA_HOME pointing at Java 8 fails Gradle with an unhelpful error; prefer the JBR.
  if (env.JAVA_HOME && !/1\.8|jdk8|jre8/i.test(env.JAVA_HOME)) candidates.push(env.JAVA_HOME);
  return candidates.find(javaOk) ?? null;
}

export function findSdk(env = process.env) {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT];
  if (isWindows) candidates.push(join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk'));
  else if (process.platform === 'darwin') candidates.push(join(homedir(), 'Library', 'Android', 'sdk'));
  else candidates.push(join(homedir(), 'Android', 'Sdk'));
  return candidates.find((p) => !!p && existsSync(join(p, 'platforms'))) ?? null;
}

/** local.properties is a Java properties file: `\` and `:` must be escaped. */
export function localProperties(sdkDir) {
  const escaped = sdkDir.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  return `# Written by scripts/android.mjs; machine-specific, never committed.\nsdk.dir=${escaped}\n`;
}

function writeLocalProperties(sdkDir) {
  const file = join(androidDir, 'local.properties');
  const content = localProperties(sdkDir);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current !== content) writeFileSync(file, content);
}

function run(args, env) {
  return new Promise((resolve) => {
    // Node refuses to spawn a .bat directly (CVE-2024-27980), so go through cmd.exe, with a
    // full path: cmd skips the current folder when NoDefaultCurrentDirectoryInExePath is set.
    const child = isWindows
      ? spawn('cmd.exe', ['/d', '/s', '/c', join(androidDir, 'gradlew.bat'), ...args], { cwd: androidDir, env, stdio: 'inherit' })
      : spawn(join(androidDir, 'gradlew'), args, { cwd: androidDir, env, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error(err.message);
      resolve(1);
    });
  });
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (!command || !(command in TASKS)) {
    console.error(`usage: node scripts/android.mjs <${Object.keys(TASKS).join('|')}> [gradle args]`);
    process.exit(2);
  }
  const jdk = findJdk();
  if (!jdk) {
    console.error('No JDK 17+ found. Install Android Studio, or set ANDROID_JAVA_HOME to a JDK 17+.');
    process.exit(1);
  }
  const sdk = findSdk();
  if (!sdk) {
    console.error('No Android SDK found. Install it from Android Studio, or set ANDROID_HOME.');
    process.exit(1);
  }
  writeLocalProperties(sdk);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const sep = isWindows ? ';' : ':';
  const env = {
    ...process.env,
    JAVA_HOME: jdk,
    ANDROID_HOME: sdk,
    [pathKey]: [join(jdk, 'bin'), join(sdk, 'platform-tools'), process.env[pathKey] ?? ''].join(sep),
  };
  console.log(`android: JDK ${jdk}\nandroid: SDK ${sdk}`);
  const code = await run([...TASKS[command], ...extra], env);
  if (code === 0 && command === 'build') {
    console.log(`android: APK at ${join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')}`);
  }
  process.exit(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  main();
}
