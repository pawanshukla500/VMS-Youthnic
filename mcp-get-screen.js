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
let callToolSent = false;

mcpProcess.stdout.on('data', (data) => {
  stdoutBuffer += data.toString();
  
  if (stdoutBuffer.includes('"id":1,') && !callToolSent) {
    callToolSent = true;
    const initializedReq = { jsonrpc: '2.0', method: 'notifications/initialized' };
    mcpProcess.stdin.write(JSON.stringify(initializedReq) + '\n');
    
    const callReq = {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'get_screen',
        arguments: {
          name: 'projects/6563530610306299077/screens/a2fec6c22e72492f8901786f8f5442a5'
        }
      }
    };
    mcpProcess.stdin.write(JSON.stringify(callReq) + '\n');
  }
  
  if (stdoutBuffer.includes('"id":2,')) {
    try {
      const parts = stdoutBuffer.split('\n');
      for (const part of parts) {
        if (part.includes('"id":2,')) {
          fs.writeFileSync('mcp-screen.json', part);
          console.log('Screen saved to mcp-screen.json');
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
