const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.RELAY_PORT || '9800', 10);
const AGENT_CMD = process.env.RELAY_AGENT_CMD || 'npx';
const AGENT_ARGS = (process.env.RELAY_AGENT_ARGS || '@zed-industries/claude-code-acp@latest').split(' ');

const wss = new WebSocketServer({ port: PORT });
console.log(`Relay listening on ws://0.0.0.0:${PORT}`);
console.log(`Agent command: ${AGENT_CMD} ${AGENT_ARGS.join(' ')}`);

wss.on('connection', (ws) => {
  console.log('Client connected, spawning agent...');

  const child = spawn(AGENT_CMD, AGENT_ARGS, {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  let stdoutBuffer = '';

  // Agent stdout -> WS (line-buffered, one JSON-RPC message per frame)
  child.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    // Keep the last (possibly incomplete) chunk in the buffer
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        ws.send(line);
      }
    }
  });

  child.stderr.on('data', (data) => {
    process.stderr.write(`[agent stderr] ${data}`);
  });

  // WS -> agent stdin
  ws.on('message', (msg) => {
    child.stdin.write(msg.toString() + '\n');
  });

  // Cleanup on agent exit
  child.on('exit', (code) => {
    console.log(`Agent exited with code ${code}`);
    if (ws.readyState === ws.OPEN) {
      ws.close();
    }
  });

  // Cleanup on client disconnect
  ws.on('close', () => {
    console.log('Client disconnected, killing agent');
    child.kill();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    child.kill();
  });
});
