const fs = require('fs');
const https = require('https');
const path = require('path');

const agents = [
  { category: 'security', file: 'security-appsec-engineer.md', slug: 'agency-security-appsec-engineer' },
  { category: 'security', file: 'security-secrets-credential-engineer.md', slug: 'agency-security-secrets-credential-engineer' },
  { category: 'security', file: 'security-architect.md', slug: 'agency-security-architect' },
  { category: 'security', file: 'security-penetration-tester.md', slug: 'agency-security-penetration-tester' },
  { category: 'security', file: 'security-ai-generated-code-auditor.md', slug: 'agency-security-ai-generated-code-auditor' },
  { category: 'engineering', file: 'engineering-code-reviewer.md', slug: 'agency-engineering-code-reviewer' }
];

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function run() {
  for (const agent of agents) {
    const url = `https://raw.githubusercontent.com/msitarzewski/agency-agents/main/${agent.category}/${agent.file}`;
    console.log('Fetching', url);
    const content = await fetch(url);

    // Parse frontmatter
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!fmMatch) {
      console.error('No frontmatter found in', agent.file);
      continue;
    }
    const fmText = fmMatch[1];
    const body = fmMatch[2];

    let name = agent.slug;
    let description = '';
    const descMatch = fmText.match(/description:\s*(.*)/);
    if (descMatch) {
      description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
    }

    const skillContent = `---
name: '${name}'
description: '${description.replace(/'/g, "''")}'
---

${body.trim()}
`;

    const outDir = path.join('.agents', 'skills', agent.slug);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'SKILL.md');
    fs.writeFileSync(outFile, skillContent, 'utf8');
    console.log('Saved', outFile, 'size:', skillContent.length);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
