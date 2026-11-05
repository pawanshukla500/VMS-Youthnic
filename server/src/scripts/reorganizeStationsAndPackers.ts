import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
import { buildPostgresPoolConfig } from '../db/poolConfig';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

dotenv.config();

const pool = new Pool(buildPostgresPoolConfig());

const DRY_RUN = process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run');

// Protected admin/manager emails that MUST NEVER be deleted or modified
const PROTECTED_EMAILS = new Set([
  'returnorders@vbexports.co.in',
  'vaibhav@vbexports.co.in',
  'nidhi@vbexports.co.in',
  'orders2@vbexports.co.in',
  'listings@vbexports.co.in'
]);

function initFirebase() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not configured');
  }
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  if (!getApps().length) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    initializeApp({
      credential: cert(serviceAccount),
      storageBucket: bucketName || undefined
    });
  }
  return getAuth();
}

async function run() {
  console.log('=====================================================');
  console.log('REORGANIZE STATIONS AND PACKERS TO PC-1 .. PC-10');
  console.log(`MODE: ${DRY_RUN ? 'DRY RUN (NO CHANGES COMMITTED)' : 'LIVE EXECUTION'}`);
  console.log('=====================================================\n');

  const auth = initFirebase();

  // 1. Get Organization
  const orgsRes = await pool.query(`SELECT id, name FROM organizations ORDER BY created_at ASC`);
  if (orgsRes.rows.length === 0) {
    throw new Error('No organization found');
  }
  const org = orgsRes.rows[0];
  const orgId = org.id;
  console.log(`Target Organization: ${org.name} (${orgId})\n`);

  // 2. Pre-migration Safety Snapshot
  const initialSessionsCount = await pool.query(
    `SELECT COUNT(*) as count FROM recording_sessions WHERE organization_id = $1`,
    [orgId]
  );
  const initialVideosCount = await pool.query(
    `SELECT COUNT(*) as count FROM video_assets WHERE organization_id = $1`,
    [orgId]
  );
  console.log(`[Snapshot] Recording Sessions: ${initialSessionsCount.rows[0].count}`);
  console.log(`[Snapshot] Video Assets: ${initialVideosCount.rows[0].count}\n`);

  // List existing stations
  const stationsRes = await pool.query(
    `SELECT s.id, s.code, s.name, s.active, s.created_at, COUNT(rs.id) as scans
     FROM stations s
     LEFT JOIN recording_sessions rs ON rs.station_id = s.id AND rs.organization_id = s.organization_id
     WHERE s.organization_id = $1
     GROUP BY s.id, s.code, s.name, s.active, s.created_at
     ORDER BY s.code ASC`,
    [orgId]
  );
  console.log(`[Existing Stations] Count: ${stationsRes.rows.length}`);
  for (const s of stationsRes.rows) {
    console.log(`  - ${s.code} (Name: ${s.name || '-'}, Active: ${s.active}, Scans: ${s.scans}, ID: ${s.id})`);
  }
  console.log();

  // List existing users
  const usersRes = await pool.query(
    `SELECT u.id, u.email, u.name, u.firebase_uid, om.role, om.default_station_id, COUNT(rs.id) as recordings
     FROM users u
     JOIN organization_members om ON om.user_id = u.id AND om.organization_id = $1
     LEFT JOIN recording_sessions rs ON rs.operator_user_id = u.id AND rs.organization_id = om.organization_id
     GROUP BY u.id, u.email, u.name, u.firebase_uid, om.role, om.default_station_id
     ORDER BY om.role ASC, u.email ASC`,
    [orgId]
  );
  console.log(`[Existing Users] Count: ${usersRes.rows.length}`);
  for (const u of usersRes.rows) {
    console.log(`  - ${u.email} (Role: ${u.role}, Name: ${u.name}, Recordings: ${u.recordings}, ID: ${u.id})`);
  }
  console.log();

  const client: PoolClient = await pool.connect();

  try {
    await client.query('BEGIN');

    // -------------------------------------------------------------
    // STEP A: REORGANIZE STATIONS TO PC-1 .. PC-10
    // -------------------------------------------------------------
    console.log('=== STEP A: Reorganizing Stations to PC-1 .. PC-10 ===');

    // Map of station number (1..10) to new/existing station ID
    const targetStationIds: Map<number, string> = new Map();

    // Check each target PC-1 .. PC-10
    for (let i = 1; i <= 10; i++) {
      const targetCode = `PC-${i}`;
      const targetName = `PC-${i}`;

      // Check if PC-i already exists
      const existingPc = stationsRes.rows.find((s) => s.code.toUpperCase() === targetCode);
      if (existingPc) {
        console.log(`Station ${targetCode} already exists (ID: ${existingPc.id})`);
        await client.query(
          `UPDATE stations SET active = true, name = $1 WHERE id = $2 AND organization_id = $3`,
          [targetName, existingPc.id, orgId]
        );
        targetStationIds.set(i, existingPc.id);
        continue;
      }

      // Check if an old PS-i / Ps-i / ps-i exists to migrate cleanly
      const oldStation = stationsRes.rows.find((s) => {
        const code = s.code.trim().toUpperCase();
        return code === `PS-${i}` || code === `PS${i}` || code === `STATION ${i}` || code === `STATION-${i}`;
      });

      if (oldStation) {
        console.log(`Migrating existing station ${oldStation.code} -> ${targetCode} (ID: ${oldStation.id}, preserves ${oldStation.scans} scans)`);
        await client.query(
          `UPDATE stations SET code = $1, name = $2, active = true WHERE id = $3 AND organization_id = $4`,
          [targetCode, targetName, oldStation.id, orgId]
        );
        targetStationIds.set(i, oldStation.id);
      } else {
        // Create new station PC-i
        console.log(`Creating new station ${targetCode}`);
        const insertRes = await client.query(
          `INSERT INTO stations (id, organization_id, code, name, active, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, true, NOW())
           RETURNING id`,
          [orgId, targetCode, targetName]
        );
        targetStationIds.set(i, insertRes.rows[0].id);
      }
    }

    // Now identify old stations that are NOT in targetStationIds (e.g. fwpack-1, Packing station 1, etc.)
    const keptStationIdSet = new Set(targetStationIds.values());
    const stationsToDelete = stationsRes.rows.filter((s) => !keptStationIdSet.has(s.id));

    console.log(`\nRemoving ${stationsToDelete.length} obsolete stations:`);
    for (const s of stationsToDelete) {
      console.log(`  - Deleting station ${s.code} (ID: ${s.id}, Scans: ${s.scans})`);
      // Update any recording sessions pointing to this old station to NULL (or to nearest if appropriate)
      await client.query(
        `UPDATE recording_sessions SET station_id = NULL WHERE station_id = $1 AND organization_id = $2`,
        [s.id, orgId]
      );
      // Remove default_station_id reference
      await client.query(
        `UPDATE organization_members SET default_station_id = NULL WHERE default_station_id = $1 AND organization_id = $2`,
        [s.id, orgId]
      );
      // Delete the station row
      await client.query(
        `DELETE FROM stations WHERE id = $1 AND organization_id = $2`,
        [s.id, orgId]
      );
    }

    // -------------------------------------------------------------
    // STEP B: CREATE / CONFIGURE PACKER USERS pack1..pack10@youthnic.shop
    // -------------------------------------------------------------
    console.log('\n=== STEP B: Setting up Packers pack1@youthnic.shop .. pack10@youthnic.shop ===');

    const PACKER_PASSWORD = 'Pack@123';
    // Map of index (1..10) to new user ID
    const newPackerUserIds: Map<number, { userId: string; firebaseUid: string }> = new Map();

    for (let i = 1; i <= 10; i++) {
      const email = `pack${i}@youthnic.shop`;
      const displayName = `PC-${i}`;
      const defaultStationId = targetStationIds.get(i);

      let firebaseUid = '';

      if (!DRY_RUN) {
        // Firebase Auth operations
        try {
          const existingFb = await auth.getUserByEmail(email);
          firebaseUid = existingFb.uid;
          await auth.updateUser(firebaseUid, {
            password: PACKER_PASSWORD,
            displayName,
            disabled: false,
            emailVerified: true
          });
          console.log(`Updated existing Firebase Auth user: ${email} (UID: ${firebaseUid})`);
        } catch (err: any) {
          if (err.code === 'auth/user-not-found') {
            const newFb = await auth.createUser({
              email,
              password: PACKER_PASSWORD,
              displayName,
              disabled: false,
              emailVerified: true
            });
            firebaseUid = newFb.uid;
            console.log(`Created new Firebase Auth user: ${email} (UID: ${firebaseUid})`);
          } else {
            throw err;
          }
        }

        // Set custom claims
        await auth.setCustomUserClaims(firebaseUid, {
          orgId,
          orgRole: 'PACKER'
        });
      } else {
        firebaseUid = `dry-run-uid-${i}`;
        console.log(`[DRY RUN] Would create/update Firebase Auth user: ${email} with password: ${PACKER_PASSWORD}`);
      }

      // Check PostgreSQL user
      let userId = '';
      const existingUserRes = await client.query(
        `SELECT id, firebase_uid FROM users WHERE email = $1`,
        [email]
      );

      if (existingUserRes.rows.length > 0) {
        userId = existingUserRes.rows[0].id;
        if (!DRY_RUN) {
          await client.query(
            `UPDATE users SET firebase_uid = $1, name = $2 WHERE id = $3`,
            [firebaseUid, displayName, userId]
          );
        }
        console.log(`Updated PostgreSQL user for ${email} (ID: ${userId})`);
      } else {
        const insertUserRes = await client.query(
          `INSERT INTO users (id, firebase_uid, email, name, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, NOW())
           RETURNING id`,
          [firebaseUid, email, displayName]
        );
        userId = insertUserRes.rows[0].id;
        console.log(`Inserted PostgreSQL user for ${email} (ID: ${userId})`);
      }

      // Upsert organization_members
      await client.query(
        `INSERT INTO organization_members (id, organization_id, user_id, role, default_station_id, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'PACKER', $3, NOW())
         ON CONFLICT (organization_id, user_id)
         DO UPDATE SET role = 'PACKER', default_station_id = EXCLUDED.default_station_id`,
        [orgId, userId, defaultStationId]
      );
      console.log(`Linked ${email} to Station PC-${i} (Station ID: ${defaultStationId})`);

      newPackerUserIds.set(i, { userId, firebaseUid });
    }

    // -------------------------------------------------------------
    // STEP C: MIGRATE PAST RECORDINGS & DELETE OLD PACKERS
    // -------------------------------------------------------------
    console.log('\n=== STEP C: Migrating Data from Old Packers & Deleting Old Accounts ===');

    for (let i = 1; i <= 10; i++) {
      const oldEmail = `pack${i}@vbexports.co.in`;
      const targetUser = newPackerUserIds.get(i);
      if (!targetUser) continue;

      // Find old user row
      const oldUserRes = await client.query(
        `SELECT u.id, u.firebase_uid, u.email, om.role
         FROM users u
         JOIN organization_members om ON om.user_id = u.id AND om.organization_id = $1
         WHERE LOWER(u.email) = LOWER($2)`,
        [orgId, oldEmail]
      );

      if (oldUserRes.rows.length === 0) {
        continue;
      }

      const oldUser = oldUserRes.rows[0];
      console.log(`Found old packer ${oldUser.email} (ID: ${oldUser.id}) -> migrating data to pack${i}@youthnic.shop (ID: ${targetUser.userId})`);

      // Reassign recording_sessions
      const sessionsMigrated = await client.query(
        `UPDATE recording_sessions
         SET operator_user_id = $1
         WHERE operator_user_id = $2 AND organization_id = $3`,
        [targetUser.userId, oldUser.id, orgId]
      );
      console.log(`  - Reassigned ${sessionsMigrated.rowCount} recording session(s)`);

      // Reassign video_upload_queue_status
      const queueMigrated = await client.query(
        `UPDATE video_upload_queue_status
         SET operator_user_id = $1
         WHERE operator_user_id = $2 AND organization_id = $3`,
        [targetUser.userId, oldUser.id, orgId]
      );
      console.log(`  - Reassigned ${queueMigrated.rowCount} upload queue row(s)`);

      // Reassign audit_logs
      await client.query(
        `UPDATE audit_logs
         SET user_id = $1
         WHERE user_id = $2 AND organization_id = $3`,
        [targetUser.userId, oldUser.id, orgId]
      );

      // Delete from organization_members
      await client.query(
        `DELETE FROM organization_members WHERE user_id = $1 AND organization_id = $2`,
        [oldUser.id, orgId]
      );

      // Delete from users
      await client.query(
        `DELETE FROM users WHERE id = $1`,
        [oldUser.id]
      );
      console.log(`  - Deleted PostgreSQL user for ${oldUser.email}`);

      // Delete from Firebase Auth
      if (!DRY_RUN && oldUser.firebase_uid) {
        try {
          await auth.deleteUser(oldUser.firebase_uid);
          console.log(`  - Deleted Firebase Auth user for ${oldUser.email} (UID: ${oldUser.firebase_uid})`);
        } catch (fbErr: any) {
          console.warn(`  - Warning deleting Firebase user ${oldUser.email}:`, fbErr.message);
        }
      }
    }

    // Check for any remaining old packer accounts with email pack*@vbexports.co.in or role 'PACKER' that are not youthnic.shop
    const remainingPackersRes = await client.query(
      `SELECT u.id, u.firebase_uid, u.email, om.role
       FROM users u
       JOIN organization_members om ON om.user_id = u.id AND om.organization_id = $1
       WHERE om.role = 'PACKER' AND u.email NOT LIKE '%@youthnic.shop'`,
      [orgId]
    );

    for (const extra of remainingPackersRes.rows) {
      if (PROTECTED_EMAILS.has(extra.email.toLowerCase())) {
        console.log(`Skipping protected account: ${extra.email}`);
        continue;
      }
      console.log(`Cleaning up extra obsolete packer account: ${extra.email} (ID: ${extra.id})`);
      await client.query(
        `UPDATE recording_sessions SET operator_user_id = NULL WHERE operator_user_id = $1 AND organization_id = $2`,
        [extra.id, orgId]
      );
      await client.query(
        `DELETE FROM organization_members WHERE user_id = $1 AND organization_id = $2`,
        [extra.id, orgId]
      );
      await client.query(
        `DELETE FROM users WHERE id = $1`,
        [extra.id]
      );
      if (!DRY_RUN && extra.firebase_uid) {
        try {
          await auth.deleteUser(extra.firebase_uid);
          console.log(`  - Deleted Firebase Auth user: ${extra.email}`);
        } catch (fbErr: any) {
          console.warn(`  - Warning deleting Firebase user ${extra.email}:`, fbErr.message);
        }
      }
    }

    // -------------------------------------------------------------
    // STEP D: POST-MIGRATION VERIFICATION
    // -------------------------------------------------------------
    console.log('\n=== STEP D: Verification Checks ===');

    const finalSessionsCount = await client.query(
      `SELECT COUNT(*) as count FROM recording_sessions WHERE organization_id = $1`,
      [orgId]
    );
    const finalVideosCount = await client.query(
      `SELECT COUNT(*) as count FROM video_assets WHERE organization_id = $1`,
      [orgId]
    );

    console.log(`Recording Sessions: before=${initialSessionsCount.rows[0].count}, after=${finalSessionsCount.rows[0].count}`);
    console.log(`Video Assets: before=${initialVideosCount.rows[0].count}, after=${finalVideosCount.rows[0].count}`);

    if (initialSessionsCount.rows[0].count !== finalSessionsCount.rows[0].count) {
      throw new Error(`CRITICAL INTEGRITY FAILURE: Recording sessions count changed! (${initialSessionsCount.rows[0].count} -> ${finalSessionsCount.rows[0].count})`);
    }
    if (initialVideosCount.rows[0].count !== finalVideosCount.rows[0].count) {
      throw new Error(`CRITICAL INTEGRITY FAILURE: Video assets count changed! (${initialVideosCount.rows[0].count} -> ${finalVideosCount.rows[0].count})`);
    }

    // Verify Stations list
    const finalStationsRes = await client.query(
      `SELECT s.id, s.code, s.name, s.active, COUNT(rs.id) as scans
       FROM stations s
       LEFT JOIN recording_sessions rs ON rs.station_id = s.id AND rs.organization_id = s.organization_id
       WHERE s.organization_id = $1
       GROUP BY s.id, s.code, s.name, s.active
       ORDER BY s.code ASC`,
      [orgId]
    );
    console.log(`\nFinal Stations count: ${finalStationsRes.rows.length}`);
    for (const s of finalStationsRes.rows) {
      console.log(`  - ${s.code} (Name: ${s.name}, Active: ${s.active}, Scans: ${s.scans})`);
    }

    // Verify Users list
    const finalUsersRes = await client.query(
      `SELECT u.email, u.name, om.role, s.code as default_station, COUNT(rs.id) as recordings
       FROM users u
       JOIN organization_members om ON om.user_id = u.id AND om.organization_id = $1
       LEFT JOIN stations s ON s.id = om.default_station_id
       LEFT JOIN recording_sessions rs ON rs.operator_user_id = u.id AND rs.organization_id = om.organization_id
       GROUP BY u.email, u.name, om.role, s.code
       ORDER BY om.role ASC, u.email ASC`,
      [orgId]
    );
    console.log(`\nFinal Users count: ${finalUsersRes.rows.length}`);
    for (const u of finalUsersRes.rows) {
      console.log(`  - ${u.email} (Name: ${u.name}, Role: ${u.role}, Default Station: ${u.default_station || 'None'}, Recordings: ${u.recordings})`);
    }

    if (DRY_RUN) {
      console.log('\n[DRY RUN] Rolling back all database changes...');
      await client.query('ROLLBACK');
      console.log('[DRY RUN] Rollback complete. No changes were made.');
    } else {
      console.log('\nCommitting all database changes...');
      await client.query('COMMIT');
      console.log('COMMIT SUCCESSFUL! Migration completed successfully!');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed and rolled back:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run()
  .then(() => {
    console.log('\nScript finished.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nFatal error:', err);
    process.exit(1);
  });
