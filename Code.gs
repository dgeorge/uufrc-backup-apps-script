// ─────────────────────────────────────────────────────────────────────────────
// UUFRC Google Drive Backup
//
// Copies files shared with this Google account into a "backup" folder in the
// account's own Drive, so the church retains access even if a member later
// deletes or unshares a file.
//
// • Runs on a time-driven trigger (nightly or weekly) — see README for setup.
// • Skips already-copied files (dedup by Drive file version), so each run is
//   fast in steady state.
// • Skips images, videos, and audios to conserve storage.
// • Appends a record of every newly-copied file to backup.csv.
//
// Requires the Advanced Drive Service to be enabled in this project
// (Services → Drive API v3 → Add). See appsscript.json and README.md.
// ─────────────────────────────────────────────────────────────────────────────


// ── Configuration ─────────────────────────────────────────────────────────────

// Email address that receives a summary after each run (success or error).
// Set to '' to disable email notifications.
const NOTIFICATION_EMAIL = 'it.uufrc@gmail.com';  // e.g. 'it.uufrc@gmail.com'

// Maximum wall-clock milliseconds per run. Apps Script kills the process at
// 6 minutes (360 000 ms); stopping at 5 minutes leaves a safety margin.
// The next scheduled run picks up where this one left off — already-copied
// files are skipped, so backfill progresses steadily over successive runs.
const MAX_RUN_MS = 5 * 60 * 1000;

// Retry configuration for transient Drive API failures.
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;


// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Main entry point. Run this manually once (from the editor's Run menu) to
 * grant the required Drive and Mail permissions. After that, set up a
 * time-driven trigger so it runs on a nightly or weekly schedule:
 *
 *   Apps Script editor → Triggers (clock icon) → Add Trigger →
 *   Choose function: updateBackup → Event source: Time-driven →
 *   Type: Day timer → Time: e.g. 10pm–11pm → Save
 */
function updateBackup() {
  const startTime = Date.now();
  const records = [];

  try {
    // Find or create the top-level "backup" folder in this account's Drive root.
    const backupFolderId = findOrCreateBackupFolder();

    // List every item shared with this account (excluding media, shortcuts, trash).
    const allShared = listSharedItems();

    // Build one backup map across folders, excluding items shared with this account.
    const backupMap = fetchBackedUpMap();

    // Copy loose files shared directly (not inside a shared folder).
    const sharedFiles = allShared.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
    copyFiles(sharedFiles, backupFolderId, backupMap, records, startTime);

    // Recursively sync each shared folder into a matching subfolder of backup.
    const sharedFolders = allShared.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    for (const folder of sharedFolders) {
      if (isTimedOut(startTime)) {
        console.log('Approaching time limit — stopping early. Remaining files will be copied on the next run.');
        break;
      }
      syncFolder(folder.id, folder.name, escapePathSegment(folder.name), backupFolderId, backupMap, records, startTime);
    }

    if (records.length > 0) {
      appendToBackupCsv(records);
    }

    const summary = `Backup complete. ${records.length} file(s) copied.`;
    console.log(summary);
    if (NOTIFICATION_EMAIL) {
      MailApp.sendEmail(NOTIFICATION_EMAIL, 'UUFRC Drive Backup — success', summary);
    }

  } catch (err) {
    const msg = `Backup failed: ${err.message || err}`;
    console.error(msg);
    if (NOTIFICATION_EMAIL) {
      MailApp.sendEmail(
        NOTIFICATION_EMAIL,
        'UUFRC Drive Backup — ERROR',
        `${msg}\n\nStack:\n${err.stack || '(none)'}`
      );
    }
    throw err; // Re-throw so Apps Script marks the execution as failed.
  }
}


// ── Time-budget helper ────────────────────────────────────────────────────────

function isTimedOut(startTime) {
  return (Date.now() - startTime) >= MAX_RUN_MS;
}


// ── Retry with exponential backoff ────────────────────────────────────────────
//
// Google Drive returns transient failures under load: rate limiting (HTTP 429,
// or 403 with reason rateLimitExceeded/userRateLimitExceeded), server errors
// (5xx), and network hiccups. These succeed if retried after a short pause.
// Permanent errors (401 unauthorized, 404 not found, real 403 permission
// denials) are NOT retried — retrying them just wastes time.

function isRetryableError(err) {
  const msg = String(err.message || err);
  if (/429|Too Many Requests/i.test(msg)) return true;
  if (/5\d\d|Internal Server Error|Service Unavailable/i.test(msg)) return true;
  if (/rate limit exceeded|rateLimitExceeded|userRateLimitExceeded/i.test(msg)) return true;
  return false;
}

function withRetry(operation, label) {
  label = label || 'Drive operation';
  let attempt = 0;
  for (;;) {
    try {
      return operation();
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES || !isRetryableError(err)) {
        const contextualError = new Error(`${label} failed: ${err.message || err}`);
        if (err.stack) contextualError.stack += `\nCaused by:\n${err.stack}`;
        throw contextualError;
      }
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000);
      console.warn(`${label} failed; retry ${attempt}/${MAX_RETRIES} in ${delay}ms: ${err.message}`);
      Utilities.sleep(delay);
    }
  }
}


// ── Google Drive helpers ──────────────────────────────────────────────────────

/**
 * Returns all items shared with this account, excluding images, videos,
 * audios, shortcuts, and trashed items.
 */
function listSharedItems() {
  const items = [];
  let pageToken;
  do {
    const res = withRetry(() => Drive.Files.list({
      q: "sharedWithMe = true and mimeType != 'application/vnd.google-apps.shortcut' and not mimeType contains 'image/' and not mimeType contains 'video/' and not mimeType contains 'audio/' and trashed = false",
      fields: 'nextPageToken, files(id, name, mimeType, version, owners, size, createdTime, modifiedTime, parents)',
      pageSize: 100,
      orderBy: 'name',
      pageToken,
    }), 'list shared files in "Shared with me"');
    for (const f of (res.files || [])) items.push(f);
    pageToken = res.nextPageToken;
  } while (pageToken);

  // Suppose the folder A contains folder B, folder B contains folder C, and both A and C
  // are swhared with this user. We only want to backup the contents of folder C once, and
  // we will enounter folder C with traversing folder A. Therefore, folder C should be removed
  // from this shared-with-me list. Folder C will have a parents array because we have access
  // to C's parents, but folder A will not. Therefore, the presence of a parents array is flag
  // telling us that C is nested inside some other shared folder, so its children should not
  // be traversed.
  return items.filter(item => item.parents === undefined);
}

/**
 * Builds a map of { originalFileId → { id: backupFileId, parentId: parent of backupFileId, version: string } }
 * by reading the custom `properties` stamped on backed-up items across all
 * folders, excluding items shared with this account.
 */
function fetchBackedUpMap() {
  const map = new Map();
  let pageToken;
  do {
    const res = withRetry(() => Drive.Files.list({
      q: "trashed = false",
      fields: 'nextPageToken, files(id, parents, properties)',
      pageSize: 1000,
      pageToken,
    }), 'list files not shared with me for backup map');
    for (const f of (res.files || [])) {
      const props = f.properties;
      if (props && props.uufrc_backup_original_id) {
        map.set(props.uufrc_backup_original_id, {
          id: f.id,
          parentId: f.parents && f.parents[0],
          version: props.uufrc_backup_original_version,
        });
      }
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return map;
}

/**
 * Escapes '/' and '\' in a single folder name so it can be embedded as one
 * segment of a '/'-joined display path (see syncFolder's folderPath param)
 * without being confused with the segment separator itself. Folder names on
 * Drive may legally contain '/', so the raw name can't be joined as-is.
 *
 * Backslashes must be escaped first — otherwise the backslash introduced by
 * escaping a '/' would itself get escaped again.
 */
function escapePathSegment(name) {
  return name.replace(/\\/g, '\\\\').replace(/\//g, '\\/');
}

/**
 * Finds the "backup" folder in this account's Drive root, creating it if absent.
 */
function findOrCreateBackupFolder() {
  const res = withRetry(() => Drive.Files.list({
    q: "name = 'backup' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false",
    fields: 'files(id)',
    pageSize: 1,
  }), 'find folder "/backup"');
  if (res.files && res.files.length > 0) return res.files[0].id;
  const created = withRetry(() => Drive.Files.create(
    { name: 'backup', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    null,
    { fields: 'id' }
  ), 'create folder "/backup"');
  return created.id;
}


// ── Core backup logic ─────────────────────────────────────────────────────────

/**
 * Recursively copies a shared folder and its descendants into backupParentId.
 *
 * @param {string} sourceFolderId    Drive ID of the shared source folder.
 * @param {string} folderName        The source folder's own name (may itself
 *                                   contain '/', since Drive allows it). Used
 *                                   as-is when creating the backup folder.
 * @param {string} folderPath        Full path relative to the top-level shared
 *                                   root (e.g. "Finance" or "Finance/2024"),
 *                                   with each segment run through
 *                                   escapePathSegment() before being joined
 *                                   with '/'. Stored in backup.csv so every
 *                                   file carries its complete original path.
 *                                   A literal '/' inside a folder's own name
 *                                   is escaped as '\/', so it can't be
 *                                   confused with the segment separator.
 * @param {string} backupParentId    Drive ID of the destination parent folder.
 * @param {Map}    backupMap         Drive-wide fetchBackedUpMap() result.
 * @param {Array}  records           Accumulator for CSV rows.
 * @param {number} startTime         Date.now() at the start of this run.
 */
function syncFolder(sourceFolderId, folderName, folderPath, backupParentId, backupMap, records, startTime) {
  if (isTimedOut(startTime)) return;

  // Re-use the backup folder if one was created on a prior run.
  const existing = backupMap.get(sourceFolderId);
  let backupFolderId = existing && existing.parentId === backupParentId ? existing.id : undefined;
  if (!backupFolderId) {
    const created = withRetry(() => Drive.Files.create(
      {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [backupParentId],
        properties: { uufrc_backup_original_id: sourceFolderId },
      },
      null,
      { fields: 'id' }
    ), `create backup folder "/backup/${folderPath}"`);
    backupFolderId = created.id;
  }

  // List the source folder's children, excluding media/shortcuts/trash.
  const subfolders = [];
  const filesToCopy = [];
  let pageToken;
  do {
    const res = withRetry(() => Drive.Files.list({
      q: `'${sourceFolderId}' in parents and mimeType != 'application/vnd.google-apps.shortcut' and not mimeType contains 'image/' and not mimeType contains 'video/' and not mimeType contains 'audio/' and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, version, owners, size, createdTime, modifiedTime)',
      pageSize: 100,
      pageToken,
    }), `list shared folder contents "${folderPath}"`);
    for (const f of (res.files || [])) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        subfolders.push(f);
      } else {
        filesToCopy.push({ ...f, folderPath });
      }
    }
    pageToken = res.nextPageToken;
  } while (pageToken);

  copyFiles(filesToCopy, backupFolderId, backupMap, records, startTime);

  for (const subfolder of subfolders) {
    if (isTimedOut(startTime)) {
      console.log('Approaching time limit — stopping early. Remaining files will be copied on the next run.');
      break;
    }
    syncFolder(subfolder.id, subfolder.name, `${folderPath}/${escapePathSegment(subfolder.name)}`, backupFolderId, backupMap, records, startTime);
  }
}

/**
 * Copies files into backupParentId, skipping any whose version is unchanged.
 * Copies the new version BEFORE deleting the stale one, so a failed copy never
 * leaves the backup without any copy of the file.
 *
 * @param {Array}  files           File metadata objects from Drive.Files.list.
 * @param {string} backupParentId  Drive ID of the destination folder.
 * @param {Map}    backupMap       Drive-wide fetchBackedUpMap() result.
 * @param {Array}  records         Accumulator for CSV rows.
 * @param {number} startTime       Date.now() at the start of this run.
 */
function copyFiles(files, backupParentId, backupMap, records, startTime) {
  for (const file of files) {
    if (isTimedOut(startTime)) {
      console.log('Approaching time limit — stopping early. Remaining files will be copied on the next run.');
      return;
    }

    const existing = backupMap.get(file.id);
    if (existing && existing.version === String(file.version) && existing.parentId === backupParentId) continue;

    const filePath = (file.folderPath ? `${file.folderPath}/` : '') + escapePathSegment(file.name);

    // Copy the new version first, then remove the stale backup (if any).
    withRetry(() => Drive.Files.copy(
      {
        name: file.name,  // preserve original filename (no "Copy of" prefix)
        parents: [backupParentId],
        properties: {
          uufrc_backup_original_id: file.id,
          uufrc_backup_original_version: String(file.version),
        },
      },
      file.id,
      { fields: 'id' }
    ), `copy "${filePath}"`);

    if (existing) {
      withRetry(() => Drive.Files.remove(existing.id), `delete old copy "/backup/${filePath}"`);
    }

    const folder = file.folderPath || '';
    const ownerName = (file.owners && file.owners.length === 1) ? file.owners[0].displayName : '';
    console.log(`Copied "${file.name}"${folder ? ` from folder "${folder}"` : ''} (size: ${file.size || 'unknown'}, modified: ${file.modifiedTime || 'unknown'}, version: ${file.version || 'unknown'})`);
    records.push({
      name: file.name,
      folder,
      owner: ownerName,
      size: file.size || '',
      createdTime: file.createdTime || '',
      modifiedTime: file.modifiedTime || '',
      version: file.version || '',
      copiedTime: new Date().toISOString(),
    });
  }
}


// ── CSV manifest ──────────────────────────────────────────────────────────────

function csvEscape(value) {
  const str = String(value == null ? '' : value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Appends new rows to backup.csv in the root of this account's Drive.
 * Creates the file with a header row if it doesn't exist yet.
 */
function appendToBackupCsv(records) {
  const columns = ['name', 'folder', 'owner', 'size', 'createdTime', 'modifiedTime', 'copiedTime', 'version'];
  const newRows = records.map(r => columns.map(c => csvEscape(r[c])).join(',')).join('\n');

  const searchRes = withRetry(() => Drive.Files.list({
    q: "name = 'backup.csv' and 'root' in parents and trashed = false",
    fields: 'files(id)',
    pageSize: 1,
  }), 'find "/backup.csv"');

  const existingFile = searchRes.files && searchRes.files[0];
  if (existingFile) {
    // Read the existing content, append new rows, and update in place.
    const existingContent = withRetry(
      () => DriveApp.getFileById(existingFile.id).getBlob().getDataAsString(),
      'download "/backup.csv"'
    );
    withRetry(() => Drive.Files.update(
      {},
      existingFile.id,
      Utilities.newBlob(existingContent + '\n' + newRows, 'text/plain')
    ), 'update "/backup.csv"');
  } else {
    const headerRow = columns.join(',');
    withRetry(() => Drive.Files.create(
      { name: 'backup.csv' },
      Utilities.newBlob(headerRow + '\n' + newRows, 'text/plain'),
      { fields: 'id' }
    ), 'create "/backup.csv"');
  }
}
