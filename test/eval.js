'use strict';
/**
 * Evaluate a JavaScript expression inside the running Blockbench over CDP.
 *
 *   node test/eval.js "Plugins.registered['blockbench_mcp'] ? 'loaded' : 'missing'"
 *   node test/eval.js @expr.js          # read the expression from a file
 *
 * Requires Blockbench to be running with --remote-debugging-port (install.js --register uses 9333).
 */

const fs = require('node:fs');
const PORT = Number(process.env.BLOCKBENCH_MCP_DEBUG_PORT || 9333);

(async () => {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: node test/eval.js <expression|@file>'); process.exit(2); }
  const expression = arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg;

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
  const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) { console.error('no Blockbench page target on port ' + PORT); process.exit(1); }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = () => rej(new Error('CDP connect failed')); });
  const result = await new Promise((res, rej) => {
    const id = 1;
    const timer = setTimeout(() => rej(new Error('CDP evaluate timed out')), 15000);
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
    };
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  socket.close();
  if (result.exceptionDetails) {
    console.error('exception:', result.exceptionDetails.exception && result.exceptionDetails.exception.description || JSON.stringify(result.exceptionDetails));
    process.exit(1);
  }
  console.log(typeof result.result.value === 'string' ? result.result.value : JSON.stringify(result.result.value, null, 2));
})().catch((err) => { console.error(err.message); process.exit(1); });
