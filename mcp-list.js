const { spawn } = require('child_process');
const fs = require('fs');

const mcpProcess = spawn('npx.cmd', [
  '-y',
  'mcp-remote',
  'https://stitch.googleapis.com/mcp',
  '--header',
  'X-Goog-Api-Key: AQ.Ab8RN6KLhEKFdgE0UBvDOGS9-_wHLCcbAydJ5DugPVqptt8DLA'
], { stdio: ['pipe', 'pipe', 'pipe'] });

let stdoutBuffer = '';

mcpProcess.stdout.on('data', (data) => {
  stdoutBuffer += data.toString();
  
  if (stdoutBuffer.includes('"id":1,')) {
    const initializedReq = { jsonrpc: '2.0', method: 'notifications/initialized' };
    mcpProcess.stdin.write(JSON.stringify(initializedReq) + '\n');
    
    const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
    mcpProcess.stdin.write(JSON.stringify(listReq) + '\n');
  }
  
  if (stdoutBuffer.includes('"id":2,')) {
    try {
      const parts = stdoutBuffer.split('\n');
      for (const part of parts) {
        if (part.includes('"id":2,')) {
          const res = JSON.parse(part);
          const toolNames = res.result.tools.map(t => t.name);
          fs.writeFileSync('mcp-tools.txt', toolNames.join('\n'));
          console.log('Tools saved to mcp-tools.txt');
          mcpProcess.kill();
        }
      }
    } catch(e) {}
  }
});

mcpProcess.stderr.on('data', () => {});

const initReq = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'antigravity', version: '1.0' } }
};

setTimeout(() => mcpProcess.stdin.write(JSON.stringify(initReq) + '\n'), 5000);
