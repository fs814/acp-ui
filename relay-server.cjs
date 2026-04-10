const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.RELAY_PORT || '9800', 10);
const AGENT_CMD = process.env.RELAY_AGENT_CMD || 'npx';
const AGENT_ARGS = (process.env.RELAY_AGENT_ARGS || '@zed-industries/claude-code-acp@latest').split(' ');

const wss = new WebSocketServer({ port: PORT });
console.log(`Relay listening on ws://0.0.0.0:${PORT}`);
console.log(`Agent command: ${AGENT_CMD} ${AGENT_ARGS.join(' ')}`);

const CWD_PREFIX = '__cwd__:';

wss.on('connection', (ws) => {
  console.log('Client connected, waiting for initialization...');

  let child = null;
  let stdoutBuffer = '';
  const pendingMessages = [];

  function spawnAgent(cwd) {
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    };
    if (cwd) {
      spawnOpts.cwd = cwd;
      console.log(`Spawning agent in directory: ${cwd}`);
    }

    child = spawn(AGENT_CMD, AGENT_ARGS, spawnOpts);

    // Agent stdout -> WS (line-buffered, one JSON-RPC message per frame)
    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split('\n');
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

    child.on('exit', (code) => {
      console.log(`Agent exited with code ${code}`);
      if (ws.readyState === ws.OPEN) {
        ws.close();
      }
    });

    // Flush any messages that arrived before spawn completed
    for (const msg of pendingMessages) {
      child.stdin.write(msg + '\n');
    }
    pendingMessages.length = 0;
  }

  ws.on('message', (msg) => {
    const text = msg.toString();

    // First message may be a cwd control message
    if (!child && text.startsWith(CWD_PREFIX)) {
      const cwd = text.slice(CWD_PREFIX.length).trim();
      spawnAgent(cwd || null);
      return;
    }

    // If agent not yet spawned (no cwd message received), spawn with default cwd
    if (!child) {
      spawnAgent(null);
    }

    if (child && child.stdin.writable) {
      child.stdin.write(text + '\n');
    } else {
      pendingMessages.push(text);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected, killing agent');
    if (child) child.kill();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    if (child) child.kill();
  });
});
