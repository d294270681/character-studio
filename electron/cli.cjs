const { StudioBridge } = require('./bridge.cjs');
const { callTool } = require('./mcp.cjs');

async function main() {
  const name = process.argv[2] || 'studio_get_state';
  const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  const result = await callTool(new StudioBridge(), name, args);
  // Do not print binary image blocks into a terminal; use MCP for vision.
  const output = result?.content ? { content: result.content.filter(item => item.type === 'text') } : result;
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exit(1); });
