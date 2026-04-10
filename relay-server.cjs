const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.RELAY_PORT || '9800', 10);
const AGENT_CMD = process.env.RELAY_AGENT_CMD || 'npx';
const AGENT_ARGS = (process.env.RELAY_AGENT_ARGS || '@zed-industries/claude-code-acp@latest').split(' ');

const CWD_PREFIX = '__cwd__:';

// HTTP server handles both REST API and WebSocket upgrade
const server = http.createServer(async (req, res) => {
  // CORS headers for dev mode
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/ls') {
    const targetPath = url.searchParams.get('path') || os.homedir();

    try {
      const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => ({ name: e.name, isDir: true }))
        .sort((a, b) => {
          const aHidden = a.name.startsWith('.');
          const bHidden = b.name.startsWith('.');
          if (aHidden !== bHidden) return aHidden ? 1 : -1;
          return a.name.localeCompare(b.name);
        });

      const resolved = path.resolve(targetPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: resolved, entries: dirs }));
    } catch (err) {
      const status = err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log(`Relay listening on http://0.0.0.0:${PORT} (HTTP + WebSocket)`);
  console.log(`Agent command: ${AGENT_CMD} ${AGENT_ARGS.join(' ')}`);
});

wss.on('connection', (ws) => {
  console.log('Client connected, waiting for initialization...');

  let child = null;
  let stdoutBuffer = '';
  const pendingMessages = [];

  function spawnAgent(cwd) {
    const isWindows = process.platform === 'win32';
    const spawnOpts = {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows ? 'cmd.exe' : true,
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
