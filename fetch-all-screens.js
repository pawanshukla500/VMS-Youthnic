const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');

const screenIds = [
  '0671fac105fb4dba81046b43580da795', // Video Library
  '66c9c96bd25f458c8e057dab6e6ce0d3', // Login
  'a2fec6c22e72492f8901786f8f5442a5', // Packing Station
  'asset-stub-assets_1f21c037339146a2a4e0cd9f04a468f3', // Design System
  'b8ab696999664f209d536e257ede239f' // Admin Dashboard
];
let currentScreenIdx = 0;
let requestCount = 2; // start after initialize
let callToolSent = false;
let results = [];

const mcpProcess = spawn('npx.cmd', [
  '-y',
  'mcp-remote',
  'https://stitch.googleapis.com/mcp',
  '--header',
  'X-Goog-Api-Key: AQ.Ab8RN6KLhEKFdgE0UBvDOGS9-_wHLCcbAydJ5DugPVqptt8DLA'
], { stdio: ['pipe', 'pipe', 'pipe'] });

let stdoutBuffer = '';

function fetchNextScreen() {
  if (currentScreenIdx >= screenIds.length) {
    console.log('All screens fetched metadata. Shutting down MCP.');
    mcpProcess.kill();
    return;
  }
  const id = screenIds[currentScreenIdx];
  const callReq = {
    jsonrpc: '2.0', id: requestCount, method: 'tools/call',
    params: {
      name: 'get_screen',
      arguments: {
        name: `projects/6563530610306299077/screens/${id}`
      }
    }
  };
  console.log(`Fetching screen ${id} (reqId=${requestCount})...`);
  mcpProcess.stdin.write(JSON.stringify(callReq) + '\n');
}

mcpProcess.stdout.on('data', (data) => {
  stdoutBuffer += data.toString();
  
  if (stdoutBuffer.includes('"id":1,') && !callToolSent) {
    callToolSent = true;
    const initializedReq = { jsonrpc: '2.0', method: 'notifications/initialized' };
    mcpProcess.stdin.write(JSON.stringify(initializedReq) + '\n');
    fetchNextScreen();
  }
  
  // Extract JSON responses line by line
  let lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop(); // keep remainder
  
  for (const line of lines) {
    if (line.includes('"id":' + requestCount + ',')) {
      try {
        const res = JSON.parse(line);
        if (res.result && res.result.content && res.result.content[0] && res.result.content[0].text) {
          const screenData = JSON.parse(res.result.content[0].text);
          if (screenData.htmlCode && screenData.htmlCode.downloadUrl) {
            results.push({
              id: screenIds[currentScreenIdx],
              title: screenData.title,
              url: screenData.htmlCode.downloadUrl
            });
            console.log(`Got URL for ${screenData.title}`);
          } else {
            console.log(`No HTML URL for ${screenIds[currentScreenIdx]}`);
          }
        }
        currentScreenIdx++;
        requestCount++;
        fetchNextScreen();
      } catch(e) {
        console.error('Error parsing:', e);
      }
    } else if (line.includes('"error"')) {
      console.log('MCP Error:', line);
      currentScreenIdx++;
      requestCount++;
      fetchNextScreen();
    }
  }
});

mcpProcess.stderr.on('data', () => {});

mcpProcess.on('exit', () => {
  fs.writeFileSync('mcp-urls.json', JSON.stringify(results, null, 2));
  console.log('Saved mcp-urls.json');
  
  // Now download all URLs
  results.forEach(res => {
    const filename = res.title.replace(/\s+/g, '-').toLowerCase() + '.html';
    console.log(`Downloading ${filename}...`);
    https.get(res.url, (response) => {
      let file = fs.createWriteStream(filename);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`Saved ${filename}`);
      });
    }).on('error', (err) => {
      console.error(`Error downloading ${filename}:`, err);
    });
  });
});

const initReq = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'antigravity', version: '1.0' } }
};

setTimeout(() => mcpProcess.stdin.write(JSON.stringify(initReq) + '\n'), 5000);
