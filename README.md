
# UUFRC Google Drive Backup

A script copies files shared with a church Google account (the "backup account")
into a `backup` folder in that account's own Drive. This ensures the church retains
access to files shared by members even if a member later leaves the organization,
deletes a file, or unshares it.

The script runs automatically on a nightly or weekly schedule using a Google Apps
Script time-driven trigger.

## How it works

- The backup account (`backup.uufrc@gmail.com`) is added as a viewer or editor of
  each committee's shared folder.
- On each run, the script lists everything shared with the backup account and copies
  any new or changed files into a `backup` folder inside the backup account's Drive.
- Images, videos, and audios are skipped to conserve storage.
- Files are deduped by Drive version number, so each run copies only what has changed
  since the last run.
- A record of every newly-copied file is appended to `backup.csv` in the backup
  account's Drive root.
- When the script finishes executing, it sends an email message to the email address
  that is specified in the script.

## One-time setup

These steps are performed once by the person who administers the backup account.

**Step 1 — Create an Apps Script project**

1. Sign in to Google as the **backup account** (`backup.uufrc@gmail.com`).
2. Go to [script.google.com](https://script.google.com) and click **New project**.
3. Give the project a name (e.g. `UUFRC Drive Backup`).

**Step 2 — Copy the source files into the editor**

Paste the contents of `Code.gs` and `appsscript.json` into the editor:

- Click on the default `Code.gs` file and replace its contents with the contents
  of this repository's `Code.gs`.
- Click the **Project Settings** gear → enable **"Show 'appsscript.json' manifest
  file in editor"**. A new `appsscript.json` tab will appear. Replace its contents
  with the contents of this repository's `appsscript.json`.

Alternatively, use `clasp` (see the Developer workflow section below).

**Step 3 — Enable the Advanced Drive Service**

1. In the Apps Script editor, click **Services** (the `+` icon in the left panel).
2. Find **Drive API** and click **Add**. Accept the default identifier `Drive` and
   version `v3`.
3. If appscript.json now contains two redudant entries for the Drive API, then
   remove one of them.

**Step 4 — Authorize and test**

1. Click on Code.gs in the left sidebar to view the contents of that file.
2. Click the "Save project to drive" button in the header for the editor.
3. In the editor, select `updateBackup` from the function dropdown and click **Run**.
4. Google will ask you to grant permissions (Drive access and, if you've configured
   `NOTIFICATION_EMAIL`, Mail access). Click through and approve.
5. Check the **Execution log** at the bottom of the editor for any errors.
6. Open the backup account's Drive and verify that a `backup` folder has been created
   containing copies of shared files.

> **Start with the test account.** Before running against the production backup account,
> repeat this setup under `backup.uufrc@gmail.com` (or a personal test account) and
> confirm the results look correct.

**Step 5 — Set up the time-driven trigger**

1. In the Apps Script editor, click the **Triggers** icon (clock) in the left panel.
2. Click **Add Trigger** and configure it as follows:
   - Function: `updateBackup`
   - Deployment: `Head`
   - Event source: `Time-driven`
   - Type: `Day timer`
   - Time: e.g. `10pm – 11pm`
3. Click **Save**.

The script will now run automatically every night. The Apps Script dashboard at
[script.google.com](https://script.google.com) shows past runs under **Executions**.

## Configuration

Two settings near the top of `Code.gs` can be changed without touching anything else:

| Constant | Default | Purpose |
|---|---|---|
| `NOTIFICATION_EMAIL` | `''` (disabled) | Email address to receive a summary after each run (success or error). Set to e.g. `'it.uufrc@gmail.com'` to enable. |
| `MAX_RUN_MS` | `300000` (5 min) | How long to run before stopping gracefully to avoid the Apps Script 6-minute limit. Remaining files are copied on the next run. |

The `timeZone` in `appsscript.json` controls how run times are reported in the
Apps Script dashboard. Change it to match the church's timezone if needed
(see [TZ database names](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)).

## Deploying a change

Because the script runs from source (not from a packaged binary), deploying a change
is just **saving the file**:

- **In the browser editor:** Edit `Code.gs` and press **Ctrl+S / Cmd+S**. The next
  scheduled trigger run will use the new code.
- **With `clasp`:** Edit locally, then `clasp push`. The next trigger run uses the
  pushed code.

No build step, no installer, no code signing, no deployment pipeline.

## Developer workflow

### Option A — Browser editor (easiest)

Open the project at [script.google.com](https://script.google.com) while signed in
as the backup account. You get an editor, a debugger, an execution log, and a Run
button. To test safely, make a **copy of the script** (File → Make a copy) under a
personal test account and run it there before touching the production project.

### Option B — Local editor + clasp (for git-based development)

`clasp` lets you edit locally in VS Code (or any editor) and push changes to Apps
Script from the command line.

```bash
# Install clasp globally (one-time)
npm install -g @google/clasp

# Log in (opens a browser for OAuth)
clasp login

# Clone the existing Apps Script project
# (find the Script ID under Project Settings → IDs → Script ID)
clasp clone <SCRIPT_ID>

# After editing Code.gs locally, push to Apps Script
clasp push

# Pull the latest from Apps Script into your local files
clasp pull
```

Update the `scriptId` in `.clasp.json` once you know the Script ID of the project.

To run a function from the command line (useful for quick testing):

```bash
clasp run updateBackup
```

> `clasp run` requires an additional OAuth setup step the first time; follow the
> prompts it prints.

## Viewing logs

Every run — whether triggered automatically or started manually — is recorded in the
Apps Script **Executions** panel. This is the primary way to verify that the backup
ran and to diagnose any problems.

**How to open the Executions panel**

1. Sign in to Google as the backup account.
2. Go to [script.google.com](https://script.google.com) and open the project.
3. Click the **Executions** icon in the left panel (it looks like a clock with a
   checkmark, below the Triggers icon).

**What you see**

Each row in the table is one run. The columns show:

| Column | What it means |
|---|---|
| Function | The function that ran (`updateBackup`) |
| Type | `Time-driven` for automatic trigger runs; `Editor` for manual runs |
| Start time | When the run began (in the timezone set in `appsscript.json`) |
| Duration | How long the run took |
| Status | `Completed` (green), `Failed` (red), or `Running` (blue) |

**How to read the log for a specific run**

Click anywhere on a row to expand it. The full log appears below the row, showing
every `console.log`, `console.warn`, and `console.error` message from that run, each
with a timestamp. A successful run ends with a line like:

```
Backup complete. 3 file(s) copied.
```

A run that hit the time limit ends with:

```
Approaching time limit — stopping early. Remaining files will be copied on the next run.
```

A failed run shows the error message and stack trace in red.

**Log retention**

Apps Script retains execution logs for approximately 30 days, after which they are
deleted automatically. If you need a longer-lasting record, enable `NOTIFICATION_EMAIL`
in `Code.gs` — that sends a plain-text summary to the specified address after every
run, which your email client will retain indefinitely.

## Troubleshooting

**A run failed or the trigger didn't fire**

Open the Executions panel (see above) and look for a red `Failed` row. The expanded
log shows the error. A common cause is an expired authorization — re-running
`updateBackup` manually from the editor will re-prompt for permission and fix it.

**The trigger didn't run**

Triggers sometimes fire late or skip if the script has an authorization error.
Open Executions and look for a failed run. Re-authorizing (run `updateBackup` manually
from the editor) usually fixes it.

**A file wasn't copied**

Possible reasons:
- It's an image, video, or audio (excluded by design).
- It's a shortcut (excluded by design).
- The backup account doesn't have at least Viewer access to the file.
- The file's owner has enabled "copy prevention" (Viewers can't copy). The script
  logs a warning and continues with the remaining files.

**Storage is running low**

The backup account has 15 GB of free storage (more if upgraded to Google One). Check
usage at [drive.google.com/settings/storage](https://drive.google.com/settings/storage).
The `backup.csv` file in the backup account's Drive root lists every copied file with
its size, which can help identify what's consuming space.

## Future enhancements

- **Completion email** — set `NOTIFICATION_EMAIL` in `Code.gs` to receive a summary
  after each run. The MailApp integration is already in place.
- **Record deleted/unshared files** — detect when a previously-backed-up file is no
  longer shared with the backup account and note it in `backup.csv`.
- **Opt-in media backup** — provide a way for users to tag specific images/videos for
  backup despite the general media exclusion.
