import os, json, sys
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

c = Credentials(
    token=None,
    refresh_token=os.environ["GOOGLE_OAUTH_REFRESH_TOKEN"],
    client_id=os.environ["GOOGLE_OAUTH_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_OAUTH_CLIENT_SECRET"],
    token_uri="https://oauth2.googleapis.com/token",
    scopes=["https://www.googleapis.com/auth/drive"],
)
s = build("drive", "v3", credentials=c)
folder = "12Sz-mb5iQvWJm5tCodTCIYMRPK9fxZiv"
print(f"=== Folder {folder} contents ===")
r = s.files().list(
    q=f"'{folder}' in parents and trashed=false",
    fields="files(id,name,mimeType,permissions(type,role))",
    pageSize=1000,
).execute()
for f in r.get("files", []):
    perms = f.get("permissions", [])
    public = any(p.get("type") == "anyone" for p in perms)
    print(f"  {'[PUB]' if public else '[PRV]'} {f['name']:60s} ({f['mimeType']}) id={f['id']}")
