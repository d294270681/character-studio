const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appDirectory } = require('./runtime-paths.cjs');
const { findRoot } = require('./bridge.cjs');

function configure() {
  const root = findRoot();
  const file = path.join(process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code'), 'mcp.json');
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  current.mcpServers ||= {};
  const previous = current.mcpServers.character_studio;
  const entry = {
    command: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    args: [path.join(appDirectory(root), 'electron', 'mcp.cjs')], cwd: root,
    env: { CHARACTER_STUDIO_ROOT: root }, startupTimeoutMs: 30000, toolTimeoutMs: 60000,
  };
  if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
    throw new Error('已存在不同的 character_studio 配置，请先核对后再安装。');
  }
  if (!previous) {
    current.mcpServers.character_studio = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.character-studio.tmp';
    fs.writeFileSync(temporary, JSON.stringify(current, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, file);
  }
  return { configured: true, config_path: file, server: 'character_studio' };
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(configure(), null, 2) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exit(1); }
}
module.exports = { configure };
