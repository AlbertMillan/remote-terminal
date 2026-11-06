import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// @ts-expect-error -- a plain .mjs script with no type declarations
import { cmdLine, findSdk, localProperties } from '../scripts/android.mjs';

/**
 * scripts/android.mjs drives Gradle on Windows without Android Studio: it must write a
 * local.properties Gradle can parse and find the SDK the environment names.
 */

describe('scripts/android.mjs', () => {
  it('escapes a Windows SDK path for a Java properties file', () => {
    const text = localProperties('C:\\Users\\Albert\\AppData\\Local\\Android\\Sdk');
    expect(text).toContain('sdk.dir=C\\:\\\\Users\\\\Albert\\\\AppData\\\\Local\\\\Android\\\\Sdk\n');
  });

  it('quotes gradlew.bat for cmd /s, so a checkout path with spaces works', () => {
    expect(cmdLine('C:\\Users\\Jo Doe\\repo\\android\\gradlew.bat', ['assembleDebug', '--info'])).toBe(
      '""C:\\Users\\Jo Doe\\repo\\android\\gradlew.bat" "assembleDebug" "--info""'
    );
  });

  it('refuses a Gradle argument cmd would act on', () => {
    expect(() => cmdLine('C:\\g.bat', ['a&calc'])).toThrow(/refusing/);
    expect(() => cmdLine('C:\\g.bat', ['%PATH%'])).toThrow(/refusing/);
  });

  it('leaves a POSIX SDK path readable', () => {
    expect(localProperties('/home/a/Android/Sdk')).toContain('sdk.dir=/home/a/Android/Sdk\n');
  });

  it('takes ANDROID_HOME when it holds an SDK, and skips one that does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-android-sdk-'));
    try {
      const sdk = join(dir, 'sdk');
      mkdirSync(join(sdk, 'platforms'), { recursive: true });
      expect(findSdk({ ANDROID_HOME: sdk })).toBe(sdk);
      expect(findSdk({ ANDROID_HOME: join(dir, 'missing'), ANDROID_SDK_ROOT: sdk })).toBe(sdk);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
