# NetComix one-time setup

NetComix is a static PWA hosted on GitHub Pages that reads your comics from a
Google Drive folder. You do this setup **once**. After that: drop `.cbz`/`.cbr`
files into the Drive folder, click **Scan** in the app, ~1 minute later they
appear in the library.

---

## 1. Create the Drive folder

1. Go to https://drive.google.com → **New → Folder**, name it (e.g.) `NetComix`.
2. Right-click → **Share** → **General access**: *Anyone with the link* → Viewer. Copy the link.
3. Open the folder. The URL is `https://drive.google.com/drive/folders/XXXXXXXX`.
   The `XXXXXXXX` part is your **Drive folder ID** — save it.

## 2. Get a Drive API key (for the PWA to read)

1. Go to https://console.cloud.google.com → create a project (e.g. `netcomix`).
2. **APIs & Services → Library** → search "Google Drive API" → **Enable**.
3. **APIs & Services → Credentials → + Create Credentials → API key**. Copy it.
4. Click the key → **API restrictions → Restrict key → Google Drive API**. Save.
5. (Optional, recommended) Under **Application restrictions** add an HTTP referrer
   restriction limited to `https://<your-github-username>.github.io/*`.

## 3. Create a service account (for the Scan action to write)

1. Same Cloud project: **IAM & Admin → Service Accounts → + Create Service Account**.
   Name: `netcomix-harvester`. Skip the optional steps, click **Done**.
2. Click the new service account → **Keys → Add Key → Create new key → JSON**.
   A JSON file downloads. **This is a secret — don't commit it.**
3. Note the service account email (looks like `netcomix-harvester@<project>.iam.gserviceaccount.com`).
4. Back in Drive, open your NetComix folder → **Share** → add that email with **Editor** access.

## 4. Add the service account JSON to GitHub

1. Go to `https://github.com/<you>/netcomix/settings/secrets/actions`
2. **New repository secret** → Name: `GOOGLE_SERVICE_ACCOUNT_JSON` → Value: paste the
   entire JSON file contents (including the curly braces). Save.
3. *(Optional)* In **Variables** → **New variable**: `DRIVE_FOLDER_ID` = your folder ID.
   (You can also pass it per-run when triggering the workflow.)

## 5. Create a GitHub Personal Access Token (for the PWA to trigger Scan)

1. https://github.com/settings/personal-access-tokens/new → **Fine-grained token**.
2. **Repository access → Only select repositories** → `netcomix`.
3. **Permissions → Repository → Actions → Read and write**.
4. Generate → copy the token.

## 6. Open NetComix and paste

1. Visit `https://<you>.github.io/netcomix/`.
2. Click the ⚙ gear → **Reconfigure setup**, or just hit any error → **Open Setup**.
3. Paste:
   - **Drive folder ID** → from step 1
   - **Drive API key** → from step 2
   - **GitHub owner** → your username
   - **GitHub repo** → `netcomix`
   - **Personal Access Token** → from step 5
4. Save.

## 7. Add a comic and scan

1. Drop a `.cbz` or `.cbr` into the Drive folder (you can nest by series-named subfolder
   if you want, the harvester walks one level deep).
2. In the app: ⚙ → **Scan now**. The page shows the live run status.
3. When it goes green, refresh — the comic is in your library.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `library.json not found in Drive folder` | Run a Scan first — the harvester creates it. |
| `Scan dispatch denied (403)` | PAT missing **Actions: Read and write** permission, or scoped to wrong repo. |
| `Scan workflow not found (404)` | `.github/workflows/scan.yml` isn't on the `main` branch of your fork. `git pull && git push` from this repo. |
| Pages don't load images (403) | Drive folder isn't shared as *Anyone with the link → Viewer*, or API key has a referrer restriction that doesn't match. |
| Workflow runs but uploads nothing | Service account email not shared on the Drive folder as **Editor**. |
| Workflow fails with "Failed to make X publicly readable" | Service account has Viewer (not Editor) on the Drive folder. |

## Things to know

- **Your library is PUBLIC.** Anyone who guesses the Drive folder ID + has an API key can read your comics. Don't put copyrighted material in a folder you've shared this way. If you need privacy, this stack isn't the right fit — switch to an OAuth-based setup.
- **Drive storage is yours.** Each issue uploads ~3–8 MB of JPEGs (pages are downscaled to max 1800px). A 100-issue library is ~500 MB. Watch your Drive quota.
- **API key is visible** in the browser's network tab. Restricting it to the Drive API + your GitHub Pages domain (step 2.5) is your only defense.
- **Concurrent scans** are blocked at the GitHub Actions level (concurrency group) so two parallel triggers won't corrupt the library.
- **Re-running a scan** is safe and cheap: already-harvested issues are skipped. Delete an issue folder in Drive to force re-harvest.
- **To stop using Drive mode**, click ⚙ → Reconfigure setup → blank out the Drive folder ID and Save. The PWA falls back to the static `public/comics/` demo.
