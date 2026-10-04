#!/usr/bin/env node
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { MeeshoAutomator } = require('./meeshoAutomator');

const configPath = path.join(__dirname, 'config.json');
let config = {};
try {
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch (e) {
  console.warn('Could not read config.json, using defaults');
}

const automator = new MeeshoAutomator(config);

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function handleCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    console.log('CSV file is empty or only has headers.');
    return;
  }

  await automator.ensureLoggedIn();
  console.log(`\n📄 Loaded ${lines.length - 1} rows from CSV.`);

  let successCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const trackingId = cols[0];
    const flyerId = cols[1];
    if (!trackingId || !flyerId) continue;

    console.log(`\nRow ${i}: AWB=${trackingId} Flyer=${flyerId}`);
    const res = await automator.linkPacketPair(trackingId, flyerId);
    if (res.success) successCount++;
    await new Promise(r => setTimeout(r, 1200));
  }

  console.log(`\n🎉 Processed CSV: ${successCount}/${lines.length - 1} successfully linked.`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--login')) {
    await automator.ensureLoggedIn();
    console.log('\nLogin session is active and saved! You can now run sync.');
    process.exit(0);
  }

  if (args.includes('--sync')) {
    await automator.runSyncLoop();
    process.exit(0);
  }

  const csvIdx = args.indexOf('--csv');
  if (csvIdx !== -1 && args[csvIdx + 1]) {
    await handleCsv(args[csvIdx + 1]);
    process.exit(0);
  }

  // Interactive menu
  console.log('========================================================');
  console.log('   📦 MEESHO FLYER LINK-UP COMPANION TOOL');
  console.log('   VMS-Youthnic Real-time Automation');
  console.log('========================================================');
  console.log('1. Login to Meesho (save browser session)');
  console.log('2. Sync Pending Queue from VMS Server');
  console.log('3. Process Scanned CSV File');
  console.log('4. Continuous Monitor Mode (Sync every 30s)');
  console.log('5. Exit');
  console.log('--------------------------------------------------------');

  const choice = await prompt('Select an option (1-5): ');

  if (choice.trim() === '1') {
    await automator.ensureLoggedIn();
    console.log('Login complete!');
  } else if (choice.trim() === '2') {
    await automator.runSyncLoop();
  } else if (choice.trim() === '3') {
    const p = await prompt('Enter path to CSV file: ');
    await handleCsv(p.trim());
  } else if (choice.trim() === '4') {
    await automator.ensureLoggedIn();
    console.log('\n🔄 Continuous monitoring active. Press Ctrl+C to stop.');
    while (true) {
      try {
        await automator.runSyncLoop();
      } catch (e) {
        console.error('Error during sync interval:', e.message);
      }
      console.log(`Waiting ${config.pollIntervalSeconds || 30} seconds for next check...`);
      await new Promise(r => setTimeout(r, (config.pollIntervalSeconds || 30) * 1000));
    }
  } else {
    console.log('Exiting.');
  }

  await automator.closeBrowser();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
