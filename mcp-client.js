const { spawn } = require('child_process');

const mcpProcess = spawn('npx.cmd', [
  '-y',
  'mcp-remote',
  'https://stitch.googleapis.com/mcp',
  '--header',
  'X-Goog-Api-Key: AQ.Ab8RN6KLhEKFdgE0UBvDOGS9-_wHLCcbAydJ5DugPVqptt8DLA'
], { stdio: ['pipe', 'pipe', 'pipe'] });

let buffer = '';

mcpProcess.stdout.on('data', (data) => {
  const str = data.toString();
  console.log('STDOUT:', str);
  if (str.includes('"id":1')) {
    console.log('Received initialize response. Sending initialized notification and tools/list request...');
    const initializedReq = {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    };
    mcpProcess.stdin.write(JSON.stringify(initializedReq) + '\n');
    
    const listReq = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    };
    mcpProcess.stdin.write(JSON.stringify(listReq) + '\n');
  }
});

mcpProcess.stderr.on('data', (data) => {
  console.log('STDERR:', data.toString());
});

const initReq = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'antigravity-script', version: '1.0.0' }
  }
};

setTimeout(() => {
  console.log('Sending initialize request...');
  mcpProcess.stdin.write(JSON.stringify(initReq) + '\n');
}, 5000); // give npx time to start

setTimeout(() => {
  mcpProcess.kill();
}, 60000);
