// QA assets live in the workspace; production findRoot returns the app folder.
const fs = require('node:fs');
const path = require('node:path');
const { findRoot } = require('../bridge.cjs');
function testPaths() {
  const app = findRoot();
  const parent = path.resolve(app, '..', '..');
  const root = fs.existsSync(path.join(parent, 'projects/pixel-farm-starter/project.godot')) ? parent : app;
  const verification = path.join(root, 'verification/electron-studio');
  fs.mkdirSync(verification, { recursive: true });
  return { root, app, verification };
}
module.exports = { testPaths };
