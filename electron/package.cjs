const fs = require('node:fs');
const path = require('node:path');
const { packager } = require('@electron/packager');

function cachedElectronFolder(version) {
  const filename = `electron-v${version}-win32-x64.zip`;
  const explicit = process.env.ELECTRON_ZIP_DIR;
  if (explicit && fs.existsSync(path.join(explicit, filename))) return explicit;
  const cache = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron', 'Cache');
  if (!cache || !fs.existsSync(cache)) return undefined;
  for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(cache, entry.name);
    if (fs.existsSync(path.join(folder, filename))) return folder;
  }
  return undefined;
}

async function main() {
  const electronVersion = require('electron/package.json').version;
  const electronZipDir = cachedElectronFolder(electronVersion);
  const output = await packager({ dir: __dirname, out: path.resolve(__dirname, '..', 'dist-electron'),
    name: 'CharacterStudio', executableName: 'CharacterStudio', platform: 'win32', arch: 'x64',
    electronVersion, ...(electronZipDir ? { electronZipDir } : {}), overwrite: true, asar: true, prune: true,
    icon: path.resolve(__dirname, '..', 'studio.ico'),
    appVersion: require('./package.json').version, appCopyright: 'Character Studio',
    win32metadata: { CompanyName: 'Character Studio', FileDescription: '角色工坊 · Qwen + MiniMax H3', ProductName: '角色工坊' },
    ignore: [/^\/(src|tests|node_modules)(\/|$)/, /\/package-lock\.json$/, /\/vite\.config\.mjs$/, /\/package\.cjs$/],
  });
  process.stdout.write(output.join('\n') + '\n');
}
main().catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exit(1); });
